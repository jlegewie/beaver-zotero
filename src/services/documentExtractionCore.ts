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
    awaitWithRequestAbort,
    createTimeoutController,
} from './agentDataProvider/timeout';
import type { ZoteroDocumentErrorCode } from './agentProtocol';
import type { DocumentCacheExtractionMode } from './database';
import type { DocumentCacheSourceIdentity } from './documentCache';
import { makeRemoteFilePath } from './documentFileIdentity';
import { logger } from '../utils/logger';
import { getPref } from '../utils/prefs';
import { isAttachmentAvailableRemotely } from '../utils/webAPI';
import {
    resolveToPdfAttachment,
    validateZoteroItemReference,
    loadPdfData,
    checkRemotePdfSize,
    isRemoteAccessAvailable,
    preflightCachedPdfMeta,
} from './documentExtraction';

export interface ResolvedAttachment {
    libraryId: number;
    zoteroKey: string;
}

export interface ExtractAndCacheArgs {
    libraryId: number;
    zoteroKey: string;
    mode: DocumentCacheExtractionMode;
    /**
     * Reject threshold for total document page count. `null` disables the
     * cap. Counted in *document* pages, not requested pages.
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
      }
    | {
          kind: 'response_error';
          code: ZoteroDocumentErrorCode;
          message: string;
          pageCount: number | null;
          resolvedAttachment: ResolvedAttachment | null;
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

function effectiveMaxFileSizeMB(requested?: number | null): number {
    const hardMax = getPref('maxFileSizeMB');
    if (requested == null || !Number.isFinite(requested) || requested <= 0) {
        return hardMax;
    }
    return Math.min(requested, hardMax);
}

/**
 * Run the whole-document extraction pipeline, populate the document cache,
 * and return a tagged-union result. Never throws for expected outcomes —
 * callers branch on `result.kind`.
 */
export async function extractAndCacheDocument(
    args: ExtractAndCacheArgs,
): Promise<ExtractAndCacheResult> {
    const {
        libraryId,
        zoteroKey,
        mode,
        externalAbortSignal,
    } = args;
    const workerName: PDFWorkerSlotName = args.workerName ?? 'hot';
    const requestKey = `${libraryId}-${zoteroKey}`;

    const formatError = validateZoteroItemReference({
        library_id: libraryId,
        zotero_key: zoteroKey,
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

    const maxFileSizeMB = effectiveMaxFileSizeMB(args.maxFileSizeMB);
    const maxPages = args.maxPages != null && args.maxPages > 0 ? args.maxPages : null;

    const timeout = createTimeoutController(
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
        const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(
            libraryId,
            zoteroKey,
        );
        throwIfTimedOut('zotero_item_lookup');

        if (!zoteroItem) {
            throwIfTimedOut('not_found_response');
            return {
                kind: 'response_error',
                code: 'not_found',
                message: `Attachment does not exist in user's library: ${requestKey}`,
                pageCount: null,
                resolvedAttachment: null,
            };
        }

        await zoteroItem.loadAllData();
        throwIfTimedOut('zotero_item_load');

        const resolveResult = await resolveToPdfAttachment(zoteroItem, requestKey);
        throwIfTimedOut('pdf_attachment_resolution');
        if (!resolveResult.resolved) {
            return {
                kind: 'response_error',
                code: resolveResult.error_code,
                message: resolveResult.error,
                pageCount: null,
                resolvedAttachment: null,
            };
        }

        const { item: pdfItem } = resolveResult;
        resolvedPdfItem = pdfItem;
        resolvedAttachment = {
            libraryId: pdfItem.libraryID,
            zoteroKey: pdfItem.key,
        };
        const resolvedKeyStr = `${pdfItem.libraryID}-${pdfItem.key}`;

        const rawFilePath = await pdfItem.getFilePathAsync();
        throwIfTimedOut('file_path_lookup');
        const filePath = rawFilePath || null;
        const isRemoteOnly = !filePath && isRemoteAccessAvailable(pdfItem);
        const effectiveFilePath = filePath || (isRemoteOnly ? makeRemoteFilePath(pdfItem) : null);
        resolvedFilePath = effectiveFilePath;

        if (!effectiveFilePath) {
            const onServer = isAttachmentAvailableRemotely(pdfItem);
            throwIfTimedOut('file_missing_response');
            return {
                kind: 'response_error',
                code: 'file_missing',
                message: onServer
                    ? `The PDF file for ${resolvedKeyStr} is not available locally and remote file access is disabled in settings.`
                    : `The PDF file for ${resolvedKeyStr} is not available locally.`,
                pageCount: null,
                resolvedAttachment,
            };
        }

        if (!isRemoteOnly) {
            const fileSize = await Zotero.Attachments.getTotalFileSize(pdfItem);
            throwIfTimedOut('file_size_check');
            if (fileSize) {
                const fileSizeInMB = fileSize / 1024 / 1024;
                if (fileSizeInMB > maxFileSizeMB) {
                    return {
                        kind: 'response_error',
                        code: 'file_too_large',
                        message: `The PDF file for ${resolvedKeyStr} has a file size of ${fileSizeInMB.toFixed(1)}MB, which exceeds the ${maxFileSizeMB}MB limit`,
                        pageCount: null,
                        resolvedAttachment,
                    };
                }
            }
        }

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
            applyPageCountCap: maxPages != null,
            maxPageCount: maxPages ?? Number.MAX_SAFE_INTEGER,
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
                        message: `The PDF file for ${resolvedKeyStr} has ${preflight.pageCount} pages, which exceeds the ${preflight.maxPageCount}-page limit`,
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
            if (maxPages != null && cachedResult.document.pageCount > maxPages) {
                return {
                    kind: 'response_error',
                    code: 'too_many_pages',
                    message: `The PDF file for ${resolvedKeyStr} has ${cachedResult.document.pageCount} pages, which exceeds the ${maxPages}-page limit`,
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
            try {
                pdfData = await loadPdfData(pdfItem, effectiveFilePath, isRemoteOnly, args.onRemoteDownloadFailure);
                throwIfTimedOut('pdf_data_load_for_page_count');
            } catch (error) {
                if (aborted()) return aborted()!;
                if (!isRemoteOnly) throw error;
                logger(`extractAndCacheDocument: Remote download failed: ${error}`, 1);
                return {
                    kind: 'response_error',
                    code: 'download_failed',
                    message: `Failed to download PDF for ${resolvedKeyStr} from remote storage: ${error instanceof Error ? error.message : String(error)}`,
                    pageCount: null,
                    resolvedAttachment,
                };
            }
            loadedPdfData = pdfData;
            if (isRemoteOnly) {
                const exceeded = checkRemotePdfSize(pdfData, false, maxFileSizeMB);
                if (exceeded) {
                    return {
                        kind: 'response_error',
                        code: 'file_too_large',
                        message: `The PDF file for ${resolvedKeyStr} has a file size of ${exceeded.sizeMB.toFixed(1)}MB, which exceeds the ${exceeded.maxMB}MB limit`,
                        pageCount: null,
                        resolvedAttachment,
                    };
                }
            }
            totalPages = await client.getPageCount(pdfData, signal);
            throwIfTimedOut('page_count_extraction');
        }

        if (maxPages != null && totalPages > maxPages) {
            return {
                kind: 'response_error',
                code: 'too_many_pages',
                message: `The PDF file for ${resolvedKeyStr} has ${totalPages} pages, which exceeds the ${maxPages}-page limit`,
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
            try {
                pdfData = await loadPdfData(pdfItem, effectiveFilePath, isRemoteOnly, args.onRemoteDownloadFailure);
                throwIfTimedOut('pdf_data_load');
            } catch (error) {
                if (aborted()) return aborted()!;
                if (!isRemoteOnly) throw error;
                logger(`extractAndCacheDocument: Remote download failed: ${error}`, 1);
                return {
                    kind: 'response_error',
                    code: 'download_failed',
                    message: `Failed to download PDF for ${resolvedKeyStr} from remote storage: ${error instanceof Error ? error.message : String(error)}`,
                    pageCount: totalPages,
                    resolvedAttachment,
                };
            }
            loadedPdfData = pdfData;
            if (isRemoteOnly) {
                const exceeded = checkRemotePdfSize(pdfData, false, maxFileSizeMB);
                if (exceeded) {
                    return {
                        kind: 'response_error',
                        code: 'file_too_large',
                        message: `The PDF file for ${resolvedKeyStr} has a file size of ${exceeded.sizeMB.toFixed(1)}MB, which exceeds the ${exceeded.maxMB}MB limit`,
                        pageCount: totalPages,
                        resolvedAttachment,
                    };
                }
            }
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
                message: `The PDF file for ${resolvedKeyStr} exceeds the ${maxFileSizeMB}MB limit`,
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

        return {
            kind: 'response_error',
            code: 'extraction_failed',
            message: `Failed to extract PDF content for ${errorKey}: ${error instanceof Error ? error.message : String(error)}`,
            pageCount: totalPages,
            resolvedAttachment,
        };
    } finally {
        dispose();
    }
}
