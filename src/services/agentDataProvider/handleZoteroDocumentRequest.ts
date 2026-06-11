/**
 * Whole-document extraction handler for zotero_document_request.
 *
 * Resolves the request to a readable attachment, then dispatches by content
 * kind. Plain text is read directly (no document cache). PDFs and EPUBs use
 * shared extraction helpers. On a hot-path PDF timeout it enqueues a
 * `document_timeout_retry` background job; EPUB timeouts are returned directly.
 */

import { logger } from '../../utils/logger';
import { gzipString } from '../../utils/gzip';
import {
    WSZoteroDocumentRequest,
    WSZoteroDocumentResponse,
} from '../agentProtocol';
import type { ZoteroDocumentErrorCode } from '../agentProtocol';
import {
    LEGACY_MAX_JSON_BYTES,
    SMALL_PAYLOAD_THRESHOLD_BYTES,
    WSBinaryEnvelope,
    gzipDecompressedSize,
} from '../wsBinaryEnvelope';
import {
    extractAndCacheEpubDocument,
    extractAndCacheResolvedPdfDocument,
} from '../documentExtractionCore';
import {
    extractTextDocument,
    loadAttachmentData,
    resolveToReadableAttachment,
    resolveAttachmentFileSource,
    validateZoteroItemReference,
} from '../documentExtraction';
import { readableToExtractKind, type ExtractContentKind } from '../documentExtraction/shared/contentKinds';
import {
    DEFAULT_PAGES_TIMEOUT_SECONDS,
    MAX_PDF_TIMEOUT_SECONDS,
    TimeoutError,
    awaitWithRequestAbort,
    createTimeoutController,
} from './timeout';
// Hot-path handler keeps the remote-download-failed popup behavior by
// passing the popup notifier through `onRemoteDownloadFailure`. The
// background extractor deliberately omits it.
import { notifyRemoteDownloadFailure, notifyRemoteFileNotSynced } from './utils';

/**
 * Finalize a successful document response for the wire.
 *
 * When the backend negotiated gzip (`accept_encoding`), large results are
 * returned as a binary envelope whose payload reuses the gzipped blob the
 * document cache read or wrote for this result (no recompression); small
 * results stay JSON. Against legacy backends the serialized size is guarded
 * so an oversized text frame returns a clean `document_too_large` error
 * instead of tripping the server's WebSocket frame limit and killing the
 * connection (the failure mode behind CloseCode 1009/1006 drops).
 *
 * `cacheSourceResult` is the exact object the document cache returned/stored
 * (for PDFs, `response.result` is a spread copy of it), used to look up the
 * raw gz bytes via `takeGzipPayload`.
 *
 * Exported for tests.
 */
export function finalizeSuccessResponse(opts: {
    request: WSZoteroDocumentRequest;
    response: WSZoteroDocumentResponse;
    cacheSourceResult: object;
    totalPages: number | null;
    contentKind: ExtractContentKind;
    errorResponse: (
        error: string,
        error_code: ZoteroDocumentErrorCode,
        total_pages?: number | null,
        content_kind?: ExtractContentKind,
    ) => WSZoteroDocumentResponse;
}): WSZoteroDocumentResponse | WSBinaryEnvelope {
    const { request, response, cacheSourceResult, totalPages, contentKind, errorResponse } = opts;
    const gzipOk = request.accept_encoding?.includes('gzip') ?? false;

    const documentCache = Zotero.Beaver?.documentCache;
    let gz = typeof documentCache?.takeGzipPayload === 'function'
        ? documentCache.takeGzipPayload(cacheSourceResult)
        : undefined;
    if (!gz) {
        // No cached blob (text files, cache disabled, shared-extraction
        // second waiter). Small results skip compression entirely; the
        // stringify below is no extra cost — send() serializes JSON anyway.
        const json = JSON.stringify(response.result);
        if (json.length < SMALL_PAYLOAD_THRESHOLD_BYTES) {
            return response;
        }
        gz = gzipString(json);
    }

    const decompressedBytes = gzipDecompressedSize(gz);
    const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
    const tooLargeError = () => errorResponse(
        `The extracted content of this attachment is too large to transfer ` +
        `(${mb(decompressedBytes)}MB of extracted text` +
        `${totalPages != null ? ` across ${totalPages} pages` : ''}). ` +
        `Do not try again with extract or read_pages for this attachment.`,
        'document_too_large',
        totalPages,
        contentKind,
    );

    if (gzipOk) {
        if (request.max_payload_bytes != null && gz.byteLength > request.max_payload_bytes) {
            return tooLargeError();
        }
        if (request.max_decompressed_bytes != null && decompressedBytes > request.max_decompressed_bytes) {
            return tooLargeError();
        }
        if (decompressedBytes < SMALL_PAYLOAD_THRESHOLD_BYTES) {
            return response;
        }
        const { result: _result, ...header } = response;
        return { kind: 'ws_binary_envelope', header, payload: gz };
    }

    // Legacy backend (no accept_encoding): JSON only. Guard the serialized
    // size against the deployed server frame limit.
    if (decompressedBytes > LEGACY_MAX_JSON_BYTES) {
        return tooLargeError();
    }
    return response;
}

/**
 * Handle zotero_document_request event.
 */
export async function handleZoteroDocumentRequest(
    request: WSZoteroDocumentRequest,
): Promise<WSZoteroDocumentResponse | WSBinaryEnvelope> {
    const { attachment, mode, max_pages, max_file_size_mb, request_id, timeout_seconds } = request;
    const requestKey = `${attachment.library_id}-${attachment.zotero_key}`;

    const errorResponse = (
        error: string,
        error_code: ZoteroDocumentErrorCode,
        total_pages: number | null = null,
        content_kind?: ExtractContentKind,
    ): WSZoteroDocumentResponse => ({
        type: 'zotero_document',
        request_id,
        ...(content_kind ? { content_kind } : {}),
        total_pages,
        error,
        error_code,
    });

    const formatError = validateZoteroItemReference(attachment);
    if (formatError) {
        return errorResponse(
            `Invalid attachment reference '${requestKey}': ${formatError}`,
            'invalid_format',
        );
    }

    const timeout = createTimeoutController(
        timeout_seconds,
        DEFAULT_PAGES_TIMEOUT_SECONDS,
    );
    const withRequestDeadline = async <T>(promise: Promise<T>, phase: string): Promise<T> =>
        awaitWithRequestAbort(
            promise,
            timeout.signal,
            timeout.throwIfTimedOut,
            phase,
        );
    let timeoutContentKind: ExtractContentKind | undefined;

    try {
        const item = await withRequestDeadline(
            Zotero.Items.getByLibraryAndKeyAsync(
                attachment.library_id,
                attachment.zotero_key,
            ),
            'zotero_item_lookup',
        );
        if (!item) {
            return errorResponse(
                `Attachment does not exist in user's library: ${requestKey}`,
                'not_found',
            );
        }

        await withRequestDeadline(item.loadAllData(), 'zotero_item_load');

        const resolved = await withRequestDeadline(
            resolveToReadableAttachment(item, requestKey),
            'readable_attachment_resolution',
        );
        if (!resolved.resolved) {
            const code = resolved.error_code === 'not_readable'
                ? 'unsupported_type'
                : resolved.error_code;
            return errorResponse(resolved.error, code);
        }

        const { item: resolvedItem, key: resolvedKey, contentKind, contentType } = resolved;
        timeoutContentKind = readableToExtractKind(contentKind);

        if (contentKind === 'text') {
            const source = await resolveAttachmentFileSource({
                item: resolvedItem,
                maxFileSizeMB: max_file_size_mb ?? 0,
                localSizeStrategy: 'stat',
                signal: timeout.signal,
                throwIfTimedOut: timeout.throwIfTimedOut,
            });
            if (source.kind === 'error') {
                if (source.code === 'file_missing') {
                    const detail = source.remoteAvailable
                        ? 'The file is available remotely, but remote file access is disabled.'
                        : 'The file is not available locally.';
                    return errorResponse(
                        `Attachment ${resolvedKey} file is missing. ${detail}`,
                        'file_missing',
                        null,
                        'text',
                    );
                }
                return errorResponse(
                    `Attachment ${resolvedKey} file is too large (${(source.sizeMB ?? 0).toFixed(1)}MB > ${source.maxMB}MB).`,
                    'file_too_large',
                    null,
                    'text',
                );
            }

            const data = await loadAttachmentData({
                item: resolvedItem,
                source: source.source,
                maxFileSizeMB: max_file_size_mb ?? 0,
                onRemoteDownloadFailure: notifyRemoteDownloadFailure,
                signal: timeout.signal,
                throwIfTimedOut: timeout.throwIfTimedOut,
            });
            if (data.kind === 'error') {
                if (data.code === 'file_too_large') {
                    return errorResponse(
                        `Attachment ${resolvedKey} file is too large (${(data.sizeMB ?? 0).toFixed(1)}MB > ${data.maxMB}MB).`,
                        'file_too_large',
                        null,
                        'text',
                    );
                }
                if (data.code === 'download_failed') {
                    return errorResponse(
                        `Failed to download attachment ${resolvedKey} from remote storage.`,
                        'download_failed',
                        null,
                        'text',
                    );
                }
                return errorResponse(
                    `Failed to read text attachment ${resolvedKey}.`,
                    'extraction_failed',
                    null,
                    'text',
                );
            }

            const result = extractTextDocument({
                data: data.data,
                contentType,
            });

            return finalizeSuccessResponse({
                request,
                response: {
                    type: 'zotero_document',
                    request_id,
                    resolved_attachment: {
                        library_id: resolvedItem.libraryID,
                        zotero_key: resolvedItem.key,
                    },
                    content_type: contentType,
                    content_kind: 'text',
                    result,
                },
                cacheSourceResult: result,
                totalPages: null,
                contentKind: 'text',
                errorResponse,
            });
        }

        if (contentKind === 'epub') {
            const result = await withRequestDeadline(
                extractAndCacheEpubDocument({
                    item: resolvedItem,
                    resolvedKey,
                    contentType,
                    maxFileSizeMB: max_file_size_mb ?? 0,
                    externalAbortSignal: timeout.signal,
                    onFileNotSyncedLocally: notifyRemoteFileNotSynced,
                }),
                'epub_extraction',
            );

            if (result.kind === 'ok') {
                if (result.cached) {
                    const { libraryId, zoteroKey } = result.resolvedAttachment;
                    logger(`handleZoteroDocumentRequest: document cache hit for ${libraryId}-${zoteroKey} content_kind=epub`, 3);
                }
                return finalizeSuccessResponse({
                    request,
                    response: {
                        type: 'zotero_document',
                        request_id,
                        resolved_attachment: {
                            library_id: result.resolvedAttachment.libraryId,
                            zotero_key: result.resolvedAttachment.zoteroKey,
                        },
                        content_type: result.contentType,
                        content_kind: 'epub',
                        result: result.document,
                    },
                    cacheSourceResult: result.document,
                    totalPages: null,
                    contentKind: 'epub',
                    errorResponse,
                });
            }

            return errorResponse(result.message, result.code, null, 'epub');
        }

        if (contentKind !== 'pdf') {
            const extractKind = readableToExtractKind(contentKind);
            return errorResponse(
                `Attachment ${resolvedKey} is a ${contentKind} document, but document extraction currently supports PDF, EPUB, and plain text only.`,
                'unsupported_type',
                null,
                extractKind,
            );
        }

        const result = await extractAndCacheResolvedPdfDocument({
            item: resolvedItem,
            resolvedKey,
            contentType,
            mode,
            maxPages: max_pages ?? null,
            maxFileSizeMB: max_file_size_mb ?? 0,
            timeoutSeconds: timeout_seconds ?? 0,
            workerName: 'hot',
            externalAbortSignal: timeout.signal,
            onRemoteDownloadFailure: notifyRemoteDownloadFailure,
        });

        if (result.kind === 'ok') {
            if (result.cached) {
                const { libraryId, zoteroKey } = result.resolvedAttachment;
                logger(`handleZoteroDocumentRequest: document cache hit for ${libraryId}-${zoteroKey} mode=${mode}`, 3);
            }
            return finalizeSuccessResponse({
                request,
                response: {
                    type: 'zotero_document',
                    request_id,
                    resolved_attachment: {
                        library_id: result.resolvedAttachment.libraryId,
                        zotero_key: result.resolvedAttachment.zoteroKey,
                    },
                    content_type: result.contentType,
                    content_kind: 'pdf',
                    result: { ...result.result, content_kind: 'pdf' as const },
                },
                // The cache keyed the gz blob by the original result object;
                // the response carries a spread copy with content_kind added
                // (the backend re-injects it from the envelope header).
                cacheSourceResult: result.result,
                totalPages: result.totalPages ?? null,
                contentKind: 'pdf',
                errorResponse,
            });
        }

        if (result.kind === 'timeout' || (result.kind === 'external_abort' && timeout.signal.aborted)) {
            const target = result.resolvedAttachment ?? {
                libraryId: attachment.library_id,
                zoteroKey: attachment.zotero_key,
            };
            try {
                await Zotero.Beaver?.db?.enqueueBackgroundJob({
                    jobType: 'document_timeout_retry',
                    libraryId: target.libraryId,
                    zoteroKey: target.zoteroKey,
                    contentKind: 'pdf',
                    payloadKind: mode,
                    priority: 50,
                    payload: {
                        content_kind: 'pdf',
                        maxPages: max_pages ?? null,
                        maxFileSizeMB: max_file_size_mb ?? 0,
                        timeoutSeconds: MAX_PDF_TIMEOUT_SECONDS,
                    },
                    now: Date.now(),
                });
                Zotero.Beaver?.backgroundExtractor?.notify();
            } catch (e) {
                logger(`handleZoteroDocumentRequest: background enqueue failed: ${e}`, 1);
            }
            return errorResponse(
                `PDF extraction timed out after ${
                    result.kind === 'timeout' ? result.timeoutSeconds : timeout.timeoutSeconds
                } seconds`,
                'timeout',
                result.pageCount,
                'pdf',
            );
        }

        if (result.kind === 'external_abort') {
            return errorResponse(
                `PDF extraction interrupted`,
                'timeout',
                result.pageCount,
                result.resolvedAttachment ? 'pdf' : undefined,
            );
        }

        const contentKindOnError = result.contentKind
            ?? (result.resolvedAttachment && result.code !== 'unsupported_type' ? 'pdf' : undefined);
        return errorResponse(result.message, result.code, result.pageCount, contentKindOnError);
    } catch (error) {
        if (error instanceof TimeoutError) {
            return errorResponse(
                `Document request timed out after ${error.timeoutSeconds} seconds`,
                'timeout',
                null,
                timeoutContentKind,
            );
        }
        throw error;
    } finally {
        timeout.dispose();
    }
}
