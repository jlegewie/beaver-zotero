/**
 * Shared extraction core for whole-document PDF extraction.
 *
 * Factored out of `handleZoteroDocumentRequest` so it can be reused by the
 * background extractor (timeout-retry path) without duplicating the
 * cache-lookup / resolve / preflight / extract pipeline.
 *
 * Routing: `workerName` selects which MuPDF worker the call uses
 * (`"hot"` is the default; `"background"` is reserved for the queue
 * processor). The shared core calls `getMuPDFWorkerClient(workerName)`
 * directly for every MuPDF op — never via `BeaverExtractor`, which
 * always uses the default `"hot"` slot internally.
 */

import type {
    BeaverExtractResult,
} from '../beaver-extract/schema';
import type { PageGeometry } from '../beaver-extract/types';
import {
    ExtractionError,
    ExtractionErrorCode,
    WorkerAbortError,
    getMuPDFWorkerClient,
    type PDFWorkerSlotName,
} from '../beaver-extract';
import {
    DEFAULT_PAGES_TIMEOUT_SECONDS,
    ExternalAbortError,
    MAX_PDF_TIMEOUT_SECONDS,
    TimeoutError,
    type TimeoutControllerContext,
    awaitWithRequestAbort,
    createTimeoutController,
} from './agentDataProvider/timeout';
import type { ZoteroDocumentErrorCode } from './agentProtocol';
import type { DocumentCacheExtractionMode } from './database';
import type { DocumentCacheSourceIdentity } from './documentCache';
import { logger } from '../utils/logger';
import { effectiveMaxFileSizeMB, effectiveMaxPageCount } from './attachmentLimits';
import {
    loadAttachmentData,
    resolveAttachmentFileSource,
    resolveToReadableAttachment,
    validateZoteroItemReference,
    preflightCachedPdfMeta,
} from './documentExtraction';
import { readableToExtractKind, type ExtractContentKind } from './documentExtraction/shared/contentKinds';

export interface ResolvedAttachment {
    libraryId: number;
    zoteroKey: string;
}

export interface ExtractAndCacheArgs {
    libraryId: number;
    zoteroKey: string;
    mode: DocumentCacheExtractionMode;
    /**
     * Reject threshold for total document page count. `null` falls back to
     * Beaver's hard page-count cap. Counted in *document* pages, not requested
     * pages.
     */
    maxPages: number | null;
    maxFileSizeMB: number;
    /** Extraction deadline in seconds. */
    timeoutSeconds: number;
    /** Default `"hot"`. Background processor sets `"background"`. */
    workerName?: PDFWorkerSlotName;
    /**
     * Caller-supplied abort signal. When it fires, the in-flight
     * extraction returns `{ kind: 'external_abort' }` so the caller can
     * release the work without counting it as a failure.
     */
    externalAbortSignal?: AbortSignal;
    /**
     * Invoked once on remote-download failure (before the error is rethrown
     * internally)
     */
    onRemoteDownloadFailure?: (error: unknown) => void;
}

export interface ExtractAndCacheResolvedPdfArgs
    extends Omit<ExtractAndCacheArgs, 'libraryId' | 'zoteroKey'> {
    item: Zotero.Item;
    resolvedKey: string;
    contentType: string;
    /** Reuse the caller's timeout when item resolution and PDF extraction share one deadline. */
    timeoutContext?: TimeoutControllerContext;
}

export function buildExtractedDocumentCacheMetadata(extracted: BeaverExtractResult): {
    pageCount: number;
    pageLabels: Record<string, string>;
    pages: (PageGeometry | null)[];
} {
    const doc = extracted.document;
    const extractedPageLabels = doc.pageLabels ?? Object.fromEntries(
        doc.pages
            .filter((page) => page.label)
            .map((page) => [String(page.index), page.label as string]),
    );
    const pages: (PageGeometry | null)[] = new Array(doc.pageCount).fill(null);
    for (const page of doc.pages) {
        // Annotation cache geometry uses unrotated PDF user-space dimensions.
        // Structured-page width/height describe the extraction bbox frame.
        pages[page.index] = {
            viewBox: page.viewBox,
            width: page.viewBox[2] - page.viewBox[0],
            height: page.viewBox[3] - page.viewBox[1],
            rotation: page.rotation,
        };
    }
    return {
        pageCount: doc.pageCount,
        pageLabels: extractedPageLabels,
        pages,
    };
}

export type ExtractAndCacheResult =
    | {
          kind: 'ok';
          cached: boolean;
          result: BeaverExtractResult;
          totalPages: number;
          resolvedAttachment: ResolvedAttachment;
          contentType: string;
      }
    | {
          kind: 'cached_error';
          code: 'encrypted' | 'invalid_pdf' | 'no_text_layer';
          message: string;
          pageCount: number | null;
          resolvedAttachment: ResolvedAttachment | null;
          contentKind?: ExtractContentKind;
      }
    | {
          kind: 'response_error';
          code: ZoteroDocumentErrorCode;
          message: string;
          pageCount: number | null;
          resolvedAttachment: ResolvedAttachment | null;
          contentKind?: ExtractContentKind;
      }
    | {
          kind: 'timeout';
          phase: string;
          timeoutSeconds: number;
          pageCount: number | null;
          resolvedAttachment: ResolvedAttachment | null;
      }
    | {
          kind: 'external_abort';
          phase: string;
          pageCount: number | null;
          resolvedAttachment: ResolvedAttachment | null;
      };

export async function extractAndCacheDocument(
    args: ExtractAndCacheArgs,
): Promise<ExtractAndCacheResult> {
    const requestKey = `${args.libraryId}-${args.zoteroKey}`;

    const formatError = validateZoteroItemReference({
        library_id: args.libraryId,
        zotero_key: args.zoteroKey,
    });
    if (formatError) {
        return {
            kind: 'response_error',
            code: 'invalid_format',
            message: `Invalid attachment reference '${requestKey}': ${formatError}`,
            pageCount: null,
            resolvedAttachment: null,
        };
    }

    const timeout = createTimeoutController(
        args.timeoutSeconds,
        DEFAULT_PAGES_TIMEOUT_SECONDS,
        args.externalAbortSignal,
    );
    const { signal, timeoutSeconds, throwIfTimedOut, dispose } = timeout;

    try {
        const zoteroItem = await awaitWithRequestAbort(
            Zotero.Items.getByLibraryAndKeyAsync(args.libraryId, args.zoteroKey),
            signal,
            throwIfTimedOut,
            'zotero_item_lookup',
        );
        if (!zoteroItem) {
            return {
                kind: 'response_error',
                code: 'not_found',
                message: `Attachment does not exist in user's library: ${requestKey}`,
                pageCount: null,
                resolvedAttachment: null,
            };
        }

        await awaitWithRequestAbort(
            zoteroItem.loadAllData(),
            signal,
            throwIfTimedOut,
            'zotero_item_load',
        );

        const resolveResult = await awaitWithRequestAbort(
            resolveToReadableAttachment(zoteroItem, requestKey),
            signal,
            throwIfTimedOut,
            'readable_attachment_resolution',
        );
        if (!resolveResult.resolved) {
            const code = resolveResult.error_code === 'not_readable'
                ? 'unsupported_type'
                : resolveResult.error_code;
            return {
                kind: 'response_error',
                code,
                message: resolveResult.error,
                pageCount: null,
                resolvedAttachment: null,
            };
        }

        const { item: resolvedItem, contentKind } = resolveResult;
        const resolvedAttachment = {
            libraryId: resolvedItem.libraryID,
            zoteroKey: resolvedItem.key,
        };

        if (contentKind !== 'pdf') {
            const extractKind = readableToExtractKind(contentKind);
            return {
                kind: 'response_error',
                code: 'unsupported_type',
                message: `Attachment ${resolveResult.key} is a ${contentKind} document, but document extraction currently supports PDF only.`,
                pageCount: null,
                resolvedAttachment,
                ...(extractKind ? { contentKind: extractKind } : {}),
            };
        }

        return await extractAndCacheResolvedPdfDocument({
            ...args,
            item: resolvedItem,
            resolvedKey: resolveResult.key,
            contentType: resolveResult.contentType,
            timeoutContext: timeout,
        });
    } catch (error) {
        if (error instanceof ExternalAbortError) {
            return {
                kind: 'external_abort',
                phase: error.phase,
                pageCount: null,
                resolvedAttachment: null,
            };
        }
        if (error instanceof TimeoutError || signal.aborted) {
            return {
                kind: 'timeout',
                phase: error instanceof TimeoutError ? error.phase : 'unknown',
                timeoutSeconds,
                pageCount: null,
                resolvedAttachment: null,
            };
        }
        throw error;
    } finally {
        dispose();
    }
}

/**
 * Run the PDF extraction pipeline for an already-resolved PDF attachment.
 * Expected outcomes are returned as a tagged union for caller-side mapping.
 */
export async function extractAndCacheResolvedPdfDocument(
    args: ExtractAndCacheResolvedPdfArgs,
): Promise<ExtractAndCacheResult> {
    const {
        mode,
        externalAbortSignal,
    } = args;
    const workerName: PDFWorkerSlotName = args.workerName ?? 'hot';
    const requestKey = args.resolvedKey;

    const maxFileSizeMB = effectiveMaxFileSizeMB(args.maxFileSizeMB);
    const maxPages = effectiveMaxPageCount(args.maxPages);

    const ownsTimeout = !args.timeoutContext;
    const timeout = args.timeoutContext ?? createTimeoutController(
        args.timeoutSeconds,
        DEFAULT_PAGES_TIMEOUT_SECONDS,
        externalAbortSignal,
    );
    const { signal, timeoutSeconds, throwIfTimedOut, dispose } = timeout;

    const client = getMuPDFWorkerClient(workerName);

    let resolvedPdfItem: Zotero.Item | null = null;
    let resolvedAttachment: ResolvedAttachment | null = null;
    let resolvedFilePath: string | null = null;
    let totalPages: number | null = null;
    let loadedPdfData: Uint8Array | null = null;

    const aborted = (): ExtractAndCacheResult | null => {
        if (externalAbortSignal?.aborted) {
            return {
                kind: 'external_abort',
                phase: 'external_pre_abort',
                pageCount: totalPages,
                resolvedAttachment,
            };
        }
        return null;
    };

    try {
        const pdfItem = args.item;
        resolvedPdfItem = pdfItem;
        resolvedAttachment = {
            libraryId: pdfItem.libraryID,
            zoteroKey: pdfItem.key,
        };
        const resolvedKeyStr = args.resolvedKey;

        const source = await resolveAttachmentFileSource({
            item: pdfItem,
            maxFileSizeMB: args.maxFileSizeMB,
            localSizeStrategy: 'zotero-total',
            signal,
            throwIfTimedOut,
        });
        if (source.kind === 'error') {
            throwIfTimedOut('file_missing_response');
            if (source.code === 'file_too_large') {
                return {
                    kind: 'response_error',
                    code: 'file_too_large',
                    message: `The PDF file for ${resolvedKeyStr} has a file size of ${(source.sizeMB ?? 0).toFixed(1)}MB, which exceeds the ${source.maxMB}MB limit.`,
                    pageCount: null,
                    resolvedAttachment,
                };
            }
            return {
                kind: 'response_error',
                code: 'file_missing',
                message: source.remoteAvailable
                    ? `The PDF file for ${resolvedKeyStr} is not available locally and remote file access is disabled in settings.`
                    : `The PDF file for ${resolvedKeyStr} is not available locally.`,
                pageCount: null,
                resolvedAttachment,
            };
        }
        const effectiveFilePath = source.source.filePath;
        const isRemoteOnly = source.source.isRemoteOnly;
        resolvedFilePath = effectiveFilePath;

        const cache = Zotero.Beaver?.documentCache;
        if (!cache) {
            logger(`extractAndCacheDocument: document cache not available for ${requestKey}`, 1);
        }
        const docRef = {
            libraryId: pdfItem.libraryID,
            zoteroKey: pdfItem.key,
        };
        const initialSourceIdentity: DocumentCacheSourceIdentity | null = cache && !isRemoteOnly
            ? await cache.getSourceIdentitySnapshot(effectiveFilePath).catch((error: unknown) => {
                logger(`extractAndCacheDocument: source identity snapshot failed for ${requestKey}: ${error}`, 1);
                return null;
            })
            : null;
        const cachedMeta = cache ? await cache.getMetadata(docRef, effectiveFilePath).catch(() => null) : null;
        throwIfTimedOut('metadata_cache_lookup');

        const preflight = preflightCachedPdfMeta(cachedMeta, {
            checkOcr: true,
            applyPageCountCap: true,
            maxPageCount: maxPages,
        });
        if (preflight) {
            switch (preflight.code) {
                case 'encrypted':
                    return {
                        kind: 'cached_error',
                        code: 'encrypted',
                        message: `The PDF file for ${resolvedKeyStr} is password-protected`,
                        pageCount: preflight.pageCount ?? null,
                        resolvedAttachment,
                    };
                case 'invalid_pdf':
                    return {
                        kind: 'cached_error',
                        code: 'invalid_pdf',
                        message: `The PDF file for ${resolvedKeyStr} is invalid or corrupted`,
                        pageCount: preflight.pageCount ?? null,
                        resolvedAttachment,
                    };
                case 'no_text_layer':
                    return {
                        kind: 'cached_error',
                        code: 'no_text_layer',
                        message: `The PDF file for ${resolvedKeyStr} requires OCR (no text layer)`,
                        pageCount: preflight.pageCount,
                        resolvedAttachment,
                    };
                case 'too_many_pages':
                    return {
                        kind: 'response_error',
                        code: 'too_many_pages',
                        message: `The PDF file for ${resolvedKeyStr} has ${preflight.pageCount} pages, which exceeds the ${preflight.maxPageCount}-page limit.`,
                        pageCount: preflight.pageCount,
                        resolvedAttachment,
                    };
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
            if (cachedResult.document.pageCount > maxPages) {
                return {
                    kind: 'response_error',
                    code: 'too_many_pages',
                    message: `The PDF file for ${resolvedKeyStr} has ${cachedResult.document.pageCount} pages, which exceeds the ${maxPages}-page limit.`,
                    pageCount: cachedResult.document.pageCount,
                    resolvedAttachment,
                };
            }
            return {
                kind: 'ok',
                cached: true,
                result: cachedResult,
                totalPages: cachedResult.document.pageCount,
                resolvedAttachment,
                contentType: pdfItem.attachmentContentType || cachedMeta?.contentType || 'application/pdf',
            };
        }

        let pdfData: Uint8Array | null = null;

        if (cachedMeta?.pageCount != null) {
            totalPages = cachedMeta.pageCount;
        }

        if (totalPages == null) {
            const loaded = await loadAttachmentData({
                item: pdfItem,
                source: source.source,
                maxFileSizeMB,
                onRemoteDownloadFailure: args.onRemoteDownloadFailure,
                signal,
                throwIfTimedOut,
            });
            if (loaded.kind === 'error') {
                if (aborted()) return aborted()!;
                if (loaded.code === 'file_too_large') {
                    return {
                        kind: 'response_error',
                        code: 'file_too_large',
                        message: `The PDF file for ${resolvedKeyStr} has a file size of ${(loaded.sizeMB ?? 0).toFixed(1)}MB, which exceeds the ${loaded.maxMB}MB limit.`,
                        pageCount: null,
                        resolvedAttachment,
                    };
                }
                if (loaded.code === 'read_failed') {
                    return {
                        kind: 'response_error',
                        code: 'extraction_failed',
                        message: `Failed to read PDF file for ${resolvedKeyStr}: ${loaded.error instanceof Error ? loaded.error.message : String(loaded.error)}`,
                        pageCount: null,
                        resolvedAttachment,
                    };
                }
                logger(`extractAndCacheDocument: Remote download failed: ${loaded.error}`, 1);
                return {
                    kind: 'response_error',
                    code: 'download_failed',
                    message: `Failed to download PDF for ${resolvedKeyStr} from remote storage: ${loaded.error instanceof Error ? loaded.error.message : String(loaded.error)}`,
                    pageCount: null,
                    resolvedAttachment,
                };
            }
            pdfData = loaded.data;
            throwIfTimedOut('pdf_data_load_for_page_count');
            loadedPdfData = pdfData;
            totalPages = await client.getPageCount(pdfData, signal);
            throwIfTimedOut('page_count_extraction');
        }

        if (totalPages > maxPages) {
            return {
                kind: 'response_error',
                code: 'too_many_pages',
                message: `The PDF file for ${resolvedKeyStr} has ${totalPages} pages, which exceeds the ${maxPages}-page limit.`,
                pageCount: totalPages,
                resolvedAttachment,
            };
        }

        if (totalPages === 0) {
            return {
                kind: 'response_error',
                code: 'empty_document',
                message: `The PDF file for ${resolvedKeyStr} has no readable pages (it may be empty or corrupted)`,
                pageCount: 0,
                resolvedAttachment,
            };
        }

        if (!pdfData) {
            const loaded = await loadAttachmentData({
                item: pdfItem,
                source: source.source,
                maxFileSizeMB,
                onRemoteDownloadFailure: args.onRemoteDownloadFailure,
                signal,
                throwIfTimedOut,
            });
            if (loaded.kind === 'error') {
                if (aborted()) return aborted()!;
                if (loaded.code === 'file_too_large') {
                    return {
                        kind: 'response_error',
                        code: 'file_too_large',
                        message: `The PDF file for ${resolvedKeyStr} has a file size of ${(loaded.sizeMB ?? 0).toFixed(1)}MB, which exceeds the ${loaded.maxMB}MB limit.`,
                        pageCount: totalPages,
                        resolvedAttachment,
                    };
                }
                if (loaded.code === 'read_failed') {
                    return {
                        kind: 'response_error',
                        code: 'extraction_failed',
                        message: `Failed to read PDF file for ${resolvedKeyStr}: ${loaded.error instanceof Error ? loaded.error.message : String(loaded.error)}`,
                        pageCount: totalPages,
                        resolvedAttachment,
                    };
                }
                logger(`extractAndCacheDocument: Remote download failed: ${loaded.error}`, 1);
                return {
                    kind: 'response_error',
                    code: 'download_failed',
                    message: `Failed to download PDF for ${resolvedKeyStr} from remote storage: ${loaded.error instanceof Error ? loaded.error.message : String(loaded.error)}`,
                    pageCount: totalPages,
                    resolvedAttachment,
                };
            }
            pdfData = loaded.data;
            throwIfTimedOut('pdf_data_load');
            loadedPdfData = pdfData;
        }

        logger(
            `extractAndCacheDocument: full-document extract for ${requestKey} mode=${mode} worker=${workerName}`,
            3,
        );
        const pdfBytes = pdfData;
        if (!pdfBytes) {
            throw new Error('PDF data was not loaded before extraction');
        }
        const extractSettings = { checkTextLayer: true as const };
        const createSharedResult = async (extractSignal: AbortSignal) =>
            client.extract(pdfBytes, { mode, settings: extractSettings }, extractSignal);

        const createUnsharedResult = async () => {
            const extracted = await client.extract(
                pdfBytes,
                { mode, settings: extractSettings },
                signal,
            );
            throwIfTimedOut('pdf_extract');
            return extracted;
        };

        const resultPromise = cache
            ? cache.getOrCreateResult({
                item: pdfItem,
                filePath: effectiveFilePath,
                mode,
                sourceSizeBytes: isRemoteOnly ? pdfBytes.byteLength : 0,
                contentType: pdfItem.attachmentContentType || 'application/pdf',
                maxSourceSizeBytes,
                sharedTimeoutMs: MAX_PDF_TIMEOUT_SECONDS * 1000,
                abortSignal: signal,
                expectedSourceIdentity: isRemoteOnly ? null : initialSourceIdentity,
                create: createSharedResult,
                metadata: buildExtractedDocumentCacheMetadata,
            })
            : createUnsharedResult();
        const result = cache
            ? await awaitWithRequestAbort(resultPromise, signal, throwIfTimedOut, 'pdf_extract')
            : await resultPromise;
        throwIfTimedOut('document_result_ready');

        if (!result) {
            return {
                kind: 'response_error',
                code: 'file_too_large',
                message: `The PDF file for ${resolvedKeyStr} exceeds the ${maxFileSizeMB}MB limit.`,
                pageCount: totalPages,
                resolvedAttachment,
            };
        }

        if (result.mode !== mode) {
            return {
                kind: 'response_error',
                code: 'mode_mismatch',
                message: `Extractor returned ${result.mode} result for ${mode} request`,
                pageCount: result.document.pageCount,
                resolvedAttachment,
            };
        }

        return {
            kind: 'ok',
            cached: false,
            result,
            totalPages: result.document.pageCount,
            resolvedAttachment,
            contentType: pdfItem.attachmentContentType || 'application/pdf',
        };
    } catch (error) {
        if (error instanceof ExternalAbortError) {
            return {
                kind: 'external_abort',
                phase: error.phase,
                pageCount: totalPages,
                resolvedAttachment,
            };
        }

        if (
            externalAbortSignal?.aborted
            && (error instanceof WorkerAbortError || signal.aborted)
        ) {
            return {
                kind: 'external_abort',
                phase: 'external_abort',
                pageCount: totalPages,
                resolvedAttachment,
            };
        }

        if (signal.aborted || error instanceof WorkerAbortError || error instanceof TimeoutError) {
            logger(`extractAndCacheDocument[${workerName}]: Timed out after ${timeoutSeconds}s`, 1);
            return {
                kind: 'timeout',
                phase: error instanceof TimeoutError ? error.phase : 'unknown',
                timeoutSeconds,
                pageCount: totalPages,
                resolvedAttachment,
            };
        }

        logger(`extractAndCacheDocument[${workerName}]: Extraction failed: ${error}`, 1);
        const errorKey = resolvedAttachment
            ? `${resolvedAttachment.libraryId}-${resolvedAttachment.zoteroKey}`
            : requestKey;

        if (error instanceof ExtractionError) {
            if (
                resolvedPdfItem
                && resolvedFilePath
                && (error.code === ExtractionErrorCode.ENCRYPTED
                    || error.code === ExtractionErrorCode.INVALID_PDF
                    || error.code === ExtractionErrorCode.NO_TEXT_LAYER)
            ) {
                const pageLabels = error.code === ExtractionErrorCode.NO_TEXT_LAYER
                    ? error.pageLabels ?? null
                    : null;
                await Zotero.Beaver?.documentCache?.putErrorMetadata({
                    item: resolvedPdfItem,
                    filePath: resolvedFilePath,
                    sourceSizeBytes: loadedPdfData?.byteLength ?? 0,
                    contentType: resolvedPdfItem.attachmentContentType || 'application/pdf',
                    errorCode: error.code === ExtractionErrorCode.ENCRYPTED
                        ? 'encrypted'
                        : error.code === ExtractionErrorCode.INVALID_PDF
                            ? 'invalid_pdf'
                            : 'no_text_layer',
                    pageCount: error.pageCount ?? totalPages,
                    pageLabels,
                    pages: null,
                });

                const cachedCode = error.code === ExtractionErrorCode.ENCRYPTED
                    ? 'encrypted'
                    : error.code === ExtractionErrorCode.INVALID_PDF
                        ? 'invalid_pdf'
                        : 'no_text_layer';
                return {
                    kind: 'cached_error',
                    code: cachedCode,
                    message: cachedCode === 'encrypted'
                        ? `The PDF file for ${errorKey} is password-protected`
                        : cachedCode === 'invalid_pdf'
                            ? `The PDF file for ${errorKey} is invalid or corrupted`
                            : `The PDF file for ${errorKey} requires OCR (no text layer)`,
                    pageCount: error.pageCount ?? totalPages,
                    resolvedAttachment,
                };
            }

            const totalPagesForError = error.pageCount ?? totalPages;
            switch (error.code) {
                case ExtractionErrorCode.ENCRYPTED:
                    return {
                        kind: 'response_error',
                        code: 'encrypted',
                        message: `The PDF file for ${errorKey} is password-protected`,
                        pageCount: totalPagesForError,
                        resolvedAttachment,
                    };
                case ExtractionErrorCode.NO_TEXT_LAYER:
                    return {
                        kind: 'response_error',
                        code: 'no_text_layer',
                        message: `The PDF file for ${errorKey} requires OCR (no text layer)`,
                        pageCount: totalPagesForError,
                        resolvedAttachment,
                    };
                case ExtractionErrorCode.INVALID_PDF:
                    return {
                        kind: 'response_error',
                        code: 'invalid_pdf',
                        message: `The PDF file for ${errorKey} is invalid or corrupted`,
                        pageCount: totalPagesForError,
                        resolvedAttachment,
                    };
                case ExtractionErrorCode.EMPTY_DOCUMENT:
                    return {
                        kind: 'response_error',
                        code: 'empty_document',
                        message: `The PDF file for ${errorKey} has no readable pages (it may be empty or corrupted)`,
                        pageCount: totalPagesForError,
                        resolvedAttachment,
                    };
                case ExtractionErrorCode.PAGE_OUT_OF_RANGE:
                    return {
                        kind: 'response_error',
                        code: 'page_out_of_range',
                        message: error.message,
                        pageCount: totalPagesForError,
                        resolvedAttachment,
                    };
                case ExtractionErrorCode.WASM_ERROR:
                    return {
                        kind: 'response_error',
                        code: 'pdf_parser_crash',
                        message: `The PDF file for ${errorKey} crashes the PDF parser and cannot be processed`,
                        pageCount: totalPagesForError,
                        resolvedAttachment,
                    };
                case ExtractionErrorCode.HEAP_EXHAUSTION:
                    return {
                        kind: 'response_error',
                        code: 'pdf_too_complex',
                        message: `The PDF file for ${errorKey} is too large or complex to process and exhausted the parser's memory`,
                        pageCount: totalPagesForError,
                        resolvedAttachment,
                    };
                default:
                    return {
                        kind: 'response_error',
                        code: 'extraction_failed',
                        message: `Failed to extract PDF content for ${errorKey}: ${error.message}`,
                        pageCount: totalPagesForError,
                        resolvedAttachment,
                    };
            }
        }

        // Unexpected/native JS error (not an ExtractionError)
        const native = error instanceof Error ? error : undefined;
        const rawMessage = native ? native.message : String(error);
        const responseDetail = [
            native ? `${native.name}: ${native.message}` : rawMessage,
            `(mode=${mode}, worker=${workerName}, pages=${totalPages ?? 'unknown'})`,
        ]
            .filter(Boolean)
            .join('\n');
        const diagnosticDetail = [
            responseDetail,
            native?.stack
                ? native.stack.split('\n').slice(0, 6).join('\n')
                : undefined,
        ]
            .filter(Boolean)
            .join('\n');
        logger(
            `extractAndCacheDocument[${workerName}]: Unexpected extraction failure for ${errorKey}\n${diagnosticDetail}`,
            1,
        );

        // Classify a JS stack overflow so it is greppable/alertable instead of
        // hiding in the generic `extraction_failed` bucket
        const isStackOverflow =
            /too much recursion|maximum call stack|call stack size exceeded/i.test(
                rawMessage,
            );

        return {
            kind: 'response_error',
            code: isStackOverflow ? 'recursion_limit' : 'extraction_failed',
            message: `Failed to extract PDF content for ${errorKey}: ${responseDetail}`,
            pageCount: totalPages,
            resolvedAttachment,
        };
    } finally {
        if (ownsTimeout) {
            dispose();
        }
    }
}
