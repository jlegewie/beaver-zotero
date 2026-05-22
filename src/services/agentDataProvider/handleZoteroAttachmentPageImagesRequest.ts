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
import { BeaverExtractor, ExtractionError, ExtractionErrorCode, WorkerAbortError } from '../../beaver-extract';
import { makeRemoteFilePath } from '../attachmentFileCache';
import {
    resolveToPdfAttachment,
    validateZoteroItemReference,
    backfillMetadataForError,
    loadPdfData,
    checkRemotePdfSize,
    isRemoteAccessAvailable,
    preflightCachedPdfMeta,
} from './utils';
import { ensurePageLabelsForResolution, resolvePageValue, InvalidPageValueError } from './pageLabelResolution';
import {
    DEFAULT_IMAGES_TIMEOUT_SECONDS,
    TimeoutError,
    createTimeoutController,
} from './timeout';

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
    const { attachment, pages, scale, dpi, format, jpeg_quality, skip_local_limits, prefer_page_labels, request_id, timeout_seconds } = request;
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

    const timeout = createTimeoutController(timeout_seconds, DEFAULT_IMAGES_TIMEOUT_SECONDS);
    const { signal, timeoutSeconds, throwIfTimedOut, dispose } = timeout;

    try {
        // 1. Get the attachment item from Zotero
        const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(
            attachment.library_id,
            attachment.zotero_key
        );
        throwIfTimedOut('zotero_item_lookup');

        if (!zoteroItem) {
            throwIfTimedOut('not_found_response');
            return errorResponse(
                `Attachment does not exist in user's library: ${requestKey}`,
                'not_found'
            );
        }

        await zoteroItem.loadAllData();
        throwIfTimedOut('zotero_item_load');

        // 2. Resolve to a PDF attachment (auto-resolves regular items with one PDF)
        const resolveResult = await resolveToPdfAttachment(zoteroItem, requestKey);
        throwIfTimedOut('pdf_attachment_resolution');
        if (!resolveResult.resolved) {
            throwIfTimedOut('pdf_attachment_resolution_response');
            return errorResponse(resolveResult.error, resolveResult.error_code);
        }
        const { item: pdfItem, key: pdfKey } = resolveResult;
        errorKey = pdfKey;
        resolvedPdfItem = pdfItem;

        // 3. Get the file path — returns false if missing or nonexistent
        const rawFilePath = await pdfItem.getFilePathAsync();
        throwIfTimedOut('file_path_lookup');
        const filePath = rawFilePath || null;  // normalize false → null
        const isRemoteOnly = !filePath && isRemoteAccessAvailable(pdfItem);
        const effectiveFilePath = filePath || (isRemoteOnly ? makeRemoteFilePath(pdfItem) : null);
        resolvedFilePath = effectiveFilePath;

        if (!effectiveFilePath) {
            const onServer = isAttachmentAvailableRemotely(pdfItem);
            throwIfTimedOut('file_missing_response');
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
            throwIfTimedOut('file_size_check');

            if (fileSize) {
                const fileSizeInMB = fileSize / 1024 / 1024;
                if (fileSizeInMB > maxFileSizeMB) {
                    throwIfTimedOut('file_too_large_response');
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
        throwIfTimedOut('metadata_cache_lookup');
        resolvedCachedPageCount = cachedMeta?.page_count ?? null;

        // Determine once whether this is an all-pages request
        const requestingAllPages = !pages || pages.length === 0;

        // Image rendering does not require a text layer, so checkOcr is false.
        const preflight = preflightCachedPdfMeta(cachedMeta, {
            checkOcr: false,
            applyPageCountCap: !skip_local_limits && requestingAllPages,
            maxPageCount: getPref('maxPageCount'),
        });
        if (preflight) {
            switch (preflight.code) {
                case 'encrypted':
                    throwIfTimedOut('cached_encrypted_response');
                    return errorResponse(`The PDF file for ${pdfKey} is password-protected`, 'encrypted');
                case 'invalid_pdf':
                    throwIfTimedOut('cached_invalid_pdf_response');
                    return errorResponse(`The PDF file for ${pdfKey} is invalid or corrupted`, 'invalid_pdf');
                case 'too_many_pages':
                    throwIfTimedOut('cached_too_many_pages_response');
                    return errorResponse(
                        `The PDF file for ${pdfKey} has ${preflight.pageCount} pages, which exceeds the ${preflight.maxPageCount}-page limit`,
                        'too_many_pages',
                    );
                // 'no_text_layer' cannot occur here (checkOcr: false). Any future
                // change to checkOcr must add a branch.
            }
        }

        // 5. Resolve page labels and (only if needed) page count up-front.
        const extractor = new BeaverExtractor();
        let pdfData: Uint8Array | null = null;
        let pageLabels: Record<number, string> | null = null;
        let totalPages: number | null = null;

        // 5a. Load page labels for label-aware resolution. Short-circuits on cache.
        if (prefer_page_labels && filePath) {
            const labelResult = await ensurePageLabelsForResolution(filePath, cachedMeta, extractor, signal);
            throwIfTimedOut('page_label_resolution');
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
        // pageCount back inside `renderPages`.
        const needsUpfrontPageCount =
            totalPages == null && requestingAllPages && !skip_local_limits;
        if (needsUpfrontPageCount) {
            if (!pdfData) {
                try {
                    pdfData = await loadPdfData(pdfItem, effectiveFilePath, isRemoteOnly);
                    throwIfTimedOut('pdf_data_load_for_page_count');
                } catch (error) {
                    if (!isRemoteOnly) throw error;
                    logger(`handleZoteroAttachmentPageImagesRequest: Remote download failed: ${error}`, 1);
                    throwIfTimedOut('remote_download_failed_response');
                    return errorResponse(
                        `Failed to download PDF for ${pdfKey} from remote storage: ${error instanceof Error ? error.message : String(error)}`,
                        'download_failed'
                    );
                }
                if (isRemoteOnly) {
                    const exceeded = checkRemotePdfSize(pdfData, skip_local_limits);
                    if (exceeded) {
                        throwIfTimedOut('remote_file_too_large_response');
                        return errorResponse(
                            `The PDF file for ${pdfKey} has a file size of ${exceeded.sizeMB.toFixed(1)}MB, which exceeds the ${exceeded.maxMB}MB limit`,
                            'file_too_large'
                        );
                    }
                }
            }
            totalPages = await extractor.getPageCount(pdfData, signal);
            throwIfTimedOut('page_count_extraction');
        }

        // 6. Check page count limit for all-pages requests when totalPages known.
        if (!skip_local_limits && requestingAllPages && totalPages != null) {
            const maxPageCount = getPref('maxPageCount');
            if (totalPages > maxPageCount) {
                throwIfTimedOut('too_many_pages_response');
                return errorResponse(
                    `The PDF file for ${pdfKey} has ${totalPages} pages, which exceeds the ${maxPageCount}-page limit`,
                    'too_many_pages'
                );
            }
        }

        // 6b. A document that opened but resolves to zero pages is empty or
        // structurally corrupt. Classify it here — before page resolution —
        // so a specific-page request does not fall through to the bounds
        // pre-filter below and surface a misleading `page_out_of_range`.
        if (totalPages === 0) {
            throwIfTimedOut('empty_document_response');
            return errorResponse(
                `The PDF file for ${pdfKey} has no readable pages (it may be empty or corrupted)`,
                'empty_document',
                0,
            );
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
                    throwIfTimedOut('invalid_page_value_response');
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
                throwIfTimedOut('pdf_data_load_for_render');
            } catch (error) {
                if (!isRemoteOnly) throw error;
                logger(`handleZoteroAttachmentPageImagesRequest: Remote download failed: ${error}`, 1);
                throwIfTimedOut('remote_download_failed_response');
                return errorResponse(
                    `Failed to download PDF for ${pdfKey} from remote storage: ${error instanceof Error ? error.message : String(error)}`,
                    'download_failed'
                );
            }
            if (isRemoteOnly) {
                const exceeded = checkRemotePdfSize(pdfData, skip_local_limits);
                if (exceeded) {
                    throwIfTimedOut('remote_file_too_large_response');
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
            `handleZoteroAttachmentPageImagesRequest: renderPages for ${requestKey} `
            + `pageIndices=${JSON.stringify(pageIndicesArg ?? null)} (allPages=${requestingAllPages})`,
            3,
        );
        const renderResult = await extractor.renderPages(pdfData, {
            pageIndices: pageIndicesArg,
            options: renderOptions,
        }, signal);
        throwIfTimedOut('pdf_render');

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

        // The image-render path deliberately does NOT write metadata to the
        // cache. Rendering proves the PDF opens, but it never inspects the
        // text layer.

        throwIfTimedOut('success_response');
        return {
            type: 'zotero_attachment_page_images',
            request_id,
            attachment,
            pages: pageImages,
            total_pages: renderResult.pageCount,
        };

    } catch (error) {
        if (signal.aborted || error instanceof WorkerAbortError || error instanceof TimeoutError) {
            logger(`handleZoteroAttachmentPageImagesRequest: Timed out after ${timeoutSeconds}s`, 1);
            return errorResponse(
                `PDF page rendering timed out after ${timeoutSeconds} seconds`,
                'timeout',
                resolvedCachedPageCount,
            );
        }

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
                case ExtractionErrorCode.EMPTY_DOCUMENT:
                    return errorResponse(
                        `The PDF file for ${errorKey} has no readable pages (it may be empty or corrupted)`,
                        'empty_document',
                        totalPagesForError
                    );
                case ExtractionErrorCode.PAGE_OUT_OF_RANGE:
                    return errorResponse(error.message, 'page_out_of_range', totalPagesForError);
                case ExtractionErrorCode.WASM_ERROR:
                    return errorResponse(
                        `The PDF file for ${errorKey} crashes the PDF parser and cannot be rendered`,
                        'pdf_parser_crash',
                        totalPagesForError
                    );
                case ExtractionErrorCode.HEAP_EXHAUSTION:
                    return errorResponse(
                        `The PDF file for ${errorKey} is too large or complex to process and exhausted the parser's memory`,
                        'pdf_too_complex',
                        totalPagesForError
                    );
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
    } finally {
        dispose();
    }
}
