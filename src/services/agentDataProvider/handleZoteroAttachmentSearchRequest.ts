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
    WSZoteroAttachmentSearchRequest,
    WSZoteroAttachmentSearchResponse,
    AttachmentSearchErrorCode,
    WSPageSearchResult,
    WSSearchHit,
} from '../agentProtocol';
import { PDFExtractor, ExtractionError, ExtractionErrorCode } from '../pdf';


/**
 * Handle zotero_attachment_search_request event.
 * Searches for text within a PDF attachment using the PDF search service.
 */
export async function handleZoteroAttachmentSearchRequest(
    request: WSZoteroAttachmentSearchRequest
): Promise<WSZoteroAttachmentSearchResponse> {
    const { attachment, query, max_hits_per_page, skip_local_limits, request_id } = request;

    // Helper to create error response
    const errorResponse = (
        error: string, 
        error_code: AttachmentSearchErrorCode,
        total_pages: number | null = null
    ): WSZoteroAttachmentSearchResponse => ({
        type: 'zotero_attachment_search',
        request_id,
        attachment,
        query,
        total_matches: 0,
        pages_with_matches: 0,
        total_pages,
        pages: [],
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

        // 9. Perform search
        const searchResult = await extractor.search(pdfData, query, {
            maxHitsPerPage: max_hits_per_page ?? 100,
        });

        // 10. Convert to response format
        const pages: WSPageSearchResult[] = searchResult.pages.map((page) => ({
            page_index: page.pageIndex,
            label: page.label,
            match_count: page.matchCount,
            score: page.score,
            text_length: page.textLength,
            hits: page.hits.map((hit): WSSearchHit => ({
                bbox: hit.bbox,
                role: hit.role,
                weight: hit.weight,
                matched_text: hit.matchedText,
            })),
        }));

        return {
            type: 'zotero_attachment_search',
            request_id,
            attachment,
            query,
            total_matches: searchResult.totalMatches,
            pages_with_matches: searchResult.pagesWithMatches,
            total_pages: totalPages,
            pages,
        };

    } catch (error) {
        logger(`handleZoteroAttachmentSearchRequest: Search failed: ${error}`, 1);

        // Handle known extraction errors
        if (error instanceof ExtractionError) {
            switch (error.code) {
                case ExtractionErrorCode.ENCRYPTED:
                    return errorResponse('PDF is password-protected', 'encrypted');
                case ExtractionErrorCode.INVALID_PDF:
                    return errorResponse('PDF file is invalid or corrupted', 'invalid_pdf');
                default:
                    return errorResponse(
                        `Search failed: ${error.message}`,
                        'search_failed'
                    );
            }
        }

        // Unknown error
        return errorResponse(
            `Failed to search PDF: ${error instanceof Error ? error.message : String(error)}`,
            'search_failed'
        );
    }
}
