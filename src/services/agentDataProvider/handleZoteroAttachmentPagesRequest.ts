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
import { EXTRACTION_VERSION } from '../attachmentFileCache';
import type { CachedPageContent } from '../attachmentFileCache';
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

    // Hoisted so the catch block can access the resolved PDF identity
    // for error-state metadata backfill (after auto-resolution).
    let resolvedPdfItem: Zotero.Item | null = null;
    let resolvedFilePath: string | null = null;

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
        const filePath = await pdfItem.getFilePathAsync();
        resolvedFilePath = filePath || null;
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

        // 4b. Try metadata cache for fast prechecks
        const cache = Zotero.Beaver?.attachmentFileCache;
        const cachedMeta = cache ? await cache.getMetadata(pdfItem.id, filePath).catch(() => null) : null;

        // Fast-path: use cached metadata for known error states
        if (cachedMeta) {
            if (cachedMeta.is_encrypted) {
                return errorResponse(`The PDF file for ${pdfKey} is password-protected`, 'encrypted');
            }
            if (cachedMeta.is_invalid) {
                return errorResponse(`The PDF file for ${pdfKey} is invalid or corrupted`, 'invalid_pdf');
            }
        }

        // 5. Determine total page count (from cache or PDF)
        let totalPages: number;
        let pdfData: Uint8Array | null = null;
        const extractor = new PDFExtractor();

        if (cachedMeta?.page_count != null) {
            totalPages = cachedMeta.page_count;
        } else {
            pdfData = await IOUtils.read(filePath);
            totalPages = await extractor.getPageCount(pdfData);
        }

        // 6. Check page count limit when extracting all pages.
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

        // 7b. Try content cache for requested page range (0-indexed)
        const startIdx = startPage - 1;
        const endIdx = endPage - 1;

        if (cache) {
            try {
                const cachedPages = await cache.getContentRange(
                    pdfItem.libraryID, pdfItem.key,
                    filePath, startIdx, endIdx
                );
                if (cachedPages) {
                    logger(`handleZoteroAttachmentPagesRequest: Cache hit for ${requestKey} pages ${startPage}-${endPage}`, 3);
                    const pages: WSPageContent[] = cachedPages.map((p) => ({
                        page_number: p.index + 1,
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

        // 8. Cache miss — extract pages (convert to 0-indexed for extractor)
        logger(`handleZoteroAttachmentPagesRequest: Cache miss for ${requestKey} pages ${startPage}-${endPage}`, 3);
        if (!pdfData) {
            pdfData = await IOUtils.read(filePath);
        }
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

        // 9b. Write-through: persist metadata and content cache
        if (cache) {
            try {
                // Persist or upgrade metadata.
                // Always write when no row exists. Also upgrade existing rows
                // that lack OCR state (needs_ocr === null) — those were seeded
                // by the lightweight/search/image paths and should now receive
                // the known OCR fields from the successful extraction.
                if (!cachedMeta || cachedMeta.needs_ocr === null) {
                    const stat = await IOUtils.stat(filePath);
                    const pageLabels = result.pageLabels ?? null;
                    await cache.setMetadata({
                        item_id: pdfItem.id,
                        library_id: pdfItem.libraryID,
                        zotero_key: pdfItem.key,
                        file_path: filePath,
                        file_mtime_ms: stat.lastModified ?? 0,
                        file_size_bytes: stat.size ?? 0,
                        content_type: pdfItem.attachmentContentType || 'application/pdf',
                        page_count: totalPages,
                        page_labels: pageLabels && Object.keys(pageLabels).length > 0 ? pageLabels : null,
                        has_text_layer: true,
                        needs_ocr: false,
                        is_encrypted: false,
                        is_invalid: false,
                        extraction_version: EXTRACTION_VERSION,
                        has_content_cache: cachedMeta?.has_content_cache ?? false,
                    });
                }

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
                    filePath,
                    totalPages,
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
            total_pages: totalPages,
        };

    } catch (error) {
        logger(`handleZoteroAttachmentPagesRequest: Extraction failed: ${error}`, 1);

        if (error instanceof ExtractionError) {
            // Backfill metadata for known error states using the already-
            // resolved identity (hoisted before the try block).
            const cache = Zotero.Beaver?.attachmentFileCache;
            if (cache && resolvedPdfItem && resolvedFilePath && (error.code === ExtractionErrorCode.ENCRYPTED || error.code === ExtractionErrorCode.INVALID_PDF || error.code === ExtractionErrorCode.NO_TEXT_LAYER)) {
                try {
                    const stat = await IOUtils.stat(resolvedFilePath);
                    await cache.setMetadata({
                        item_id: resolvedPdfItem.id, library_id: resolvedPdfItem.libraryID, zotero_key: resolvedPdfItem.key,
                        file_path: resolvedFilePath, file_mtime_ms: stat.lastModified ?? 0, file_size_bytes: stat.size ?? 0,
                        content_type: resolvedPdfItem.attachmentContentType || 'application/pdf',
                        page_count: null, page_labels: null,
                        has_text_layer: error.code !== ExtractionErrorCode.NO_TEXT_LAYER ? null : false,
                        needs_ocr: error.code === ExtractionErrorCode.NO_TEXT_LAYER,
                        is_encrypted: error.code === ExtractionErrorCode.ENCRYPTED,
                        is_invalid: error.code === ExtractionErrorCode.INVALID_PDF,
                        extraction_version: EXTRACTION_VERSION, has_content_cache: false,
                    });
                } catch { /* best-effort */ }
            }

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
