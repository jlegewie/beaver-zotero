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
import { PDFExtractor, ExtractionError, ExtractionErrorCode } from '../pdf';
import { EXTRACTION_VERSION, makeRemoteFilePath } from '../attachmentFileCache';
import type { CachedPageContent } from '../attachmentFileCache';
import { resolveToPdfAttachment, validateZoteroItemReference, backfillMetadataForError, loadPdfData, checkRemotePdfSize, isRemoteAccessAvailable } from './utils';
import { ensurePageLabelsForResolution, resolvePageValue, InvalidPageValueError } from './pageLabelResolution';


/**
 * Handle zotero_attachment_pages_request event.
 * Extracts text content from PDF attachment pages using the PDF extraction service.
 */
export async function handleZoteroAttachmentPagesRequest(
    request: WSZoteroAttachmentPagesRequest
): Promise<WSZoteroAttachmentPagesResponse> {
    const { attachment, start_page, end_page, skip_local_limits, prefer_page_labels, max_pages, request_id } = request;
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

    try {
        // 1. Get the attachment item from Zotero
        const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(
            attachment.library_id,
            attachment.zotero_key
        );

        if (!zoteroItem) {
            return errorResponse(
                `Attachment does not exist in user's library: ${requestKey}`,
                'not_found'
            );
        }

        // Load all data for the item
        await zoteroItem.loadAllData();

        // 2. Resolve to a PDF attachment (auto-resolves regular items with one PDF)
        const resolveResult = await resolveToPdfAttachment(zoteroItem, requestKey);
        if (!resolveResult.resolved) {
            return errorResponse(resolveResult.error, resolveResult.error_code);
        }
        const { item: pdfItem, key: pdfKey } = resolveResult;
        errorKey = pdfKey;
        resolvedPdfItem = pdfItem;

        // 3. Get the file path — returns false if missing or nonexistent
        const rawFilePath = await pdfItem.getFilePathAsync();
        const filePath = rawFilePath || null;  // normalize false → null
        const isRemoteOnly = !filePath && isRemoteAccessAvailable(pdfItem);
        const effectiveFilePath = filePath || (isRemoteOnly ? makeRemoteFilePath(pdfItem) : null);
        resolvedFilePath = effectiveFilePath;

        if (!effectiveFilePath) {
            const onServer = isAttachmentAvailableRemotely(pdfItem);
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

            if (fileSize) {
                const fileSizeInMB = fileSize / 1024 / 1024;
                if (fileSizeInMB > maxFileSizeMB) {
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
        if (cachedMeta) {
            if (cachedMeta.is_encrypted) {
                return errorResponse(`The PDF file for ${pdfKey} is password-protected`, 'encrypted');
            }
            if (cachedMeta.is_invalid) {
                return errorResponse(`The PDF file for ${pdfKey} is invalid or corrupted`, 'invalid_pdf');
            }
            if (cachedMeta.needs_ocr) {
                return errorResponse(`The PDF file for ${pdfKey} requires OCR (no text layer)`, 'no_text_layer', cachedMeta.page_count ?? null);
            }
            // Page-count gate: only fires for requests that would extract the
            // entire document. `max_pages` already bounds the extract size.
            if (!skip_local_limits && effectivelyUnboundedExtract && cachedMeta.page_count != null) {
                const maxPageCount = getPref('maxPageCount');
                if (cachedMeta.page_count > maxPageCount) {
                    return errorResponse(
                        `The PDF file for ${pdfKey} has ${cachedMeta.page_count} pages, which exceeds the ${maxPageCount}-page limit`,
                        'too_many_pages'
                    );
                }
            }
        }

        // 5. Resolve page labels and (only if needed) page count up-front.
        let pdfData: Uint8Array | null = null;
        const extractor = new PDFExtractor();
        let pageLabels: Record<number, string> | null = null;

        // 5a. Load page labels for label-aware resolution. `ensurePageLabelsForResolution`
        // short-circuits on cache hits; only on cold cache does it open the PDF.
        // The bytes / pageCount it returns are reused below.
        if (prefer_page_labels && filePath) {
            const labelResult = await ensurePageLabelsForResolution(filePath, cachedMeta, extractor);
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
        // back inside `extractWithMeta`.
        const needsUpfrontPageCount =
            totalPages == null && effectivelyUnboundedExtract && !skip_local_limits;
        if (needsUpfrontPageCount) {
            if (!pdfData) {
                try {
                    pdfData = await loadPdfData(pdfItem, effectiveFilePath, isRemoteOnly);
                } catch (error) {
                    if (!isRemoteOnly) throw error;
                    logger(`handleZoteroAttachmentPagesRequest: Remote download failed: ${error}`, 1);
                    return errorResponse(
                        `Failed to download PDF for ${pdfKey} from remote storage: ${error instanceof Error ? error.message : String(error)}`,
                        'download_failed'
                    );
                }
                if (isRemoteOnly) {
                    const exceeded = checkRemotePdfSize(pdfData, skip_local_limits);
                    if (exceeded) {
                        return errorResponse(
                            `The PDF file for ${pdfKey} has a file size of ${exceeded.sizeMB.toFixed(1)}MB, which exceeds the ${exceeded.maxMB}MB limit`,
                            'file_too_large'
                        );
                    }
                }
            }
            totalPages = await extractor.getPageCount(pdfData);
        }

        // 6. Check page count limit when extracting the entire document.
        // `max_pages` already bounds the extract size — don't reject on it.
        if (!skip_local_limits && effectivelyUnboundedExtract && totalPages != null) {
            const maxPageCount = getPref('maxPageCount');
            if (totalPages > maxPageCount) {
                return errorResponse(
                    `The PDF file for ${pdfKey} has ${totalPages} pages, which exceeds the ${maxPageCount}-page limit`,
                    'too_many_pages'
                );
            }
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
                    if (cachedPages) {
                        logger(`handleZoteroAttachmentPagesRequest: Cache hit for ${requestKey} pages ${startPage}-${endPageForCache}`, 3);
                        const pages: WSPageContent[] = cachedPages.map((p) => ({
                            page_number: p.index + 1,
                            page_label: pageLabels?.[p.index] ?? p.label,
                            content: p.content,
                        }));
                        return {
                            type: 'zotero_attachment_pages',
                            request_id,
                            attachment,
                            pages,
                            total_pages: totalPages,
                        };
                    }
                } catch (error) {
                    logger(`handleZoteroAttachmentPagesRequest: content cache read error: ${error}`, 1);
                }
            }
        }

        // 9. Cache miss — load bytes (if not already loaded) and call extractWithMeta.
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
                return errorResponse(
                    `Failed to download PDF for ${pdfKey} from remote storage: ${error instanceof Error ? error.message : String(error)}`,
                    'download_failed'
                );
            }
            if (isRemoteOnly) {
                const exceeded = checkRemotePdfSize(pdfData, skip_local_limits);
                if (exceeded) {
                    return errorResponse(
                        `The PDF file for ${pdfKey} has a file size of ${exceeded.sizeMB.toFixed(1)}MB, which exceeds the ${exceeded.maxMB}MB limit`,
                        'file_too_large'
                    );
                }
            }
        }

        // Choose extractWithMeta arg shape based on what's known:
        //   - effectively unbounded                → no pageIndices/pageRange (worker uses all)
        //   - all-pages with max_pages              → pageRange { startIndex: 0, maxPages } (worker clamps)
        //   - bounded both ends                     → pageRange { startIndex, endIndex, maxPages }
        //   - open-ended (start set, end omitted)   → pageRange { startIndex, maxPages } (worker resolves endIndex)
        const extractArgs: {
            settings?: { checkTextLayer: true };
            pageIndices?: number[];
            pageRange?: { startIndex: number; endIndex?: number; maxPages?: number };
        } = { settings: { checkTextLayer: true } };
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
            `handleZoteroAttachmentPagesRequest: extractWithMeta for ${requestKey} `
            + `pageRange=${JSON.stringify(extractArgs.pageRange ?? null)} (allPages=${extractingAllPages}, max_pages=${max_pages ?? 'none'})`,
            3,
        );
        const result = await extractor.extractWithMeta(pdfData, extractArgs);

        // The worker's extractWithMeta always populates analysis.pageCount.
        const resolvedPageCount = result.analysis.pageCount;
        totalPages = resolvedPageCount;

        // Refresh pageLabels from the extraction result if we hadn't loaded
        // them earlier. Ensures response `page_label` is populated even when
        // `prefer_page_labels=false` and the cache was cold.
        if (!pageLabels && result.pageLabels && Object.keys(result.pageLabels).length > 0) {
            pageLabels = result.pageLabels;
        }

        // 10. Build response (convert back to 1-indexed page numbers)
        const pages: WSPageContent[] = result.pages.map((page) => ({
            page_number: page.index + 1,
            page_label: pageLabels?.[page.index] ?? page.label,
            content: page.content,
        }));

        // 10b. Write-through: persist metadata and content cache
        if (cache) {
            try {
                // Always persist metadata after successful extraction.
                // This handler produces document-level properties (page_labels)
                // that lightweight handlers (search, images, file-status) don't
                // capture, so we must always write — even when a prior handler
                // already seeded metadata with those fields as null.
                let file_mtime_ms = 0;
                let file_size_bytes = 0;
                if (!isRemoteOnly) {
                    const stat = await IOUtils.stat(filePath!);
                    file_mtime_ms = stat.lastModified ?? 0;
                    file_size_bytes = stat.size ?? 0;
                }
                // page_labels semantics:
                // - null => not checked yet (lightweight metadata path)
                // - {} => checked, no custom labels found
                // - populated object => checked, custom labels found
                const persistedPageLabels = result.pageLabels && Object.keys(result.pageLabels).length > 0
                    ? result.pageLabels
                    : {};
                await cache.setMetadata({
                    item_id: pdfItem.id,
                    library_id: pdfItem.libraryID,
                    zotero_key: pdfItem.key,
                    file_path: effectiveFilePath,
                    file_mtime_ms,
                    file_size_bytes,
                    content_type: pdfItem.attachmentContentType || 'application/pdf',
                    page_count: resolvedPageCount,
                    page_labels: persistedPageLabels,
                    has_text_layer: true,
                    needs_ocr: false,
                    is_encrypted: false,
                    is_invalid: false,
                    extraction_version: EXTRACTION_VERSION,
                });

                // Persist content pages
                const contentPages: CachedPageContent[] = result.pages.map((p) => ({
                    index: p.index,
                    label: p.label,
                    content: p.content,
                    width: p.width,
                    height: p.height,
                }));
                await cache.setContentPages(
                    pdfItem.libraryID,
                    pdfItem.key,
                    effectiveFilePath,
                    resolvedPageCount,
                    contentPages
                );
            } catch (error) {
                logger(`handleZoteroAttachmentPagesRequest: cache write error: ${error}`, 1);
            }
        }

        return {
            type: 'zotero_attachment_pages',
            request_id,
            attachment,
            pages,
            total_pages: resolvedPageCount,
        };

    } catch (error) {
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
                case ExtractionErrorCode.PAGE_OUT_OF_RANGE:
                    return errorResponse(error.message, 'page_out_of_range', totalPagesForError);
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
    }
}
