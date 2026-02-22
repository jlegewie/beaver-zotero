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

import { isAttachmentOnServer } from '../../utils/webAPI';
import {
    WSZoteroAttachmentPageImagesRequest,
    WSZoteroAttachmentPageImagesResponse,
    AttachmentPageImagesErrorCode,
    WSPageImage,
} from '../agentProtocol';
import { PDFExtractor, ExtractionError, ExtractionErrorCode } from '../pdf';
import { resolveToPdfAttachment, validateZoteroItemReference } from './utils';

/**
 * Handle zotero_attachment_page_images_request event.
 * Renders PDF attachment pages as images using the PDF extraction service.
 */
export async function handleZoteroAttachmentPageImagesRequest(
    request: WSZoteroAttachmentPageImagesRequest
): Promise<WSZoteroAttachmentPageImagesResponse> {
    const { attachment, pages, scale, dpi, format, jpeg_quality, skip_local_limits, request_id } = request;
    const requestKey = `${attachment.library_id}-${attachment.zotero_key}`;
    let errorKey = requestKey;

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

        // 3. Get the file path — returns false if missing or nonexistent
        const filePath = await pdfItem.getFilePathAsync();
        if (!filePath) {
            const isOnServer = isAttachmentOnServer(pdfItem);
            return errorResponse(
                isOnServer
                    ? `The PDF file for ${pdfKey} is not available locally. It may be in remote storage, which cannot be accessed by Beaver.`
                    : `The PDF file for ${pdfKey} is not available locally.`,
                'file_missing'
            );
        }

        // 4. Check file size limit (skip if skip_local_limits is true)
        if (!skip_local_limits) {
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

        // 5. Read PDF and get page count (also validates the PDF structure)
        const pdfData = await IOUtils.read(filePath);
        const extractor = new PDFExtractor();
        const totalPages = await extractor.getPageCount(pdfData);

        // 6. Check page count limit (skip if skip_local_limits is true)
        if (!skip_local_limits) {
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
            // Convert 1-indexed page numbers to 0-indexed
            pageIndices = pages.map(p => p - 1);

            // Validate page numbers are in range
            for (const pageNum of pages) {
                if (pageNum < 1 || pageNum > totalPages) {
                    return errorResponse(
                        `Page ${pageNum} is out of range (document has ${totalPages} pages)`,
                        'page_out_of_range',
                        totalPages
                    );
                }
            }
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
