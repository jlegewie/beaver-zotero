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

import { isAttachmentOnServer } from '../../utils/webAPI';  // kept for file_missing message check
import {
    WSZoteroAttachmentPageImagesRequest,
    WSZoteroAttachmentPageImagesResponse,
    AttachmentPageImagesErrorCode,
    WSPageImage,
} from '../agentProtocol';
import { PDFExtractor, ExtractionError, ExtractionErrorCode } from '../pdf';
import { makeRemoteFilePath } from '../attachmentFileCache';
import { resolveToPdfAttachment, validateZoteroItemReference, backfillMetadataForError, loadPdfData, checkRemotePdfSize, isRemoteAccessAvailable } from './utils';
import { ensurePageLabelsForResolution, resolvePageValue, InvalidPageValueError } from './pageLabelResolution';

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
        const effectiveFilePath = filePath || (isRemoteOnly ? makeRemoteFilePath(pdfItem.attachmentSyncedHash) : null);
        resolvedFilePath = effectiveFilePath;

        if (!effectiveFilePath) {
            const onServer = isAttachmentOnServer(pdfItem);
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

        // 5. Resolve page count, page labels, and PDF bytes.
        const extractor = new PDFExtractor();
        let pdfData: Uint8Array | null = null;
        let pageLabels: Record<number, string> | null = null;
        let totalPages: number | null = null;

        // 5a. Load page labels (only when a local file is available)
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

        if (totalPages == null) {
            if (cachedMeta?.page_count != null) {
                totalPages = cachedMeta.page_count;
            } else {
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
        }

        // Ensure PDF bytes are available for rendering (step 9).
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

        // When prefer_page_labels is false, the normal fast path may render
        // from cached metadata without ever loading labels. Hydrate them once
        // on cold caches so image responses still populate page_label.
        if (
            prefer_page_labels !== true
            && !pageLabels
            && (!cachedMeta || cachedMeta.page_labels === null)
        ) {
            try {
                const { count, labels } = await extractor.getPageCountAndLabels(pdfData);
                pageLabels = Object.keys(labels).length > 0 ? labels : null;
                if (totalPages == null) {
                    totalPages = count;
                }
            } catch (error) {
                logger(`handleZoteroAttachmentPageImagesRequest: page label hydration failed for ${requestKey}: ${error}`, 1);
            }
        }

        // 6. Check page count limit for all-pages requests (skip if skip_local_limits is true)
        if (!skip_local_limits && requestingAllPages) {
            const maxPageCount = getPref('maxPageCount');
            if (totalPages > maxPageCount) {
                return errorResponse(
                    `The PDF file for ${pdfKey} has ${totalPages} pages, which exceeds the ${maxPageCount}-page limit`,
                    'too_many_pages'
                );
            }
        }

        // 7. Determine which pages to render
        let pageIndices: number[];
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

            // Filter out invalid pages: keep only pages in [1, totalPages]
            const validPages = resolvedPages.filter(p => p >= 1 && p <= totalPages);

            if (validPages.length === 0) {
                return errorResponse(
                    `All requested pages are out of range (document has ${totalPages} pages)`,
                    'page_out_of_range',
                    totalPages
                );
            }

            // Convert 1-indexed page numbers to 0-indexed
            pageIndices = validPages.map(p => p - 1);
        } else {
            // Default to all pages
            pageIndices = Array.from({ length: totalPages }, (_, i) => i);
        }

        // 8. Build render options
        const renderOptions = {
            scale: scale ?? 1.0,
            dpi: dpi ?? 0,
            format: format ?? 'png' as const,
            jpegQuality: jpeg_quality ?? 85,
        };

        // 9. Render pages
        const renderResults = await extractor.renderPagesToImages(pdfData, pageIndices, renderOptions);

        // 10. Convert to base64 and build response
        const pageImages: WSPageImage[] = renderResults.map((result) => {
            // Convert Uint8Array to base64
            const binaryStr = Array.from(result.data)
                .map(byte => String.fromCharCode(byte))
                .join('');
            const base64Data = btoa(binaryStr);

            return {
                page_number: result.pageIndex + 1, // Convert back to 1-indexed
                page_label: pageLabels?.[result.pageIndex],
                image_data: base64Data,
                format: result.format,
                width: result.width,
                height: result.height,
            };
        });

        return {
            type: 'zotero_attachment_page_images',
            request_id,
            attachment,
            pages: pageImages,
            total_pages: totalPages,
        };

    } catch (error) {
        logger(`handleZoteroAttachmentPageImagesRequest: Rendering failed: ${error}`, 1);

        if (error instanceof ExtractionError) {
            // Backfill metadata for known error states
            if (resolvedPdfItem && resolvedFilePath && (error.code === ExtractionErrorCode.ENCRYPTED || error.code === ExtractionErrorCode.INVALID_PDF)) {
                await backfillMetadataForError(resolvedPdfItem, resolvedFilePath, error, null, 'handleZoteroAttachmentPageImagesRequest');
            }

            switch (error.code) {
                case ExtractionErrorCode.ENCRYPTED:
                    return errorResponse(`The PDF file for ${errorKey} is password-protected`, 'encrypted');
                case ExtractionErrorCode.INVALID_PDF:
                    return errorResponse(`The PDF file for ${errorKey} is invalid or corrupted`, 'invalid_pdf');
                case ExtractionErrorCode.PAGE_OUT_OF_RANGE:
                    return errorResponse(`The requested pages for ${errorKey} are out of range`, 'page_out_of_range');
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
