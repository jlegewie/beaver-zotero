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
    WSZoteroAttachmentPagesRequest,
    WSZoteroAttachmentPagesResponse,
    AttachmentPagesErrorCode,
    WSPageContent,
} from '../agentProtocol';
import { PDFExtractor, ExtractionError, ExtractionErrorCode } from '../pdf';


/**
 * Handle zotero_attachment_pages_request event.
 * Extracts text content from PDF attachment pages using the PDF extraction service.
 */
export async function handleZoteroAttachmentPagesRequest(
    request: WSZoteroAttachmentPagesRequest
): Promise<WSZoteroAttachmentPagesResponse> {
    const { attachment, start_page, end_page, skip_local_limits, request_id } = request;

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

    try {
        // 1. Get the attachment item from Zotero
        const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(
            attachment.library_id, 
            attachment.zotero_key
        );
        
        if (!zoteroItem) {
            return errorResponse(
                `Attachment not found: ${attachment.library_id}-${attachment.zotero_key}`,
                'not_found'
            );
        }

        // 2. Verify it's a PDF attachment
        if (!zoteroItem.isAttachment()) {
            return errorResponse(
                'Item is not an attachment',
                'not_pdf'
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
                ? 'PDF file is not available locally. It may be in remote storage, which cannot be accessed by Beaver.'
                : 'PDF file is not available locally';
            return errorResponse(
                errorMessage,
                'file_missing'
            );
        }

        // 4. Verify file exists
        const fileExists = await zoteroItem.fileExists();
        if (!fileExists) {
            return errorResponse(
                'PDF file does not exist at expected location',
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
                        `PDF file size of ${fileSizeInMB.toFixed(1)}MB exceeds the ${maxFileSizeMB}MB limit`,
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
                        'PDF file is invalid or corrupted',
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
                    `PDF has ${totalPages} pages, which exceeds the ${maxPageCount}-page limit`,
                    'too_many_pages'
                );
            }
        }

        // 9. Validate page range (convert 1-indexed to 0-indexed)
        const startPage = start_page ?? 1;
        const endPage = end_page ?? totalPages;

        if (startPage < 1 || startPage > totalPages) {
            return errorResponse(
                `Start page ${startPage} is out of range (document has ${totalPages} pages)`,
                'page_out_of_range',
                totalPages
            );
        }

        if (endPage < startPage || endPage > totalPages) {
            return errorResponse(
                `End page ${endPage} is out of range (document has ${totalPages} pages)`,
                'page_out_of_range',
                totalPages
            );
        }

        // 10. Build page indices (0-indexed for extraction)
        const pageIndices: number[] = [];
        for (let i = startPage - 1; i < endPage; i++) {
            pageIndices.push(i);
        }

        // 11. Extract pages with OCR check enabled
        const result = await extractor.extract(pdfData, {
            pages: pageIndices,
            checkTextLayer: true, // Fail if PDF needs OCR
        });

        // 12. Build response
        const pages: WSPageContent[] = result.pages.map((page) => ({
            page_number: page.index + 1, // Convert back to 1-indexed
            content: page.content,
        }));

        return {
            type: 'zotero_attachment_pages',
            request_id,
            attachment,
            pages,
            total_pages: totalPages,
        };

    } catch (error) {
        logger(`handleZoteroAttachmentPagesRequest: Extraction failed: ${error}`, 1);

        // Handle known extraction errors
        if (error instanceof ExtractionError) {
            switch (error.code) {
                case ExtractionErrorCode.ENCRYPTED:
                    return errorResponse('PDF is password-protected', 'encrypted');
                case ExtractionErrorCode.NO_TEXT_LAYER:
                    return errorResponse('PDF requires OCR (no text layer)', 'no_text_layer');
                case ExtractionErrorCode.INVALID_PDF:
                    return errorResponse('PDF file is invalid or corrupted', 'invalid_pdf');
                case ExtractionErrorCode.PAGE_OUT_OF_RANGE:
                    return errorResponse('Requested pages are out of range', 'page_out_of_range');
                default:
                    return errorResponse(
                        `Extraction failed: ${error.message}`,
                        'extraction_failed'
                    );
            }
        }

        // Unknown error
        return errorResponse(
            `Failed to extract PDF content: ${error instanceof Error ? error.message : String(error)}`,
            'extraction_failed'
        );
    }
}