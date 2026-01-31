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
import { getAttachmentInfo } from './utils';

/**
 * Handle zotero_attachment_page_images_request event.
 * Renders PDF attachment pages as images using the PDF extraction service.
 */
export async function handleZoteroAttachmentPageImagesRequest(
    request: WSZoteroAttachmentPageImagesRequest
): Promise<WSZoteroAttachmentPageImagesResponse> {
    const { attachment, pages, scale, dpi, format, jpeg_quality, skip_local_limits, request_id } = request;

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

    const unique_key = `${attachment.library_id}-${attachment.zotero_key}`;

    try {
        // 1. Get the attachment item from Zotero
        const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(
            attachment.library_id, 
            attachment.zotero_key
        );
        
        if (!zoteroItem) {
            return errorResponse(
                `Attachment does not exist in user's library: ${unique_key}`,
                'not_found'
            );
        }

        // Load all data for the item
        await zoteroItem.loadAllData();

        // 2. Verify it's a PDF attachment
        if (!zoteroItem.isAttachment()) {

            // Item is a regular item
            if(zoteroItem.isRegularItem()) {
                const info = await getAttachmentInfo(zoteroItem);
                const message = info.count > 0
                    ? `The id '${unique_key}' is a regular item, not an attachment. The item has ${info.count} attachments: ${info.text}`
                    : `The id '${unique_key}' is a regular item, not an attachment. The item has no attachments.`;
                return errorResponse(
                    message,
                    'not_attachment'
                );
            }

            // Item is a note or annotation
            if(zoteroItem.isNote() || zoteroItem.isAnnotation()) {
                return errorResponse(
                    `The id '${unique_key}' is a note or annotation, not an attachment.`,
                    'not_attachment'
                );
            }

            // Return generic error response for non-regular items
            return errorResponse(
                `attachment_id '${unique_key}' is not an attachment.`,
                'not_attachment'
            );
        }

        if (!zoteroItem.isPDFAttachment()) {
            const contentType = zoteroItem.attachmentContentType || 'unknown';
            return errorResponse(
                `Attachment is not a PDF (type: ${contentType})`,
                'not_pdf'
            );
        }

        // 3. Get the file path
        const filePath = await zoteroItem.getFilePathAsync();
        if (!filePath) {
            const isFileAvailableOnServer = isAttachmentOnServer(zoteroItem);
            const errorMessage = isFileAvailableOnServer
                ? `The PDF file for ${unique_key} is not available locally. It may be in remote storage, which cannot be accessed by Beaver.`
                : `The PDF file for ${unique_key} is not available locally.`;
            return errorResponse(
                errorMessage,
                'file_missing'
            );
        }

        // 4. Verify file exists
        const fileExists = await zoteroItem.fileExists();
        if (!fileExists) {
            return errorResponse(
                `The PDF file for ${unique_key} does not exist at expected location.`,
                'file_missing'
            );
        }

        // 5. Check file size before reading (skip if skip_local_limits is true)
        if (!skip_local_limits) {
            const maxFileSizeMB = getPref('maxFileSizeMB');
            const fileSize = await Zotero.Attachments.getTotalFileSize(zoteroItem);
            
            if (fileSize) {
                const fileSizeInMB = fileSize / 1024 / 1024;
                
                if (fileSizeInMB > maxFileSizeMB) {
                    return errorResponse(
                        `The PDF file for ${unique_key} has a file size of ${fileSizeInMB.toFixed(1)}MB, which exceeds the ${maxFileSizeMB}MB limit`,
                        'file_too_large'
                    );
                }
            }
        }

        // 6. Read the PDF data
        const pdfData = await IOUtils.read(filePath);

        // 7. Create extractor and get page count first
        const extractor = new PDFExtractor();
        let totalPages: number;
        
        try {
            totalPages = await extractor.getPageCount(pdfData);
        } catch (error) {
            if (error instanceof ExtractionError) {
                if (error.code === ExtractionErrorCode.ENCRYPTED) {
                    return errorResponse(
                        'PDF is password-protected',
                        'encrypted'
                    );
                } else if (error.code === ExtractionErrorCode.INVALID_PDF) {
                    return errorResponse(
                        `The PDF file for ${unique_key} is invalid or corrupted.`,
                        'invalid_pdf'
                    );
                }
            }
            throw error;
        }

        // 8. Check page count limit (skip if skip_local_limits is true)
        if (!skip_local_limits) {
            const maxPageCount = getPref('maxPageCount');
            
            if (totalPages > maxPageCount) {
                return errorResponse(
                    `The PDF file for ${unique_key} has ${totalPages} pages, which exceeds the ${maxPageCount}-page limit`,
                    'too_many_pages'
                );
            }
        }

        // 9. Determine which pages to render
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

        // 10. Build render options
        const renderOptions = {
            scale: scale ?? 1.0,
            dpi: dpi ?? 0,
            format: format ?? 'png' as const,
            jpegQuality: jpeg_quality ?? 85,
        };

        // 11. Render pages
        const renderResults = await extractor.renderPagesToImages(pdfData, pageIndices, renderOptions);

        // 12. Convert to base64 and build response
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

        // Handle known extraction errors
        if (error instanceof ExtractionError) {
            switch (error.code) {
                case ExtractionErrorCode.ENCRYPTED:
                    return errorResponse(`The PDF file for ${unique_key} is password-protected`, 'encrypted');
                case ExtractionErrorCode.INVALID_PDF:
                    return errorResponse(`The PDF file for ${unique_key} is invalid or corrupted`, 'invalid_pdf');
                case ExtractionErrorCode.PAGE_OUT_OF_RANGE:
                    return errorResponse(`The requested pages for ${unique_key} are out of range`, 'page_out_of_range');
                default:
                    return errorResponse(
                        `Failed to render PDF pages for ${unique_key}: ${error.message}`,
                        'render_failed'
                    );
            }
        }

        // Unknown error
        return errorResponse(
            `Failed to render PDF pages for ${unique_key}: ${error instanceof Error ? error.message : String(error)}`,
            'render_failed'
        );
    }
}