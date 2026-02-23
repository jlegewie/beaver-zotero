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
import { EXTRACTION_VERSION } from '../attachmentFileCache';
import { validateZoteroItemReference } from './utils';


/**
 * Handle zotero_attachment_search_request event.
 * Searches for text within a PDF attachment using the PDF search service.
 */
export async function handleZoteroAttachmentSearchRequest(
    request: WSZoteroAttachmentSearchRequest
): Promise<WSZoteroAttachmentSearchResponse> {
    const { attachment, query, max_hits_per_page, skip_local_limits, request_id } = request;

    // Hoisted for catch-block metadata backfill
    let resolvedItem: Zotero.Item | null = null;
    let resolvedFilePath: string | null = null;

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

    // 0. Validate attachment reference format
    const unique_key = `${attachment.library_id}-${attachment.zotero_key}`;
    const formatError = validateZoteroItemReference(attachment);
    if (formatError) {
        return errorResponse(
            `Invalid attachment reference '${unique_key}': ${formatError}`,
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
                `Attachment not found: ${unique_key}`,
                'not_found'
            );
        }

        // 2. Verify it's a PDF attachment
        if (!zoteroItem.isAttachment()) {
            return errorResponse(
                'Item is not an attachment',
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
        resolvedItem = zoteroItem;
        const filePath = await zoteroItem.getFilePathAsync();
        resolvedFilePath = filePath || null;
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

        // 5b. Try metadata cache for fast prechecks
        const cache = Zotero.Beaver?.attachmentFileCache;
        const cachedMeta = cache ? await cache.getMetadata(zoteroItem.id, filePath).catch(() => null) : null;

        if (cachedMeta) {
            if (cachedMeta.is_encrypted) {
                return errorResponse('PDF is password-protected', 'encrypted');
            }
            if (cachedMeta.is_invalid) {
                return errorResponse('PDF file is invalid or corrupted', 'invalid_pdf');
            }
            if (!skip_local_limits && cachedMeta.page_count != null) {
                const maxPageCount = getPref('maxPageCount');
                if (cachedMeta.page_count > maxPageCount) {
                    return errorResponse(
                        `PDF has ${cachedMeta.page_count} pages, which exceeds the ${maxPageCount}-page limit`,
                        'too_many_pages'
                    );
                }
            }
        }

        // 6. Read the PDF data
        const pdfData = await IOUtils.read(filePath);

        // 7. Create extractor and get page count first
        const extractor = new PDFExtractor();
        let totalPages: number;

        if (cachedMeta?.page_count != null) {
            totalPages = cachedMeta.page_count;
        } else {
            try {
                totalPages = await extractor.getPageCount(pdfData);
            } catch (error) {
                if (error instanceof ExtractionError) {
                    if (error.code === ExtractionErrorCode.ENCRYPTED) {
                        // Let outer catch backfill encrypted metadata before returning.
                        throw error;
                    } else if (error.code === ExtractionErrorCode.INVALID_PDF) {
                        // Let outer catch backfill invalid metadata before returning.
                        throw error;
                    }
                }
                throw error;
            }
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

        // 10b. Backfill metadata if not already cached.
        // Uses insert-if-not-exists to avoid overwriting richer metadata
        // that a concurrent handler (e.g. pages) may have written.
        if (cache && !cachedMeta) {
            try {
                const stat = await IOUtils.stat(filePath);
                await cache.setMetadataIfNotExists({
                    item_id: zoteroItem.id, library_id: zoteroItem.libraryID, zotero_key: zoteroItem.key,
                    file_path: filePath, file_mtime_ms: stat.lastModified ?? 0, file_size_bytes: stat.size ?? 0,
                    content_type: zoteroItem.attachmentContentType || 'application/pdf',
                    page_count: totalPages, page_labels: null,
                    has_text_layer: null, needs_ocr: null,
                    is_encrypted: false, is_invalid: false,
                    extraction_version: EXTRACTION_VERSION, has_content_cache: false,
                });
            } catch (e) {
                logger(`handleZoteroAttachmentSearchRequest: metadata backfill error: ${e}`, 1);
            }
        }

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
            // Backfill metadata for known error states
            const cache = Zotero.Beaver?.attachmentFileCache;
            if (cache && resolvedItem && resolvedFilePath && (error.code === ExtractionErrorCode.ENCRYPTED || error.code === ExtractionErrorCode.INVALID_PDF)) {
                try {
                    const stat = await IOUtils.stat(resolvedFilePath);
                    await cache.setMetadata({
                        item_id: resolvedItem.id, library_id: resolvedItem.libraryID, zotero_key: resolvedItem.key,
                        file_path: resolvedFilePath, file_mtime_ms: stat.lastModified ?? 0, file_size_bytes: stat.size ?? 0,
                        content_type: resolvedItem.attachmentContentType || 'application/pdf',
                        page_count: null, page_labels: null,
                        has_text_layer: null, needs_ocr: null,
                        is_encrypted: error.code === ExtractionErrorCode.ENCRYPTED,
                        is_invalid: error.code === ExtractionErrorCode.INVALID_PDF,
                        extraction_version: EXTRACTION_VERSION, has_content_cache: false,
                    });
                } catch { /* best-effort */ }
            }

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
