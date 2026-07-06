/**
 * Agent Data Provider — unified view-images requests (`view` tool).
 *
 * Resolves the requested reference to a PDF or image attachment and
 * dispatches internally: PDF attachments render the requested page range via
 * the page-images handler; image attachments are served via the
 * attachment-image handler. The response always carries a list of images
 * (length 1 for image attachments).
 */

import { logger } from '../../utils/logger';
import {
    WSZoteroViewImagesRequest,
    WSZoteroViewImagesResponse,
    WSViewImage,
    ViewImagesErrorCode,
} from '../agentProtocol';
import { ZoteroItemReference, ItemStub, AttachmentStub } from '../../../react/types/zotero';
import { libraryRefForLibraryID, resolveLibraryRef } from '../../utils/libraryIdentity';
import {
    getReadableContentKind,
    resolveToImageAttachment,
    resolveToPdfAttachment,
} from '../documentExtraction/attachmentResolution';
import { isLinkedUrlAttachment } from '../../utils/attachmentFiles';
import { checkLibraryExcluded, validateZoteroItemReference } from './utils';
import { handleZoteroAttachmentPageImagesRequest } from './handleZoteroAttachmentPageImagesRequest';
import { handleZoteroAttachmentImageRequest } from './handleZoteroAttachmentImageRequest';
import { resolveExternalFile } from '../externalFiles';
import {
    externalFileMissingMessage,
    getResolvedAttachmentParentStub,
    buildServedAttachmentStub,
} from './handleZoteroDocumentRequest';
import { BeaverExtractor, ExtractionError, ExtractionErrorCode, WorkerAbortError } from '../../beaver-extract';
import { effectiveMaxFileSizeMB, effectiveMaxPageCount } from '../attachmentLimits';
import {
    DEFAULT_IMAGES_TIMEOUT_SECONDS,
    TimeoutError,
    createTimeoutController,
} from './timeout';
import {
    DEFAULT_MAX_IMAGE_DIMENSION,
    HARD_MAX_IMAGE_DIMENSION,
    ImageDecodeError,
    MAX_OUTPUT_IMAGE_BYTES,
    UnsupportedImageFormatError,
    processImageBytes,
    uint8ToBase64,
} from './imageProcessing';

/** Parse a requested dimension: positive finite number clamped to the hard cap. */
function effectiveMaxDimension(requested: number | null | undefined): number {
    const parsed =
        typeof requested === 'number' && Number.isFinite(requested) && requested > 0
            ? Math.floor(requested)
            : DEFAULT_MAX_IMAGE_DIMENSION;
    return Math.min(parsed, HARD_MAX_IMAGE_DIMENSION);
}

/**
 * Hard cap on the number of pages a single view request may render. The
 * backend clamps the `view` tool to its own (smaller) per-call limit before
 * sending; this guards the UI process against malformed or hostile ranges
 * (e.g. pages 1-100000000) that would otherwise be materialized into an
 * array before the renderer's own limits run.
 */
const HARD_MAX_VIEW_PAGES = 50;

/** Result of resolving the view target to a concrete attachment + kind. */
type ViewTargetResolution =
    | { resolved: true; kind: 'pdf' | 'image'; item: Zotero.Item }
    | { resolved: false; error: string; error_code: ViewImagesErrorCode };

/**
 * Resolve the requested reference to a PDF or image attachment.
 *
 * Direct attachments dispatch on their own content kind. Regular (parent)
 * items prefer PDF children; the image resolver only runs when the item has
 * NO PDF attachments at all, so actionable PDF-resolution errors (e.g.
 * "multiple PDF attachments — pick one") are never swallowed by a downstream
 * "no image attachments" error.
 */
async function resolveViewTarget(
    item: Zotero.Item,
    requestKey: string,
): Promise<ViewTargetResolution> {
    if (item.isAttachment()) {
        const contentKind = getReadableContentKind(item);
        if (contentKind === 'pdf') {
            const result = await resolveToPdfAttachment(item, requestKey);
            if (!result.resolved) return result;
            return { resolved: true, kind: 'pdf', item: result.item };
        }
        if (contentKind === 'image') {
            const result = await resolveToImageAttachment(item, requestKey);
            if (!result.resolved) return result;
            return { resolved: true, kind: 'image', item: result.item };
        }
        // Linked URLs are rejected with their specific code; everything else
        // (EPUB, text, snapshot, Word, ...) is not viewable.
        if (item.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL) {
            return {
                resolved: false,
                error: `Attachment ${requestKey} is a linked URL, not a stored file. Beaver cannot access linked URL attachments.`,
                error_code: 'is_linked_url',
            };
        }
        const contentType = item.attachmentContentType || 'unknown';
        return {
            resolved: false,
            error: `Attachment ${requestKey} is neither a PDF nor an image (type: ${contentType}).`,
            error_code: 'unsupported_type',
        };
    }

    if (item.isRegularItem()) {
        await Zotero.Items.loadDataTypes([item], ['childItems']);
        const ids = item.getAttachments();
        const fetched = ids?.length ? await Zotero.Items.getAsync(ids) : [];
        const children = fetched.filter((a): a is Zotero.Item => !!a && !a.deleted);
        if (children.length > 0) {
            await Zotero.Items.loadDataTypes(children, ['itemData']);
        }
        const hasPdf = children.some((a) => a.isPDFAttachment());
        // Mirror resolveToImageAttachment's filter (linked URLs excluded) so
        // the pre-scan and the resolver agree on which children count.
        const hasImage = children.some(
            (a) => !isLinkedUrlAttachment(a) && getReadableContentKind(a) === 'image',
        );

        if (hasPdf) {
            // Single PDF resolves; multiple PDFs return the actionable
            // "pick a specific attachment" error from the PDF resolver.
            const result = await resolveToPdfAttachment(item, requestKey);
            if (!result.resolved) return result;
            return { resolved: true, kind: 'pdf', item: result.item };
        }
        if (hasImage) {
            const result = await resolveToImageAttachment(item, requestKey);
            if (!result.resolved) return result;
            return { resolved: true, kind: 'image', item: result.item };
        }
        return {
            resolved: false,
            error: `The id '${requestKey}' is a regular item with no PDF or image attachments.`,
            error_code: 'unsupported_type',
        };
    }

    const kind = item.isNote() ? 'note' : item.isAnnotation() ? 'annotation' : 'non-attachment item';
    return {
        resolved: false,
        error: `The id '${requestKey}' is a ${kind}, not an attachment.`,
        error_code: 'not_attachment',
    };
}

/**
 * Handle zotero_view_images_request event.
 */
export async function handleZoteroViewImagesRequest(
    request: WSZoteroViewImagesRequest
): Promise<WSZoteroViewImagesResponse> {
    const {
        attachment,
        external_file_key,
        start_page,
        end_page,
        dpi,
        max_width,
        max_height,
        format,
        jpeg_quality,
        skip_local_limits,
        request_id,
        timeout_seconds,
    } = request;

    // External files are handled before any Zotero item resolution: the
    // request carries an external file key instead of an attachment reference.
    if (external_file_key) {
        return handleExternalFileViewRequest(request, external_file_key);
    }

    if (!attachment) {
        return {
            type: 'zotero_view_images',
            request_id,
            attachment: null,
            kind: null,
            images: [],
            total_pages: null,
            error: 'View request carries neither an attachment reference nor an external file key.',
            error_code: 'invalid_format',
        };
    }
    const responseAttachment = {
        ...attachment,
        library_ref: attachment.library_ref ?? libraryRefForLibraryID(attachment.library_id) ?? undefined,
    };
    const requestKey = `${attachment.library_id}-${attachment.zotero_key}`;

    // Captured once the target attachment is resolved so error responses can
    // report which child was actually targeted and carry the same view-row
    // metadata as success responses (best-effort: pre-resolution errors leave
    // these null and omit them).
    let resolvedRef: ZoteroItemReference | null = null;
    let resolvedKind: 'pdf' | 'image' | null = null;
    let parentItem: ItemStub | null = null;
    let servedAttachment: AttachmentStub | null = null;

    const errorResponse = (
        error: string,
        error_code: ViewImagesErrorCode,
        total_pages: number | null = null,
    ): WSZoteroViewImagesResponse => ({
        type: 'zotero_view_images',
        request_id,
        attachment: responseAttachment,
        resolved_attachment: resolvedRef,
        kind: resolvedKind,
        images: [],
        total_pages,
        ...(parentItem ? { parent_item: parentItem } : {}),
        ...(servedAttachment ? { served_attachment: servedAttachment } : {}),
        error,
        error_code,
    });

    // 0. Validate request shape
    const formatError = validateZoteroItemReference(attachment);
    if (formatError) {
        return errorResponse(
            `Invalid attachment reference '${requestKey}': ${formatError}`,
            'invalid_format'
        );
    }
    const resolvedLibraryId = resolveLibraryRef(attachment);
    if (!resolvedLibraryId) {
        return errorResponse(
            "Attachment is in a library that isn't available on this computer.",
            'library_unavailable'
        );
    }
    const excluded = checkLibraryExcluded(resolvedLibraryId);
    if (excluded) {
        return errorResponse(excluded.message, 'library_excluded');
    }
    if (start_page != null && (!Number.isInteger(start_page) || start_page < 1)) {
        return errorResponse(
            `Invalid start_page '${start_page}': must be a positive integer`,
            'invalid_page_value'
        );
    }
    if (end_page != null && (!Number.isInteger(end_page) || end_page < 1)) {
        return errorResponse(
            `Invalid end_page '${end_page}': must be a positive integer`,
            'invalid_page_value'
        );
    }
    // Normalize the range (defaults: first page only), then validate it so a
    // malformed request can never expand into an unbounded page array below.
    // Ignored for image attachments.
    const startPage = start_page ?? 1;
    const endPage = end_page ?? startPage;
    if (endPage < startPage) {
        return errorResponse(
            `Invalid page range: end_page (${endPage}) must be greater than or equal to start_page (${startPage})`,
            'invalid_page_value'
        );
    }
    if (endPage - startPage + 1 > HARD_MAX_VIEW_PAGES) {
        return errorResponse(
            `Requested page range ${startPage}-${endPage} spans ${endPage - startPage + 1} pages, `
            + `which exceeds the ${HARD_MAX_VIEW_PAGES}-page limit per request.`,
            'invalid_page_value'
        );
    }

    try {
        const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(
            resolvedLibraryId,
            attachment.zotero_key
        );
        if (!zoteroItem) {
            return errorResponse(
                `Attachment does not exist in user's library: ${requestKey}`,
                'not_found'
            );
        }
        await zoteroItem.loadAllData();

        // 2. Resolve to a PDF or image attachment
        const target = await resolveViewTarget(zoteroItem, requestKey);
        if (!target.resolved) {
            return errorResponse(target.error, target.error_code);
        }
        resolvedKind = target.kind;
        const targetRef: ZoteroItemReference = {
            library_id: target.item.libraryID,
            zotero_key: target.item.key,
            library_ref: libraryRefForLibraryID(target.item.libraryID) ?? undefined,
        };
        if (
            targetRef.library_id !== attachment.library_id
            || targetRef.zotero_key !== attachment.zotero_key
        ) {
            resolvedRef = targetRef;
        }

        // View-row metadata for the backend tool-result view (parent-centric
        // display + the served file's own name/content_kind). Both are optional;
        // a failure here must never fail the view itself, and both ride on
        // post-resolution error responses too. Build the served-file stub first
        // (synchronous, no file analysis) so it is present even if the parent
        // lookup throws.
        try {
            servedAttachment = buildServedAttachmentStub(target.item, target.kind);
        } catch (error) {
            logger(`handleZoteroViewImagesRequest: served attachment stub failed for ${requestKey}: ${error}`, 1);
        }
        try {
            parentItem = await getResolvedAttachmentParentStub(target.item);
        } catch (error) {
            logger(`handleZoteroViewImagesRequest: parent stub failed for ${requestKey}: ${error}`, 1);
        }

        // 3. Dispatch by kind
        if (target.kind === 'pdf') {
            // Inverted and oversized ranges were rejected in step 0, so this
            // expansion is bounded by HARD_MAX_VIEW_PAGES entries.
            const pages: number[] = [];
            for (let p = startPage; p <= endPage; p++) pages.push(p);

            const pdfResponse = await handleZoteroAttachmentPageImagesRequest({
                event: 'zotero_attachment_page_images_request',
                request_id,
                attachment: targetRef,
                pages,
                dpi: dpi ?? undefined,
                format: format === 'jpeg' ? 'jpeg' : 'png',
                jpeg_quality: jpeg_quality ?? undefined,
                skip_local_limits: skip_local_limits ?? false,
                timeout_seconds,
            });

            if (pdfResponse.error) {
                return errorResponse(
                    pdfResponse.error,
                    pdfResponse.error_code ?? 'render_failed',
                    pdfResponse.total_pages,
                );
            }

            const images: WSViewImage[] = pdfResponse.pages.map((page) => ({
                image_data: page.image_data,
                format: page.format,
                width: page.width,
                height: page.height,
                page_number: page.page_number,
                page_label: page.page_label ?? null,
            }));

            return {
                type: 'zotero_view_images',
                request_id,
                attachment: responseAttachment,
                resolved_attachment: resolvedRef,
                kind: 'pdf',
                images,
                total_pages: pdfResponse.total_pages,
                ...(parentItem ? { parent_item: parentItem } : {}),
                ...(servedAttachment ? { served_attachment: servedAttachment } : {}),
            };
        }

        // Image attachment path
        const imageResponse = await handleZoteroAttachmentImageRequest({
            event: 'zotero_attachment_image_request',
            request_id,
            attachment: targetRef,
            max_width: max_width ?? undefined,
            max_height: max_height ?? undefined,
            format: format ?? 'auto',
            jpeg_quality: jpeg_quality ?? undefined,
            timeout_seconds,
        });

        if (imageResponse.error || !imageResponse.image) {
            return errorResponse(
                imageResponse.error ?? `Failed to process image for ${requestKey}.`,
                imageResponse.error_code ?? 'image_processing_failed',
            );
        }

        return {
            type: 'zotero_view_images',
            request_id,
            attachment: responseAttachment,
            resolved_attachment: resolvedRef,
            kind: 'image',
            images: [{
                image_data: imageResponse.image.image_data,
                format: imageResponse.image.format,
                width: imageResponse.image.width,
                height: imageResponse.image.height,
            }],
            total_pages: null,
            ...(parentItem ? { parent_item: parentItem } : {}),
            ...(servedAttachment ? { served_attachment: servedAttachment } : {}),
        };

    } catch (error) {
        logger(`handleZoteroViewImagesRequest: Failed: ${error}`, 1);
        return errorResponse(
            `Failed to retrieve images for ${requestKey}: ${error instanceof Error ? error.message : String(error)}`,
            'view_failed'
        );
    }
}

/**
 * Serve a view request for a user-attached external file. The registry
 * resolves the key to the managed copy; images are converted directly and
 * PDFs render through the MuPDF worker. EPUB and text files are not viewable.
 */
async function handleExternalFileViewRequest(
    request: WSZoteroViewImagesRequest,
    extKey: string,
): Promise<WSZoteroViewImagesResponse> {
    const {
        start_page,
        end_page,
        dpi,
        max_width,
        max_height,
        format,
        jpeg_quality,
        request_id,
        timeout_seconds,
    } = request;
    const requestKey = `ext-${extKey}`;

    let resolvedKind: 'pdf' | 'image' | null = null;
    // Populated once the registry resolves the key so post-resolution error
    // responses carry the served-file stub. External files carry no Zotero parent.
    let servedExternal: AttachmentStub | null = null;

    const errorResponse = (
        error: string,
        error_code: ViewImagesErrorCode,
        total_pages: number | null = null,
    ): WSZoteroViewImagesResponse => ({
        type: 'zotero_view_images',
        request_id,
        external_file_key: extKey,
        kind: resolvedKind,
        images: [],
        total_pages,
        ...(servedExternal ? { served_attachment: servedExternal } : {}),
        error,
        error_code,
    });

    // Page-range validation (mirrors the Zotero path).
    if (start_page != null && (!Number.isInteger(start_page) || start_page < 1)) {
        return errorResponse(`Invalid start_page '${start_page}': must be a positive integer`, 'invalid_page_value');
    }
    if (end_page != null && (!Number.isInteger(end_page) || end_page < 1)) {
        return errorResponse(`Invalid end_page '${end_page}': must be a positive integer`, 'invalid_page_value');
    }
    const startPage = start_page ?? 1;
    const endPage = end_page ?? startPage;
    if (endPage < startPage) {
        return errorResponse(
            `Invalid page range: end_page (${endPage}) must be greater than or equal to start_page (${startPage})`,
            'invalid_page_value',
        );
    }
    if (endPage - startPage + 1 > HARD_MAX_VIEW_PAGES) {
        return errorResponse(
            `Requested page range ${startPage}-${endPage} spans ${endPage - startPage + 1} pages, `
            + `which exceeds the ${HARD_MAX_VIEW_PAGES}-page limit per request.`,
            'invalid_page_value',
        );
    }

    const resolved = await resolveExternalFile(extKey);
    if (!resolved.ok) {
        return errorResponse(externalFileMissingMessage(extKey, resolved.record), 'file_missing');
    }
    const record = resolved.record;

    // The served external file's own display metadata, for the backend
    // tool-result view row (mirrors the Zotero `served_attachment`). Uses the
    // model-facing `ext-<key>` id; external files carry no Zotero parent, so no
    // `parent_item` is emitted. Built before the unsupported-type check so that
    // error carries it too.
    servedExternal = {
        attachment_id: `ext-${extKey}`,
        parent_item_id: null,
        title: null,
        filename: record.filename,
        content_kind: record.contentKind,
    };

    if (record.contentKind === 'epub' || record.contentKind === 'text') {
        return errorResponse(
            `External file '${requestKey}' ('${record.filename}') is a ${record.contentKind} document, which is not viewable. Use the read tool instead.`,
            'unsupported_type',
        );
    }

    const timeout = createTimeoutController(timeout_seconds, DEFAULT_IMAGES_TIMEOUT_SECONDS);
    const { signal, timeoutSeconds, throwIfTimedOut, dispose } = timeout;

    try {
        // Size check against the hard cap (the copy is always local).
        const maxFileSizeMB = effectiveMaxFileSizeMB();
        if (record.fileSize > maxFileSizeMB * 1024 * 1024) {
            return errorResponse(
                `The file for ${requestKey} has a file size of ${(record.fileSize / 1024 / 1024).toFixed(1)}MB, which exceeds the ${maxFileSizeMB}MB limit.`,
                'file_too_large',
            );
        }

        let fileBytes: Uint8Array;
        try {
            fileBytes = await IOUtils.read(record.storedPath);
        } catch {
            return errorResponse(externalFileMissingMessage(extKey, record), 'file_missing');
        }
        // Outside the read's catch: a timeout here must surface as 'timeout',
        // not as a missing-file error telling the user to re-attach the file.
        throwIfTimedOut('external_file_read');

        if (record.contentKind === 'image') {
            resolvedKind = 'image';
            let processed;
            try {
                processed = await processImageBytes(fileBytes, record.mimeType, {
                    maxWidth: effectiveMaxDimension(max_width),
                    maxHeight: effectiveMaxDimension(max_height),
                    format: format ?? 'auto',
                    jpegQuality: jpeg_quality ?? 85,
                    maxOutputBytes: MAX_OUTPUT_IMAGE_BYTES,
                    checkpoint: throwIfTimedOut,
                });
            } catch (error) {
                throwIfTimedOut('image_processing_error_response');
                if (error instanceof UnsupportedImageFormatError) {
                    return errorResponse(
                        `The image file for ${requestKey} has format '${error.mimeType}', which Beaver cannot convert.`,
                        'unsupported_image_format',
                    );
                }
                if (error instanceof ImageDecodeError) {
                    return errorResponse(
                        `The image file for ${requestKey} could not be decoded (it may be corrupted): ${error.message}`,
                        'decode_failed',
                    );
                }
                throw error;
            }
            return {
                type: 'zotero_view_images',
                request_id,
                external_file_key: extKey,
                kind: 'image',
                images: [{
                    image_data: uint8ToBase64(processed.data),
                    format: processed.format,
                    width: processed.width,
                    height: processed.height,
                }],
                total_pages: null,
                served_attachment: servedExternal,
            };
        }

        // PDF: render the requested contiguous range via the MuPDF worker.
        resolvedKind = 'pdf';
        const extractor = new BeaverExtractor();
        const totalPages = await extractor.getPageCount(fileBytes, signal);
        throwIfTimedOut('page_count_extraction');
        if (totalPages === 0) {
            return errorResponse(
                `The PDF file for ${requestKey} has no readable pages (it may be empty or corrupted)`,
                'empty_document',
                0,
            );
        }
        // Hard page-count cap, mirroring the Zotero-attachment view path.
        const maxPageCount = effectiveMaxPageCount();
        if (totalPages > maxPageCount) {
            return errorResponse(
                `The PDF file for ${requestKey} has ${totalPages} pages, which exceeds the ${maxPageCount}-page limit.`,
                'too_many_pages',
                totalPages,
            );
        }
        const pageIndices: number[] = [];
        for (let p = startPage; p <= Math.min(endPage, totalPages); p++) pageIndices.push(p - 1);
        if (pageIndices.length === 0) {
            return errorResponse(
                `All requested pages are out of range (document has ${totalPages} pages)`,
                'page_out_of_range',
                totalPages,
            );
        }

        const renderResult = await extractor.renderPages(fileBytes, {
            pageIndices,
            options: {
                scale: 1.0,
                dpi: dpi ?? 0,
                format: format === 'jpeg' ? 'jpeg' : 'png',
                jpegQuality: jpeg_quality ?? 85,
            },
        }, signal);
        throwIfTimedOut('pdf_render');

        const pageLabels = renderResult.pageLabels ?? {};
        const images: WSViewImage[] = renderResult.pages.map((page) => ({
            image_data: uint8ToBase64(page.data),
            format: page.format,
            width: page.width,
            height: page.height,
            page_number: page.pageIndex + 1,
            page_label: pageLabels[page.pageIndex] ?? null,
        }));

        return {
            type: 'zotero_view_images',
            request_id,
            external_file_key: extKey,
            kind: 'pdf',
            images,
            total_pages: renderResult.pageCount,
            served_attachment: servedExternal,
        };
    } catch (error) {
        if (signal.aborted || error instanceof WorkerAbortError || error instanceof TimeoutError) {
            return errorResponse(`Rendering timed out after ${timeoutSeconds} seconds`, 'timeout');
        }
        if (error instanceof ExtractionError) {
            switch (error.code) {
                case ExtractionErrorCode.ENCRYPTED:
                    return errorResponse(`The PDF file for ${requestKey} is password-protected`, 'encrypted');
                case ExtractionErrorCode.INVALID_PDF:
                    return errorResponse(`The PDF file for ${requestKey} is invalid or corrupted`, 'invalid_pdf');
                case ExtractionErrorCode.EMPTY_DOCUMENT:
                    return errorResponse(
                        `The PDF file for ${requestKey} has no readable pages (it may be empty or corrupted)`,
                        'empty_document',
                        error.pageCount ?? null,
                    );
                case ExtractionErrorCode.PAGE_OUT_OF_RANGE:
                    return errorResponse(error.message, 'page_out_of_range', error.pageCount ?? null);
                case ExtractionErrorCode.WASM_ERROR:
                    return errorResponse(
                        `The PDF file for ${requestKey} crashes the PDF parser and cannot be rendered`,
                        'pdf_parser_crash',
                        error.pageCount ?? null,
                    );
                case ExtractionErrorCode.HEAP_EXHAUSTION:
                    return errorResponse(
                        `The PDF file for ${requestKey} is too large or complex to process and exhausted the parser's memory`,
                        'pdf_too_complex',
                        error.pageCount ?? null,
                    );
                default:
                    return errorResponse(`Failed to render images for ${requestKey}: ${error.message}`, 'render_failed');
            }
        }
        logger(`handleExternalFileViewRequest: Failed: ${error}`, 1);
        return errorResponse(
            `Failed to retrieve images for ${requestKey}: ${error instanceof Error ? error.message : String(error)}`,
            'view_failed',
        );
    } finally {
        dispose();
    }
}
