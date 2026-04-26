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
    WSZoteroAttachmentPageImagesRequest,
    WSZoteroAttachmentPageImagesResponse,
    AttachmentPageImagesErrorCode,
    WSPageImage,
} from '../agentProtocol';
import { PDFExtractor, ExtractionError, ExtractionErrorCode } from '../pdf';
import { EXTRACTION_VERSION, makeRemoteFilePath, isRemoteFilePath } from '../attachmentFileCache';
import { resolveToPdfAttachment, validateZoteroItemReference, backfillMetadataForError, loadPdfData, checkRemotePdfSize, isRemoteAccessAvailable } from './utils';
import { ensurePageLabelsForResolution, resolvePageValue, InvalidPageValueError } from './pageLabelResolution';

// Convert raw bytes to base64 in 32 KB chunks
function uint8ToBase64(bytes: Uint8Array): string {
    const CHUNK_SIZE = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        const chunk = bytes.subarray(i, i + CHUNK_SIZE);
        binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
    }
    return btoa(binary);
}

/**
 * Handle zotero_attachment_page_images_request event.
 * Renders PDF attachment pages as images using the PDF extraction service.
 */
export async function handleZoteroAttachmentPageImagesRequest(
    request: WSZoteroAttachmentPageImagesRequest
): Promise<WSZoteroAttachmentPageImagesResponse> {
    const { attachment, pages, scale, dpi, format, jpeg_quality, skip_local_limits, prefer_page_labels, request_id } = request;
    const requestKey = `${attachment.library_id}-${attachment.zotero_key}`;
    let errorKey = requestKey;

    // Hoisted for catch-block metadata backfill
    let resolvedPdfItem: Zotero.Item | null = null;
    let resolvedFilePath: string | null = null;
    let resolvedCachedPageCount: number | null = null;

    // Helper to create error response
    const errorResponse = (
        error: string,
        error_code: AttachmentPageImagesErrorCode,
        total_pages: number | null = null
    ): WSZoteroAttachmentPageImagesResponse => ({
        type: 'zotero_attachment_page_images',
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
        const cachedMeta = cache ? await cache.getMetadata(pdfItem.id, effectiveFilePath).catch(() => null) : null;
        resolvedCachedPageCount = cachedMeta?.page_count ?? null;

        // Determine once whether this is an all-pages request
        const requestingAllPages = !pages || pages.length === 0;

        if (cachedMeta) {
            if (cachedMeta.is_encrypted) {
                return errorResponse(`The PDF file for ${pdfKey} is password-protected`, 'encrypted');
            }
            if (cachedMeta.is_invalid) {
                return errorResponse(`The PDF file for ${pdfKey} is invalid or corrupted`, 'invalid_pdf');
            }
            // Check page count limit only for all-pages requests (not targeted page access)
            if (!skip_local_limits && requestingAllPages && cachedMeta.page_count != null) {
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
        const extractor = new PDFExtractor();
        let pdfData: Uint8Array | null = null;
        let pageLabels: Record<number, string> | null = null;
        let totalPages: number | null = null;

        // 5a. Load page labels for label-aware resolution. Short-circuits on cache.
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

        // 5c. Upfront getPageCount ONLY when rendering all pages and we have
        // no cached page_count — needed to gate `maxPageCount` before
        // committing to a multi-thousand-page render. Bounded requests get
        // pageCount back inside `renderPagesToImagesWithMeta`.
        const needsUpfrontPageCount =
            totalPages == null && requestingAllPages && !skip_local_limits;
        if (needsUpfrontPageCount) {
            if (!pdfData) {
                try {
                    pdfData = await loadPdfData(pdfItem, effectiveFilePath, isRemoteOnly);
                } catch (error) {
                    if (!isRemoteOnly) throw error;
                    logger(`handleZoteroAttachmentPageImagesRequest: Remote download failed: ${error}`, 1);
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

        // 6. Check page count limit for all-pages requests when totalPages known.
        if (!skip_local_limits && requestingAllPages && totalPages != null) {
            const maxPageCount = getPref('maxPageCount');
            if (totalPages > maxPageCount) {
                return errorResponse(
                    `The PDF file for ${pdfKey} has ${totalPages} pages, which exceeds the ${maxPageCount}-page limit`,
                    'too_many_pages'
                );
            }
        }

        // 7. Resolve `pages` array (label or numeric strings) to numeric indices
        // on main thread. Same separation-of-concerns as the pages handler:
        // string parsing → `invalid_page_value`; range validation →
        // `page_out_of_range` (worker-side).
        let pageIndicesArg: number[] | undefined;  // undefined = all pages
        if (pages && pages.length > 0) {
            let resolvedPages: number[];
            try {
                resolvedPages = pages.map(p => resolvePageValue(p, pageLabels, prefer_page_labels === true));
            } catch (error) {
                if (error instanceof InvalidPageValueError) {
                    return errorResponse(error.message, 'invalid_page_value', totalPages);
                }
                throw error;
            }

            if (totalPages != null) {
                // We know totalPages — pre-filter against bounds to short-circuit.
                const validPages = resolvedPages.filter(p => Number.isInteger(p) && p >= 1 && p <= totalPages!);
                if (validPages.length === 0) {
                    return errorResponse(
                        `All requested pages are out of range (document has ${totalPages} pages)`,
                        'page_out_of_range',
                        totalPages
                    );
                }
                pageIndicesArg = validPages.map(p => p - 1);
            } else {
                // totalPages unknown — let the worker's strict resolver enforce
                // PAGE_OUT_OF_RANGE. Convert to 0-indexed; non-integers are
                // filtered by `resolveExplicitPageIndicesOrThrow`.
                pageIndicesArg = resolvedPages.map(p => p - 1);
            }
        }
        // requestingAllPages → pageIndicesArg stays undefined → worker enumerates internally.

        // 8. Ensure PDF bytes are loaded before render.
        if (!pdfData) {
            try {
                pdfData = await loadPdfData(pdfItem, effectiveFilePath, isRemoteOnly);
            } catch (error) {
                if (!isRemoteOnly) throw error;
                logger(`handleZoteroAttachmentPageImagesRequest: Remote download failed: ${error}`, 1);
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

        // 9. Build render options
        const renderOptions = {
            scale: scale ?? 1.0,
            dpi: dpi ?? 0,
            format: format ?? 'png' as const,
            jpegQuality: jpeg_quality ?? 85,
        };

        // 10. Render — fused metadata + render in one round-trip.
        logger(
            `handleZoteroAttachmentPageImagesRequest: renderPagesToImagesWithMeta for ${requestKey} `
            + `pageIndices=${JSON.stringify(pageIndicesArg ?? null)} (allPages=${requestingAllPages})`,
            3,
        );
        const renderResult = await extractor.renderPagesToImagesWithMeta(pdfData, {
            pageIndices: pageIndicesArg,
            options: renderOptions,
        });

        // Refresh local state from the worker result.
        totalPages = renderResult.pageCount;
        if (!pageLabels && Object.keys(renderResult.pageLabels).length > 0) {
            pageLabels = renderResult.pageLabels;
        }

        // 11. Convert to base64 and build response
        const pageImages: WSPageImage[] = renderResult.pages.map((result) => {
            const base64Data = uint8ToBase64(result.data);

            return {
                page_number: result.pageIndex + 1, // Convert back to 1-indexed
                page_label: pageLabels?.[result.pageIndex],
                image_data: base64Data,
                format: result.format,
                width: result.width,
                height: result.height,
            };
        });

        // 11b. Write-through metadata only when it's safe to do so.
        //
        // Rendering proves the PDF opens, but it does NOT inspect the text
        // layer. `setMetadata` is a full upsert, and downstream readers
        // (`fileStatusFromCache` in utils.ts:384) treat a falsy `needs_ocr`
        // as "available". So if the image-render path is the FIRST cache
        // writer for a scanned/no-text PDF, writing `needs_ocr: null` would
        // make the file appear text-ready and skip the OCR check on later
        // `getAttachmentFileStatus` calls.
        //
        // Rule: only refresh page_count/page_labels when a prior writer
        // has already set `needs_ocr === false` (i.e., an authoritative
        // text-layer check has run). In that case we extend the existing
        // record without disturbing OCR state. Otherwise leave the cache
        // alone — a later text-extraction or status call will seed it
        // correctly.
        const canSafelyExtendCache = cache != null
            && cachedMeta != null
            && cachedMeta.needs_ocr === false
            && cachedMeta.is_encrypted === false
            && cachedMeta.is_invalid === false;
        if (cache && !canSafelyExtendCache) {
            logger(
                `handleZoteroAttachmentPageImagesRequest: skipping metadata write for ${requestKey} (no authoritative needs_ocr in cache)`,
                3,
            );
        }
        if (canSafelyExtendCache) {
            try {
                let file_mtime_ms = 0;
                let file_size_bytes = 0;
                if (!isRemoteFilePath(effectiveFilePath) && filePath) {
                    const stat = await IOUtils.stat(filePath);
                    file_mtime_ms = stat.lastModified ?? 0;
                    file_size_bytes = stat.size ?? 0;
                }
                const persistedPageLabels =
                    Object.keys(renderResult.pageLabels).length > 0 ? renderResult.pageLabels : {};
                await cache!.setMetadata({
                    item_id: pdfItem.id,
                    library_id: pdfItem.libraryID,
                    zotero_key: pdfItem.key,
                    file_path: effectiveFilePath,
                    file_mtime_ms,
                    file_size_bytes,
                    content_type: pdfItem.attachmentContentType || 'application/pdf',
                    page_count: renderResult.pageCount,
                    page_labels: persistedPageLabels,
                    has_text_layer: cachedMeta!.has_text_layer,
                    needs_ocr: cachedMeta!.needs_ocr,
                    is_encrypted: false,
                    is_invalid: false,
                    extraction_version: EXTRACTION_VERSION,
                });
            } catch (error) {
                logger(`handleZoteroAttachmentPageImagesRequest: cache write error: ${error}`, 1);
            }
        }

        return {
            type: 'zotero_attachment_page_images',
            request_id,
            attachment,
            pages: pageImages,
            total_pages: renderResult.pageCount,
        };

    } catch (error) {
        logger(`handleZoteroAttachmentPageImagesRequest: Rendering failed: ${error}`, 1);

        if (error instanceof ExtractionError) {
            // Backfill metadata for known error states
            if (resolvedPdfItem && resolvedFilePath && (error.code === ExtractionErrorCode.ENCRYPTED || error.code === ExtractionErrorCode.INVALID_PDF)) {
                await backfillMetadataForError(resolvedPdfItem, resolvedFilePath, error, resolvedCachedPageCount, 'handleZoteroAttachmentPageImagesRequest');
            }

            // PAGE_OUT_OF_RANGE carries `pageCount` in payload (worker strict resolvers).
            const totalPagesForError = error.pageCount ?? resolvedCachedPageCount ?? null;

            switch (error.code) {
                case ExtractionErrorCode.ENCRYPTED:
                    return errorResponse(`The PDF file for ${errorKey} is password-protected`, 'encrypted');
                case ExtractionErrorCode.INVALID_PDF:
                    return errorResponse(`The PDF file for ${errorKey} is invalid or corrupted`, 'invalid_pdf');
                case ExtractionErrorCode.PAGE_OUT_OF_RANGE:
                    return errorResponse(error.message, 'page_out_of_range', totalPagesForError);
                default:
                    return errorResponse(
                        `Failed to render PDF pages for ${errorKey}: ${error.message}`,
                        'render_failed'
                    );
            }
        }

        return errorResponse(
            `Failed to render PDF pages for ${errorKey}: ${error instanceof Error ? error.message : String(error)}`,
            'render_failed'
        );
    }
}
