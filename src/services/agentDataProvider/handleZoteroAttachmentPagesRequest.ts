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
import { resolveToPdfAttachment, validateZoteroItemReference } from './utils';


/**
 * Handle zotero_attachment_pages_request event.
 * Extracts text content from PDF attachment pages using the PDF extraction service.
 */
export async function handleZoteroAttachmentPagesRequest(
    request: WSZoteroAttachmentPagesRequest
): Promise<WSZoteroAttachmentPagesResponse> {
    const { attachment, start_page, end_page, skip_local_limits, request_id } = request;
    const requestKey = `${attachment.library_id}-${attachment.zotero_key}`;
    let errorKey = requestKey;

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

        // 6. Check page count limit when extracting all pages.
        // When a specific page range is given, extraction cost scales with the number of
        // requested pages, not total page count — so the limit is not meaningful there.
        const extractingAllPages = start_page === null && end_page === null;
        if (!skip_local_limits && extractingAllPages) {
            const maxPageCount = getPref('maxPageCount');
            if (totalPages > maxPageCount) {
                return errorResponse(
                    `The PDF file for ${pdfKey} has ${totalPages} pages, which exceeds the ${maxPageCount}-page limit`,
                    'too_many_pages'
                );
            }
        }

        // 7. Validate page range (1-indexed)
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

        // 8. Extract pages (convert to 0-indexed for extractor)
        const pageIndices = Array.from({ length: endPage - startPage + 1 }, (_, i) => startPage - 1 + i);
        const result = await extractor.extract(pdfData, {
            pages: pageIndices,
            checkTextLayer: true,
        });

        // 9. Build response (convert back to 1-indexed page numbers)
        const pages: WSPageContent[] = result.pages.map((page) => ({
            page_number: page.index + 1,
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

        if (error instanceof ExtractionError) {
            switch (error.code) {
                case ExtractionErrorCode.ENCRYPTED:
                    return errorResponse(`The PDF file for ${errorKey} is password-protected`, 'encrypted');
                case ExtractionErrorCode.NO_TEXT_LAYER:
                    return errorResponse(`The PDF file for ${errorKey} requires OCR (no text layer)`, 'no_text_layer');
                case ExtractionErrorCode.INVALID_PDF:
                    return errorResponse(`The PDF file for ${errorKey} is invalid or corrupted`, 'invalid_pdf');
                case ExtractionErrorCode.PAGE_OUT_OF_RANGE:
                    return errorResponse(`The requested pages for ${errorKey} are out of range`, 'page_out_of_range');
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
