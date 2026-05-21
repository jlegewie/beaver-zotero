/**
 * Whole-document extraction handler for zotero_document_request.
 *
 * This mirrors the attachment-pages acquisition flow but returns the
 * Beaver Extract result directly and caches full-document output via
 * DocumentCache.
 */

import { logger } from '../../utils/logger';
import { getPref } from '../../utils/prefs';
import { isAttachmentAvailableRemotely } from '../../utils/webAPI';
import {
    WSZoteroDocumentRequest,
    WSZoteroDocumentResponse,
} from '../agentProtocol';
import type { ZoteroDocumentErrorCode } from '../agentProtocol';
import { BeaverExtractor, ExtractionError, ExtractionErrorCode, WorkerAbortError } from '../../beaver-extract';
import { makeRemoteFilePath } from '../documentFileIdentity';
import {
    resolveToPdfAttachment,
    validateZoteroItemReference,
    loadPdfData,
    checkRemotePdfSize,
    isRemoteAccessAvailable,
    preflightCachedPdfMeta,
} from './utils';
import {
    DEFAULT_PAGES_TIMEOUT_SECONDS,
    TimeoutError,
    createTimeoutController,
} from './timeout';

function effectiveMaxFileSizeMB(requested?: number | null): number {
    const hardMax = getPref('maxFileSizeMB');
    if (requested == null || !Number.isFinite(requested) || requested <= 0) {
        return hardMax;
    }
    return Math.min(requested, hardMax);
}

/**
 * Handle zotero_document_request event.
 * Extracts the full PDF as a Beaver Extract result.
 */
export async function handleZoteroDocumentRequest(
    request: WSZoteroDocumentRequest,
): Promise<WSZoteroDocumentResponse> {
    const { attachment, mode, max_pages, max_file_size_mb, request_id, timeout_seconds } = request;
    const requestKey = `${attachment.library_id}-${attachment.zotero_key}`;
    let errorKey = requestKey;

    let resolvedPdfItem: Zotero.Item | null = null;
    let resolvedFilePath: string | null = null;
    let totalPages: number | null = null;
    let loadedPdfData: Uint8Array | null = null;

    const errorResponse = (
        error: string,
        error_code: ZoteroDocumentErrorCode,
        total_pages: number | null = null,
    ): WSZoteroDocumentResponse => ({
        type: 'zotero_document',
        request_id,
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

    const timeout = createTimeoutController(timeout_seconds, DEFAULT_PAGES_TIMEOUT_SECONDS);
    const { signal, timeoutSeconds, throwIfTimedOut, dispose } = timeout;
    const maxFileSizeMB = effectiveMaxFileSizeMB(max_file_size_mb);
    const maxPages = max_pages != null && max_pages > 0 ? max_pages : null;

    try {
        const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(
            attachment.library_id,
            attachment.zotero_key,
        );
        throwIfTimedOut('zotero_item_lookup');

        if (!zoteroItem) {
            throwIfTimedOut('not_found_response');
            return errorResponse(
                `Attachment does not exist in user's library: ${requestKey}`,
                'not_found',
            );
        }

        await zoteroItem.loadAllData();
        throwIfTimedOut('zotero_item_load');

        const resolveResult = await resolveToPdfAttachment(zoteroItem, requestKey);
        throwIfTimedOut('pdf_attachment_resolution');
        if (!resolveResult.resolved) {
            throwIfTimedOut('pdf_attachment_resolution_response');
            return errorResponse(resolveResult.error, resolveResult.error_code);
        }

        const { item: pdfItem, key: pdfKey } = resolveResult;
        errorKey = pdfKey;
        resolvedPdfItem = pdfItem;

        const rawFilePath = await pdfItem.getFilePathAsync();
        throwIfTimedOut('file_path_lookup');
        const filePath = rawFilePath || null;
        const isRemoteOnly = !filePath && isRemoteAccessAvailable(pdfItem);
        const effectiveFilePath = filePath || (isRemoteOnly ? makeRemoteFilePath(pdfItem) : null);
        resolvedFilePath = effectiveFilePath;

        if (!effectiveFilePath) {
            const onServer = isAttachmentAvailableRemotely(pdfItem);
            throwIfTimedOut('file_missing_response');
            return errorResponse(
                onServer
                    ? `The PDF file for ${pdfKey} is not available locally and remote file access is disabled in settings.`
                    : `The PDF file for ${pdfKey} is not available locally.`,
                'file_missing',
            );
        }

        if (!isRemoteOnly) {
            const fileSize = await Zotero.Attachments.getTotalFileSize(pdfItem);
            throwIfTimedOut('file_size_check');
            if (fileSize) {
                const fileSizeInMB = fileSize / 1024 / 1024;
                if (fileSizeInMB > maxFileSizeMB) {
                    throwIfTimedOut('file_too_large_response');
                    return errorResponse(
                        `The PDF file for ${pdfKey} has a file size of ${fileSizeInMB.toFixed(1)}MB, which exceeds the ${maxFileSizeMB}MB limit`,
                        'file_too_large',
                    );
                }
            }
        }

        const cache = Zotero.Beaver?.documentCache;
        if (!cache) {
            logger(`handleZoteroDocumentRequest: document cache not available for ${requestKey}`, 1);
        }
        const docRef = {
            itemId: pdfItem.id,
            libraryId: pdfItem.libraryID,
            zoteroKey: pdfItem.key,
        };
        const cachedMeta = cache ? await cache.getMetadata(docRef, effectiveFilePath).catch(() => null) : null;
        throwIfTimedOut('metadata_cache_lookup');

        const preflight = preflightCachedPdfMeta(cachedMeta, {
            checkOcr: true,
            applyPageCountCap: maxPages != null,
            maxPageCount: maxPages ?? Number.MAX_SAFE_INTEGER,
        });
        if (preflight) {
            switch (preflight.code) {
                case 'encrypted':
                    throwIfTimedOut('cached_encrypted_response');
                    return errorResponse(`The PDF file for ${pdfKey} is password-protected`, 'encrypted');
                case 'invalid_pdf':
                    throwIfTimedOut('cached_invalid_pdf_response');
                    return errorResponse(`The PDF file for ${pdfKey} is invalid or corrupted`, 'invalid_pdf');
                case 'no_text_layer':
                    throwIfTimedOut('cached_no_text_layer_response');
                    return errorResponse(
                        `The PDF file for ${pdfKey} requires OCR (no text layer)`,
                        'no_text_layer',
                        preflight.pageCount,
                    );
                case 'too_many_pages':
                    throwIfTimedOut('cached_too_many_pages_response');
                    return errorResponse(
                        `The PDF file for ${pdfKey} has ${preflight.pageCount} pages, which exceeds the ${preflight.maxPageCount}-page limit`,
                        'too_many_pages',
                        preflight.pageCount,
                    );
            }
        }

        const maxSourceSizeBytes = maxFileSizeMB * 1024 * 1024;
        const cachedResult = cache
            ? await cache.getResult(
                { libraryId: pdfItem.libraryID, zoteroKey: pdfItem.key },
                mode,
                effectiveFilePath,
                { maxSourceSizeBytes },
            ).catch(() => null)
            : null;
        throwIfTimedOut('payload_cache_lookup');
        if (cachedResult) {
            if (maxPages != null && cachedResult.document.pageCount > maxPages) {
                throwIfTimedOut('cached_result_too_many_pages_response');
                return errorResponse(
                    `The PDF file for ${pdfKey} has ${cachedResult.document.pageCount} pages, which exceeds the ${maxPages}-page limit`,
                    'too_many_pages',
                    cachedResult.document.pageCount,
                );
            }
            return {
                type: 'zotero_document',
                request_id,
                resolved_attachment: {
                    library_id: pdfItem.libraryID,
                    zotero_key: pdfItem.key,
                },
                content_type: pdfItem.attachmentContentType || cachedMeta?.contentType || 'application/pdf',
                result: cachedResult,
            };
        }

        let pdfData: Uint8Array | null = null;
        const extractor = new BeaverExtractor();

        if (cachedMeta?.pageCount != null) {
            totalPages = cachedMeta.pageCount;
        }

        if (totalPages == null) {
            try {
                pdfData = await loadPdfData(pdfItem, effectiveFilePath, isRemoteOnly);
                throwIfTimedOut('pdf_data_load_for_page_count');
            } catch (error) {
                if (!isRemoteOnly) throw error;
                logger(`handleZoteroDocumentRequest: Remote download failed: ${error}`, 1);
                throwIfTimedOut('remote_download_failed_response');
                return errorResponse(
                    `Failed to download PDF for ${pdfKey} from remote storage: ${error instanceof Error ? error.message : String(error)}`,
                    'download_failed',
                );
            }
            loadedPdfData = pdfData;
            if (isRemoteOnly) {
                const exceeded = checkRemotePdfSize(pdfData, false, maxFileSizeMB);
                if (exceeded) {
                    throwIfTimedOut('remote_file_too_large_response');
                    return errorResponse(
                        `The PDF file for ${pdfKey} has a file size of ${exceeded.sizeMB.toFixed(1)}MB, which exceeds the ${exceeded.maxMB}MB limit`,
                        'file_too_large',
                    );
                }
            }
            totalPages = await extractor.getPageCount(pdfData, signal);
            throwIfTimedOut('page_count_extraction');
        }

        if (maxPages != null && totalPages > maxPages) {
            throwIfTimedOut('too_many_pages_response');
            return errorResponse(
                `The PDF file for ${pdfKey} has ${totalPages} pages, which exceeds the ${maxPages}-page limit`,
                'too_many_pages',
                totalPages,
            );
        }

        if (totalPages === 0) {
            throwIfTimedOut('empty_document_response');
            return errorResponse(
                `The PDF file for ${pdfKey} has no readable pages (it may be empty or corrupted)`,
                'empty_document',
                0,
            );
        }

        if (!pdfData) {
            try {
                pdfData = await loadPdfData(pdfItem, effectiveFilePath, isRemoteOnly);
                throwIfTimedOut('pdf_data_load');
            } catch (error) {
                if (!isRemoteOnly) throw error;
                logger(`handleZoteroDocumentRequest: Remote download failed: ${error}`, 1);
                throwIfTimedOut('remote_download_failed_response');
                return errorResponse(
                    `Failed to download PDF for ${pdfKey} from remote storage: ${error instanceof Error ? error.message : String(error)}`,
                    'download_failed',
                );
            }
            loadedPdfData = pdfData;
            if (isRemoteOnly) {
                const exceeded = checkRemotePdfSize(pdfData, false, maxFileSizeMB);
                if (exceeded) {
                    throwIfTimedOut('remote_file_too_large_response');
                    return errorResponse(
                        `The PDF file for ${pdfKey} has a file size of ${exceeded.sizeMB.toFixed(1)}MB, which exceeds the ${exceeded.maxMB}MB limit`,
                        'file_too_large',
                    );
                }
            }
        }

        logger(
            `handleZoteroDocumentRequest: full-document extract for ${requestKey} mode=${mode}`,
            3,
        );
        const result = await extractor.extract(pdfData, { mode }, signal);
        throwIfTimedOut('pdf_extract');

        if (result.mode !== mode) {
            throwIfTimedOut('mode_mismatch_response');
            return errorResponse(
                `Extractor returned ${result.mode} result for ${mode} request`,
                'mode_mismatch',
                result.document.pageCount,
            );
        }

        throwIfTimedOut('success_response');
        const pageLabels = result.document.pageLabels ?? Object.fromEntries(
            result.document.pages
                .filter((page) => page.label)
                .map((page) => [String(page.index), page.label as string]),
        );
        await cache?.putResult({
            item: pdfItem,
            filePath: effectiveFilePath,
            mode,
            sourceSizeBytes: isRemoteOnly ? pdfData.byteLength : 0,
            contentType: pdfItem.attachmentContentType || 'application/pdf',
            result,
            metadata: {
                pageCount: result.document.pageCount,
                pageLabels,
                hasTextLayer: true,
                needsOcr: false,
                isEncrypted: false,
                isInvalid: false,
            },
        });
        return {
            type: 'zotero_document',
            request_id,
            resolved_attachment: {
                library_id: pdfItem.libraryID,
                zotero_key: pdfItem.key,
            },
            content_type: pdfItem.attachmentContentType || 'application/pdf',
            result,
        };
    } catch (error) {
        if (signal.aborted || error instanceof WorkerAbortError || error instanceof TimeoutError) {
            logger(`handleZoteroDocumentRequest: Timed out after ${timeoutSeconds}s`, 1);
            return errorResponse(
                `PDF extraction timed out after ${timeoutSeconds} seconds`,
                'timeout',
                totalPages,
            );
        }

        logger(`handleZoteroDocumentRequest: Extraction failed: ${error}`, 1);

        if (error instanceof ExtractionError) {
            if (resolvedPdfItem && resolvedFilePath && (error.code === ExtractionErrorCode.ENCRYPTED || error.code === ExtractionErrorCode.INVALID_PDF || error.code === ExtractionErrorCode.NO_TEXT_LAYER)) {
                const pageLabels = error.code === ExtractionErrorCode.NO_TEXT_LAYER
                    ? error.pageLabels ?? null
                    : null;
                await Zotero.Beaver?.documentCache?.putErrorMetadata({
                    item: resolvedPdfItem,
                    filePath: resolvedFilePath,
                    sourceSizeBytes: loadedPdfData?.byteLength ?? 0,
                    contentType: resolvedPdfItem.attachmentContentType || 'application/pdf',
                    errorState: error.code === ExtractionErrorCode.ENCRYPTED
                        ? 'encrypted'
                        : error.code === ExtractionErrorCode.INVALID_PDF
                            ? 'invalid_pdf'
                            : 'no_text_layer',
                    pageCount: error.pageCount ?? totalPages,
                    pageLabels,
                });
            }

            const totalPagesForError = error.pageCount ?? totalPages;
            switch (error.code) {
                case ExtractionErrorCode.ENCRYPTED:
                    return errorResponse(`The PDF file for ${errorKey} is password-protected`, 'encrypted');
                case ExtractionErrorCode.NO_TEXT_LAYER:
                    return errorResponse(`The PDF file for ${errorKey} requires OCR (no text layer)`, 'no_text_layer', totalPagesForError);
                case ExtractionErrorCode.INVALID_PDF:
                    return errorResponse(`The PDF file for ${errorKey} is invalid or corrupted`, 'invalid_pdf');
                case ExtractionErrorCode.EMPTY_DOCUMENT:
                    return errorResponse(
                        `The PDF file for ${errorKey} has no readable pages (it may be empty or corrupted)`,
                        'empty_document',
                        totalPagesForError,
                    );
                case ExtractionErrorCode.PAGE_OUT_OF_RANGE:
                    return errorResponse(error.message, 'page_out_of_range', totalPagesForError);
                case ExtractionErrorCode.WASM_ERROR:
                    return errorResponse(
                        `The PDF file for ${errorKey} crashes the PDF parser and cannot be processed`,
                        'pdf_parser_crash',
                        totalPagesForError,
                    );
                case ExtractionErrorCode.HEAP_EXHAUSTION:
                    return errorResponse(
                        `The PDF file for ${errorKey} is too large or complex to process and exhausted the parser's memory`,
                        'pdf_too_complex',
                        totalPagesForError,
                    );
                default:
                    return errorResponse(
                        `Failed to extract PDF content for ${errorKey}: ${error.message}`,
                        'extraction_failed',
                        totalPagesForError,
                    );
            }
        }

        return errorResponse(
            `Failed to extract PDF content for ${errorKey}: ${error instanceof Error ? error.message : String(error)}`,
            'extraction_failed',
            totalPages,
        );
    } finally {
        dispose();
    }
}
