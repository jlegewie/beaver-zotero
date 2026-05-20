/**
 * Agent Data Provider
 * 
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 * 
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */

import { logger } from '../../utils/logger';
import { getPref } from '../../utils/prefs';

import { isAttachmentAvailableRemotely } from '../../utils/webAPI';  // kept for file_missing message check
import {
    WSZoteroAttachmentPagesRequest,
    WSZoteroAttachmentPagesResponse,
    AttachmentPagesErrorCode,
    WSPageContent,
} from '../agentProtocol';
import { BeaverExtractor, ExtractionError, ExtractionErrorCode, WorkerAbortError } from '../../beaver-extract';
import { makeRemoteFilePath } from '../attachmentFileCache';
import type { CachedPageContent } from '../attachmentFileCache';
import {
    resolveToPdfAttachment,
    validateZoteroItemReference,
    backfillMetadataForError,
    loadPdfData,
    checkRemotePdfSize,
    isRemoteAccessAvailable,
    preflightCachedPdfMeta,
    persistMetadataToCache,
} from './utils';
import { ensurePageLabelsForResolution, resolvePageValue, InvalidPageValueError } from './pageLabelResolution';
import {
    DEFAULT_PAGES_TIMEOUT_SECONDS,
    TimeoutError,
    createTimeoutController,
} from './timeout';
import {
    markdownDocumentToCachedPages,
    markdownDocumentToWSPageContent,
} from './markdownAdapter';
import type { MarkdownDocument } from '../../beaver-extract/schema';


/**
 * Handle zotero_attachment_pages_request event.
 * Extracts text content from PDF attachment pages using the PDF extraction service.
 */
export async function handleZoteroAttachmentPagesRequest(
    request: WSZoteroAttachmentPagesRequest
): Promise<WSZoteroAttachmentPagesResponse> {
    const { attachment, start_page, end_page, skip_local_limits, prefer_page_labels, max_pages, request_id, timeout_seconds } = request;
    const requestKey = `${attachment.library_id}-${attachment.zotero_key}`;
    let errorKey = requestKey;

    // Hoisted so the catch block can access the resolved PDF identity
    // for error-state metadata backfill (after auto-resolution).
    let resolvedPdfItem: Zotero.Item | null = null;
    let resolvedFilePath: string | null = null;
    let totalPages: number | null = null;

    // Helper to create error response
    const errorResponse = (
        error: string,
        error_code: AttachmentPagesErrorCode,
        total_pages: number | null = null
    ): WSZoteroAttachmentPagesResponse => ({
        type: 'zotero_attachment_pages',
        request_id,
        attachment,
        pages: [],
        total_pages,
        error,
        error_code,
    });

    // 0. Validate attachment reference format
    const formatError = validateZoteroItemReference(attachment);
    if (formatError) {
        return errorResponse(
            `Invalid attachment reference '${requestKey}': ${formatError}`,
            'invalid_format'
        );
    }

    const timeout = createTimeoutController(timeout_seconds, DEFAULT_PAGES_TIMEOUT_SECONDS);
    const { signal, timeoutSeconds, throwIfTimedOut, dispose } = timeout;

    try {
        // 1. Get the attachment item from Zotero
        const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(
            attachment.library_id,
            attachment.zotero_key
        );
        throwIfTimedOut('zotero_item_lookup');

        if (!zoteroItem) {
            throwIfTimedOut('not_found_response');
            return errorResponse(
                `Attachment does not exist in user's library: ${requestKey}`,
                'not_found'
            );
        }

        // Load all data for the item
        await zoteroItem.loadAllData();
        throwIfTimedOut('zotero_item_load');

        // 2. Resolve to a PDF attachment (auto-resolves regular items with one PDF)
        const resolveResult = await resolveToPdfAttachment(zoteroItem, requestKey);
        throwIfTimedOut('pdf_attachment_resolution');
        if (!resolveResult.resolved) {
            throwIfTimedOut('pdf_attachment_resolution_response');
            return errorResponse(resolveResult.error, resolveResult.error_code);
        }
        const { item: pdfItem, key: pdfKey } = resolveResult;
        errorKey = pdfKey;
        resolvedPdfItem = pdfItem;

        // 3. Get the file path — returns false if missing or nonexistent
        const rawFilePath = await pdfItem.getFilePathAsync();
        throwIfTimedOut('file_path_lookup');
        const filePath = rawFilePath || null;  // normalize false → null
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
                'file_missing'
            );
        }

        // 4. Check file size limit (skip if skip_local_limits is true; skip for remote — checked after download)
        if (!skip_local_limits && !isRemoteOnly) {
            const maxFileSizeMB = getPref('maxFileSizeMB');
            const fileSize = await Zotero.Attachments.getTotalFileSize(pdfItem);
            throwIfTimedOut('file_size_check');

            if (fileSize) {
                const fileSizeInMB = fileSize / 1024 / 1024;
                if (fileSizeInMB > maxFileSizeMB) {
                    throwIfTimedOut('file_too_large_response');
                    return errorResponse(
                        `The PDF file for ${pdfKey} has a file size of ${fileSizeInMB.toFixed(1)}MB, which exceeds the ${maxFileSizeMB}MB limit`,
                        'file_too_large'
                    );
                }
            }
        }

        // 4b. Try metadata cache for fast prechecks
        const cache = Zotero.Beaver?.attachmentFileCache;
        if (!cache) {
            logger(`handleZoteroAttachmentPagesRequest: cache not available for ${requestKey}`, 1);
        }
        const cachedMeta = cache ? await cache.getMetadata(pdfItem.id, effectiveFilePath).catch(() => null) : null;
        throwIfTimedOut('metadata_cache_lookup');

        // Fast-path: use cached metadata for known error states.
        //
        // `extractingAllPages` is the original "no explicit bounds" predicate
        // (used for the `pageRange` decision below).
        // `effectivelyUnboundedExtract` is the predicate that gates the
        // `maxPageCount` guard: a request with `max_pages: 5` and no
        // start/end is only ever extracting 5 pages, so `maxPageCount` (a
        // ceiling on extract size) doesn't apply.
        const extractingAllPages = start_page == null && end_page == null;
        const hasMaxPagesCap = !!(max_pages && max_pages > 0);
        const effectivelyUnboundedExtract = extractingAllPages && !hasMaxPagesCap;
        const preflight = preflightCachedPdfMeta(cachedMeta, {
            checkOcr: true,
            applyPageCountCap: !skip_local_limits && effectivelyUnboundedExtract,
            maxPageCount: getPref('maxPageCount'),
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
                    );
            }
        }

        // 5. Resolve page labels and (only if needed) page count up-front.
        let pdfData: Uint8Array | null = null;
        const extractor = new BeaverExtractor();
        let pageLabels: Record<number, string> | null = null;

        // 5a. Load page labels for label-aware resolution. `ensurePageLabelsForResolution`
        // short-circuits on cache hits; only on cold cache does it open the PDF.
        // The bytes / pageCount it returns are reused below.
        if (prefer_page_labels && filePath) {
            const labelResult = await ensurePageLabelsForResolution(filePath, cachedMeta, extractor, signal);
            throwIfTimedOut('page_label_resolution');
            pageLabels = labelResult.labels;
            if (labelResult.pageCount != null) {
                totalPages = labelResult.pageCount;
            }
            if (labelResult.pdfData) {
                pdfData = labelResult.pdfData;
            }
        } else if (cachedMeta?.page_labels && Object.keys(cachedMeta.page_labels).length > 0) {
            pageLabels = cachedMeta.page_labels;
        }

        // 5b. Adopt cached page count when available (no doc-open).
        if (totalPages == null && cachedMeta?.page_count != null) {
            totalPages = cachedMeta.page_count;
        }

        // 5c. Upfront getPageCount ONLY when we're about to extract the
        // entire document and have no cached page_count — needed to gate
        // `maxPageCount` before committing to a multi-thousand-page extract.
        // Bounded ranges (including all-pages-with-max_pages) get pageCount
        // back inside `extract`.
        const needsUpfrontPageCount =
            totalPages == null && effectivelyUnboundedExtract && !skip_local_limits;
        if (needsUpfrontPageCount) {
            if (!pdfData) {
                try {
                    pdfData = await loadPdfData(pdfItem, effectiveFilePath, isRemoteOnly);
                    throwIfTimedOut('pdf_data_load_for_page_count');
                } catch (error) {
                    if (!isRemoteOnly) throw error;
                    logger(`handleZoteroAttachmentPagesRequest: Remote download failed: ${error}`, 1);
                    throwIfTimedOut('remote_download_failed_response');
                    return errorResponse(
                        `Failed to download PDF for ${pdfKey} from remote storage: ${error instanceof Error ? error.message : String(error)}`,
                        'download_failed'
                    );
                }
                if (isRemoteOnly) {
                    const exceeded = checkRemotePdfSize(pdfData, skip_local_limits);
                    if (exceeded) {
                        throwIfTimedOut('remote_file_too_large_response');
                        return errorResponse(
                            `The PDF file for ${pdfKey} has a file size of ${exceeded.sizeMB.toFixed(1)}MB, which exceeds the ${exceeded.maxMB}MB limit`,
                            'file_too_large'
                        );
                    }
                }
            }
            totalPages = await extractor.getPageCount(pdfData, signal);
            throwIfTimedOut('page_count_extraction');
        }

        // 6. Check page count limit when extracting the entire document.
        // `max_pages` already bounds the extract size — don't reject on it.
        if (!skip_local_limits && effectivelyUnboundedExtract && totalPages != null) {
            const maxPageCount = getPref('maxPageCount');
            if (totalPages > maxPageCount) {
                throwIfTimedOut('too_many_pages_response');
                return errorResponse(
                    `The PDF file for ${pdfKey} has ${totalPages} pages, which exceeds the ${maxPageCount}-page limit`,
                    'too_many_pages'
                );
            }
        }

        // 6b. A document that opened but resolves to zero pages is empty or
        // structurally corrupt. Classify it here so the result is
        // deterministic without depending on a worker round-trip.
        if (totalPages === 0) {
            throwIfTimedOut('empty_document_response');
            return errorResponse(
                `The PDF file for ${pdfKey} has no readable pages (it may be empty or corrupted)`,
                'empty_document',
                0,
            );
        }

        // 7. Resolve start/end page values to 1-based numeric indices on main
        // thread. `resolvePageValue` handles labels + numeric strings and throws
        // `InvalidPageValueError` for unparseable inputs. We do this here (not
        // worker-side) because `invalid_page_value` is a separate error code
        // from `page_out_of_range` and string parsing isn't part of the worker's job.
        // For numeric resolution we pass `totalPages ?? Number.MAX_SAFE_INTEGER`
        // as the fallback for `end_page == null` — when totalPages is unknown
        // we send the request as an open-ended `pageRange` and let the worker
        // resolve `endIndex` against its known pageCount.
        let startPage: number;
        let requestedEndPage: number | null;  // null = open-ended (no end provided)
        try {
            startPage = start_page != null
                ? resolvePageValue(start_page, pageLabels, prefer_page_labels === true)
                : 1;
            requestedEndPage = end_page != null
                ? resolvePageValue(end_page, pageLabels, prefer_page_labels === true)
                : (totalPages != null ? totalPages : null);
        } catch (error) {
            if (error instanceof InvalidPageValueError) {
                throwIfTimedOut('invalid_page_value_response');
                return errorResponse(error.message, 'invalid_page_value', totalPages);
            }
            throw error;
        }

        // 8. Content-cache lookup — only when we know a concrete endIdx.
        // Open-ended end with no cached page_count → skip cache, go straight
        // to extract (rare; trade-off documented in the implementation plan).
        let endPageForCache: number | null = null;
        if (requestedEndPage != null && totalPages != null) {
            let endPage = Math.min(requestedEndPage, totalPages);
            if (max_pages && max_pages > 0) {
                const maxAllowedEnd = startPage + max_pages - 1;
                if (endPage > maxAllowedEnd) {
                    endPage = maxAllowedEnd;
                }
            }
            endPageForCache = endPage;
        }

        if (cache && endPageForCache != null && totalPages != null) {
            const startIdx = startPage - 1;
            const endIdx = endPageForCache - 1;
            // Cheap pre-validation against known totalPages so we don't issue
            // a content-cache lookup for a request the worker would reject.
            if (startPage >= 1 && startPage <= totalPages && endPageForCache >= startPage) {
                try {
                    const cachedPages = await cache.getContentRange(
                        pdfItem.libraryID, pdfItem.key,
                        effectiveFilePath, startIdx, endIdx
                    );
                    throwIfTimedOut('content_cache_lookup');
                    if (cachedPages) {
                        logger(`handleZoteroAttachmentPagesRequest: Cache hit for ${requestKey} pages ${startPage}-${endPageForCache}`, 3);
                        const pages: WSPageContent[] = cachedPages.map((p) => ({
                            page_number: p.index + 1,
                            page_label: pageLabels?.[p.index] ?? p.label,
                            content: p.content,
                        }));
                        throwIfTimedOut('content_cache_hit_response');
                        return {
                            type: 'zotero_attachment_pages',
                            request_id,
                            attachment,
                            pages,
                            total_pages: totalPages,
                        };
                    }
                } catch (error) {
                    if (signal.aborted || error instanceof WorkerAbortError || error instanceof TimeoutError) {
                        throw error;
                    }
                    logger(`handleZoteroAttachmentPagesRequest: content cache read error: ${error}`, 1);
                }
            }
        }

        // 9. Cache miss — load bytes (if not already loaded) and call extract.
        logger(
            `handleZoteroAttachmentPagesRequest: Cache miss for ${requestKey} pages ${startPage}-${requestedEndPage ?? '(end)'}`,
            3,
        );
        if (!pdfData) {
            try {
                pdfData = await loadPdfData(pdfItem, effectiveFilePath, isRemoteOnly);
            } catch (error) {
                if (!isRemoteOnly) throw error; // local I/O error — let outer handler deal with it
                    logger(`handleZoteroAttachmentPagesRequest: Remote download failed: ${error}`, 1);
                    throwIfTimedOut('remote_download_failed_response');
                    return errorResponse(
                        `Failed to download PDF for ${pdfKey} from remote storage: ${error instanceof Error ? error.message : String(error)}`,
                        'download_failed'
                    );
            }
            if (isRemoteOnly) {
                const exceeded = checkRemotePdfSize(pdfData, skip_local_limits);
                if (exceeded) {
                    throwIfTimedOut('remote_file_too_large_response');
                    return errorResponse(
                        `The PDF file for ${pdfKey} has a file size of ${exceeded.sizeMB.toFixed(1)}MB, which exceeds the ${exceeded.maxMB}MB limit`,
                        'file_too_large'
                    );
                }
            }
        }

        // Choose extract arg shape based on what's known:
        //   - effectively unbounded                → no pageIndices/pageRange (worker uses all)
        //   - all-pages with max_pages              → pageRange { startIndex: 0, maxPages } (worker clamps)
        //   - bounded both ends                     → pageRange { startIndex, endIndex, maxPages }
        //   - open-ended (start set, end omitted)   → pageRange { startIndex, maxPages } (worker resolves endIndex)
        const extractArgs: {
            mode: 'markdown';
            settings?: { checkTextLayer: true };
            pageIndices?: number[];
            pageRange?: { startIndex: number; endIndex?: number; maxPages?: number };
        } = { mode: 'markdown', settings: { checkTextLayer: true } };
        if (!extractingAllPages) {
            const range: { startIndex: number; endIndex?: number; maxPages?: number } = {
                startIndex: startPage - 1,
            };
            if (requestedEndPage != null) {
                range.endIndex = requestedEndPage - 1;
            }
            if (hasMaxPagesCap) {
                range.maxPages = max_pages;
            }
            extractArgs.pageRange = range;
        } else if (hasMaxPagesCap) {
            // All-pages request with max_pages set: clamp the worker-side
            // resolution at startIndex=0 + maxPages so the response can't
            // exceed the requested cap. Without this the worker would extract
            // every page in the document.
            extractArgs.pageRange = { startIndex: 0, maxPages: max_pages };
        }
        logger(
            `handleZoteroAttachmentPagesRequest: extract for ${requestKey} `
            + `pageRange=${JSON.stringify(extractArgs.pageRange ?? null)} (allPages=${extractingAllPages}, max_pages=${max_pages ?? 'none'})`,
            3,
        );
        const result = await extractor.extract(pdfData, extractArgs, signal);
        throwIfTimedOut('pdf_extract');
        let markdownDocument: MarkdownDocument;
        if (result.mode === 'markdown') {
            markdownDocument = result.document;
        } else {
            throw new Error('Expected markdown extraction result for attachment pages');
        }

        // The worker's extract always populates document.pageCount.
        const resolvedPageCount = markdownDocument.pageCount;
        totalPages = resolvedPageCount;

        // Refresh pageLabels from the extraction result if we hadn't loaded
        // them earlier. Ensures response `page_label` is populated even when
        // `prefer_page_labels=false` and the cache was cold.
        if (!pageLabels && markdownDocument.pageLabels && Object.keys(markdownDocument.pageLabels).length > 0) {
            pageLabels = Object.fromEntries(
                Object.entries(markdownDocument.pageLabels).map(([index, label]) => [
                    Number(index),
                    label,
                ]),
            );
        }

        // 10. Build response (convert back to 1-indexed page numbers)
        const stringPageLabels = pageLabels
            ? Object.fromEntries(
                Object.entries(pageLabels).map(([index, label]) => [
                    String(index),
                    label,
                ]),
              )
            : undefined;
        const pages: WSPageContent[] = markdownDocumentToWSPageContent(
            markdownDocument,
            stringPageLabels,
        );

        // 10b. Write-through: persist metadata and content cache.
        // This handler produces document-level properties (page_labels) that
        // lightweight handlers (search, images, file-status) don't capture,
        // so we must always write — even when a prior handler already seeded
        // metadata with those fields as null.
        //
        // `persistMetadataToCache` handles the entry/post-stat shutdown
        // re-check internally; on shutdown or any failure it returns false,
        // and we must NOT proceed to `setContentPages` against a closing DB.
        if (cache) {
            // page_labels semantics:
            // - null => not checked yet (lightweight metadata path)
            // - {} => checked, no custom labels found
            // - populated object => checked, custom labels found
            const persistedPageLabels = markdownDocument.pageLabels && Object.keys(markdownDocument.pageLabels).length > 0
                ? Object.fromEntries(
                    Object.entries(markdownDocument.pageLabels).map(([index, label]) => [
                        Number(index),
                        label,
                    ]),
                  )
                : {};
            const metadataPersisted = await persistMetadataToCache(
                pdfItem,
                effectiveFilePath,
                pdfItem.attachmentContentType || 'application/pdf',
                {
                    page_count: resolvedPageCount,
                    page_labels: persistedPageLabels,
                    has_text_layer: true,
                    needs_ocr: false,
                    is_encrypted: false,
                    is_invalid: false,
                },
            );
            throwIfTimedOut('metadata_cache_persist');

            if (metadataPersisted && !Zotero.__beaverShuttingDown) {
                try {
                    const contentPages: CachedPageContent[] =
                        markdownDocumentToCachedPages(markdownDocument);
                    await cache.setContentPages(
                        pdfItem.libraryID,
                        pdfItem.key,
                        effectiveFilePath,
                        resolvedPageCount,
                        contentPages,
                    );
                    throwIfTimedOut('content_cache_persist');
                } catch (error) {
                    logger(`handleZoteroAttachmentPagesRequest: content-page write error: ${error}`, 1);
                }
            } else if (!metadataPersisted) {
                logger(`handleZoteroAttachmentPagesRequest: skipping setContentPages for ${requestKey} — metadata persistence skipped/failed`, 3);
            }
        }

        throwIfTimedOut('success_response');
        return {
            type: 'zotero_attachment_pages',
            request_id,
            attachment,
            pages,
            total_pages: resolvedPageCount,
        };

    } catch (error) {
        if (signal.aborted || error instanceof WorkerAbortError || error instanceof TimeoutError) {
            logger(`handleZoteroAttachmentPagesRequest: Timed out after ${timeoutSeconds}s`, 1);
            return errorResponse(
                `PDF extraction timed out after ${timeoutSeconds} seconds`,
                'timeout',
                totalPages,
            );
        }

        logger(`handleZoteroAttachmentPagesRequest: Extraction failed: ${error}`, 1);

        if (error instanceof ExtractionError) {
            // Backfill metadata for known error states
            if (resolvedPdfItem && resolvedFilePath && (error.code === ExtractionErrorCode.ENCRYPTED || error.code === ExtractionErrorCode.INVALID_PDF || error.code === ExtractionErrorCode.NO_TEXT_LAYER)) {
                await backfillMetadataForError(resolvedPdfItem, resolvedFilePath, error, totalPages, 'handleZoteroAttachmentPagesRequest');
            }

            // PAGE_OUT_OF_RANGE carries `pageCount` in its payload (set by the
            // strict resolvers in worker/docHelpers.ts). Prefer the worker's
            // pageCount over our local `totalPages` (which may be null when
            // we deferred to the worker).
            const totalPagesForError = error.pageCount ?? totalPages;

            switch (error.code) {
                case ExtractionErrorCode.ENCRYPTED:
                    return errorResponse(`The PDF file for ${errorKey} is password-protected`, 'encrypted');
                case ExtractionErrorCode.NO_TEXT_LAYER:
                    return errorResponse(`The PDF file for ${errorKey} requires OCR (no text layer)`, 'no_text_layer');
                case ExtractionErrorCode.INVALID_PDF:
                    return errorResponse(`The PDF file for ${errorKey} is invalid or corrupted`, 'invalid_pdf');
                case ExtractionErrorCode.EMPTY_DOCUMENT:
                    return errorResponse(
                        `The PDF file for ${errorKey} has no readable pages (it may be empty or corrupted)`,
                        'empty_document',
                        totalPagesForError
                    );
                case ExtractionErrorCode.PAGE_OUT_OF_RANGE:
                    return errorResponse(error.message, 'page_out_of_range', totalPagesForError);
                case ExtractionErrorCode.WASM_ERROR:
                    return errorResponse(
                        `The PDF file for ${errorKey} crashes the PDF parser and cannot be processed`,
                        'pdf_parser_crash',
                        totalPagesForError
                    );
                case ExtractionErrorCode.HEAP_EXHAUSTION:
                    return errorResponse(
                        `The PDF file for ${errorKey} is too large or complex to process and exhausted the parser's memory`,
                        'pdf_too_complex',
                        totalPagesForError
                    );
                default:
                    return errorResponse(
                        `Failed to extract PDF content for ${errorKey}: ${error.message}`,
                        'extraction_failed'
                    );
            }
        }

        return errorResponse(
            `Failed to extract PDF content for ${errorKey}: ${error instanceof Error ? error.message : String(error)}`,
            'extraction_failed'
        );
    } finally {
        dispose();
    }
}
