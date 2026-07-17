/**
 * Agent Data Provider
 * 
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 * 
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */

import { logger } from '../../utils/logger';
import { isAttachmentAvailableRemotely } from '../../utils/webAPI';  // kept for file_missing message check
import {
    WSZoteroAttachmentSearchRequest,
    WSZoteroAttachmentSearchResponse,
    AttachmentSearchErrorCode,
    WSPageSearchResult,
    WSSearchHit,
} from '../agentProtocol';
import {
    BeaverExtractor,
    ExtractionError,
    ExtractionErrorCode,
    WorkerAbortError,
    isWorkerDeadlineError,
} from '../../beaver-extract';
import { makeRemoteFilePath } from '../documentFileIdentity';
import {
    preflightZoteroAttachmentRequest,
    validateZoteroItemReference,
    loadPdfData,
    checkRemotePdfSize,
    isRemoteAccessAvailable,
    preflightCachedPdfMeta,
} from './utils';
import {
    DEFAULT_SEARCH_TIMEOUT_SECONDS,
    TimeoutError,
    createTimeoutController,
} from './timeout';
import { effectiveMaxFileSizeMB, effectiveMaxPageCount } from '../attachmentLimits';


/**
 * Handle zotero_attachment_search_request event.
 * Searches for text within a PDF attachment using the PDF search service.
 */
export async function handleZoteroAttachmentSearchRequest(
    request: WSZoteroAttachmentSearchRequest
): Promise<WSZoteroAttachmentSearchResponse> {
    const { attachment, query, max_hits_per_page, request_id, timeout_seconds } = request;
    const preflight = preflightZoteroAttachmentRequest(attachment, validateZoteroItemReference);
    const { responseAttachment, requestKey: unique_key } = preflight;

    // Hoisted for catch-block metadata backfill
    let resolvedItem: Zotero.Item | null = null;
    let resolvedFilePath: string | null = null;
    let totalPages: number | null = null;
    let loadedPdfData: Uint8Array | null = null;

    // Helper to create error response
    const errorResponse = (
        error: string, 
        error_code: AttachmentSearchErrorCode,
        total_pages: number | null = null
    ): WSZoteroAttachmentSearchResponse => ({
        type: 'zotero_attachment_search',
        request_id,
        attachment: responseAttachment,
        query,
        total_matches: 0,
        pages_with_matches: 0,
        total_pages,
        pages: [],
        error,
        error_code,
    });

    // 0. Validate attachment reference format
    if (!preflight.ok) {
        return errorResponse(preflight.error, preflight.errorCode);
    }
    const { resolvedLibraryId } = preflight;

    const timeout = createTimeoutController(timeout_seconds, DEFAULT_SEARCH_TIMEOUT_SECONDS);
    const { signal, timeoutSeconds, throwIfTimedOut, dispose } = timeout;

    try {
        const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(
            resolvedLibraryId,
            attachment.zotero_key
        );
        throwIfTimedOut('zotero_item_lookup');

        if (!zoteroItem) {
            throwIfTimedOut('not_found_response');
            return errorResponse(
                `Attachment not found: ${unique_key}`,
                'not_found'
            );
        }

        // 2. Verify it's a PDF attachment
        if (!zoteroItem.isAttachment()) {
            throwIfTimedOut('not_attachment_response');
            return errorResponse(
                'Item is not an attachment',
                'not_attachment'
            );
        }

        if (!zoteroItem.isPDFAttachment()) {
            const contentType = zoteroItem.attachmentContentType || 'unknown';
            throwIfTimedOut('not_pdf_response');
            return errorResponse(
                `In-document search is currently supported for PDF attachments only (this attachment is ${contentType})`,
                'not_pdf'
            );
        }

        // 3. Get the file path
        resolvedItem = zoteroItem;
        const rawFilePath = await zoteroItem.getFilePathAsync();
        throwIfTimedOut('file_path_lookup');
        const filePath = rawFilePath || null;  // normalize false → null
        const isRemoteOnly = !filePath && isRemoteAccessAvailable(zoteroItem);
        const effectiveFilePath = filePath || (isRemoteOnly ? makeRemoteFilePath(zoteroItem) : null);
        resolvedFilePath = effectiveFilePath;

        if (!effectiveFilePath) {
            const onServer = isAttachmentAvailableRemotely(zoteroItem);
            throwIfTimedOut('file_missing_response');
            return errorResponse(
                onServer
                    ? 'PDF file is not available locally and remote file access is disabled in settings.'
                    : 'PDF file is not available locally',
                'file_missing'
            );
        }

        // 4. Verify file exists (skip for remote files)
        if (!isRemoteOnly) {
            const fileExists = await zoteroItem.fileExists();
            throwIfTimedOut('file_exists_check');
            if (!fileExists) {
                throwIfTimedOut('file_missing_response');
                return errorResponse(
                    'PDF file does not exist at expected location',
                    'file_missing'
                );
            }
        }

        // 5. Check file size before reading (remote files are checked after download).
        const maxFileSizeMB = effectiveMaxFileSizeMB();
        if (!isRemoteOnly) {
            const fileSize = await Zotero.Attachments.getTotalFileSize(zoteroItem);
            throwIfTimedOut('file_size_check');

            if (fileSize) {
                const fileSizeInMB = fileSize / 1024 / 1024;

                if (fileSizeInMB > maxFileSizeMB) {
                    throwIfTimedOut('file_too_large_response');
                    return errorResponse(
                        `PDF file size of ${fileSizeInMB.toFixed(1)}MB exceeds the ${maxFileSizeMB}MB limit.`,
                        'file_too_large'
                    );
                }
            }
        }

        // 5b. Try metadata cache for fast prechecks
        const cache = Zotero.Beaver?.documentCache;
        const cachedMeta = cache ? await cache.getMetadata({
            libraryId: zoteroItem.libraryID,
            zoteroKey: zoteroItem.key,
        }, effectiveFilePath).catch(() => null) : null;
        throwIfTimedOut('metadata_cache_lookup');

        const preflight = preflightCachedPdfMeta(cachedMeta, {
            checkOcr: true,
            applyPageCountCap: true,
            maxPageCount: effectiveMaxPageCount(),
        });
        if (preflight) {
            switch (preflight.code) {
                case 'encrypted':
                    throwIfTimedOut('cached_encrypted_response');
                    return errorResponse('PDF is password-protected', 'encrypted');
                case 'invalid_pdf':
                    throwIfTimedOut('cached_invalid_pdf_response');
                    return errorResponse('PDF file is invalid or corrupted', 'invalid_pdf');
                case 'no_text_layer':
                    throwIfTimedOut('cached_no_text_layer_response');
                    return errorResponse(
                        'PDF requires OCR (no text layer) — text search unavailable',
                        'no_text_layer',
                        preflight.pageCount,
                    );
                case 'too_many_pages':
                    throwIfTimedOut('cached_too_many_pages_response');
                    return errorResponse(
                        `PDF has ${preflight.pageCount} pages, which exceeds the ${preflight.maxPageCount}-page limit.`,
                        'too_many_pages',
                    );
            }
        }

        // 6. Read the PDF data
        let pdfData: Uint8Array;
        try {
            pdfData = await loadPdfData(zoteroItem, effectiveFilePath, isRemoteOnly);
            loadedPdfData = pdfData;
            throwIfTimedOut('pdf_data_load_for_search');
        } catch (error) {
            if (!isRemoteOnly) throw error; // local I/O error — let outer handler deal with it
            logger(`handleZoteroAttachmentSearchRequest: Remote download failed: ${error}`, 1);
            throwIfTimedOut('remote_download_failed_response');
            return errorResponse(
                `Failed to download PDF from remote storage: ${error instanceof Error ? error.message : String(error)}`,
                'download_failed'
            );
        }
        if (isRemoteOnly) {
            const exceeded = checkRemotePdfSize(pdfData, false, maxFileSizeMB);
            if (exceeded) {
                throwIfTimedOut('remote_file_too_large_response');
                return errorResponse(
                    `PDF file size of ${exceeded.sizeMB.toFixed(1)}MB exceeds the ${exceeded.maxMB}MB limit.`,
                    'file_too_large'
                );
            }
        }

        // 7. Search — pageCount + maxPageCount gate are pushed into the worker.
        // Cold-cache path goes from 2 doc-opens (getPageCount + search) → 1.
        // The cache fast-path above (lines 157-165) already covers the
        // `cachedMeta.page_count > maxPageCount` case before any worker call.
        const extractor = new BeaverExtractor();
        const maxPageCount = effectiveMaxPageCount();
        const searchResult = await extractor.search(
            pdfData,
            query,
            { maxHitsPerPage: max_hits_per_page ?? 100, maxPageCount },
            signal,
        );
        throwIfTimedOut('pdf_search');

        // 8. Worker page-count gate fired? Map to too_many_pages.
        if (searchResult.exceedsPageCountLimit) {
            logger(
                `handleZoteroAttachmentSearchRequest: worker exceedsPageCountLimit for ${unique_key} (${searchResult.totalPages} pages)`,
                3,
            );
            throwIfTimedOut('too_many_pages_response');
            return errorResponse(
                `PDF has ${searchResult.totalPages} pages, which exceeds the ${maxPageCount}-page limit.`,
                'too_many_pages'
            );
        }

        totalPages = searchResult.totalPages;

        // 9. Convert to response format
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

        throwIfTimedOut('success_response');
        return {
            type: 'zotero_attachment_search',
            request_id,
            attachment: responseAttachment,
            query,
            total_matches: searchResult.totalMatches,
            pages_with_matches: searchResult.pagesWithMatches,
            total_pages: totalPages,
            pages,
        };

    } catch (error) {
        if (
            signal.aborted
            || error instanceof WorkerAbortError
            || error instanceof TimeoutError
            || isWorkerDeadlineError(error)
        ) {
            logger(`handleZoteroAttachmentSearchRequest: Timed out after ${timeoutSeconds}s`, 1);
            return errorResponse(
                `PDF search timed out after ${timeoutSeconds} seconds`,
                'timeout',
                totalPages,
            );
        }

        logger(`handleZoteroAttachmentSearchRequest: Search failed: ${error}`, 1);

        // Handle known extraction errors
        if (error instanceof ExtractionError) {
            if (resolvedItem && resolvedFilePath && (error.code === ExtractionErrorCode.ENCRYPTED || error.code === ExtractionErrorCode.INVALID_PDF || error.code === ExtractionErrorCode.NO_TEXT_LAYER)) {
                const cache = Zotero.Beaver?.documentCache;
                const errorCode = error.code === ExtractionErrorCode.ENCRYPTED
                    ? 'encrypted'
                    : error.code === ExtractionErrorCode.INVALID_PDF
                        ? 'invalid_pdf'
                        : 'no_text_layer';
                await cache?.putErrorMetadata({
                    item: resolvedItem,
                    filePath: resolvedFilePath,
                    sourceSizeBytes: loadedPdfData?.byteLength ?? 0,
                    contentType: resolvedItem.attachmentContentType || 'application/pdf',
                    errorCode,
                    pageCount: error.code === ExtractionErrorCode.NO_TEXT_LAYER
                        ? error.pageCount ?? totalPages
                        : null,
                    pageLabels: error.code === ExtractionErrorCode.NO_TEXT_LAYER
                        ? error.pageLabels ?? null
                        : null,
                    pages: null,
                });
            }

            switch (error.code) {
                case ExtractionErrorCode.ENCRYPTED:
                    return errorResponse('PDF is password-protected', 'encrypted');
                case ExtractionErrorCode.INVALID_PDF:
                    return errorResponse('PDF file is invalid or corrupted', 'invalid_pdf');
                case ExtractionErrorCode.EMPTY_DOCUMENT:
                    return errorResponse('PDF has no readable pages (it may be empty or corrupted)', 'empty_document');
                case ExtractionErrorCode.NO_TEXT_LAYER:
                    // Note: dead branch: opSearch does not run
                    // OCR detection. Kept as cheap insurance against future
                    // refactor that adds checkTextLayer to the search path.
                    return errorResponse('PDF requires OCR (no text layer) — text search unavailable', 'no_text_layer');
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
    } finally {
        dispose();
    }
}
