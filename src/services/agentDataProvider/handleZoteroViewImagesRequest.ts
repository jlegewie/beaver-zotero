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
import { ZoteroItemReference } from '../../../react/types/zotero';
import {
    getReadableContentKind,
    resolveToImageAttachment,
    resolveToPdfAttachment,
} from '../documentExtraction/attachmentResolution';
import { validateZoteroItemReference } from './utils';
import { handleZoteroAttachmentPageImagesRequest } from './handleZoteroAttachmentPageImagesRequest';
import { handleZoteroAttachmentImageRequest } from './handleZoteroAttachmentImageRequest';

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
        const hasImage = children.some((a) => getReadableContentKind(a) === 'image');

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
    const requestKey = `${attachment.library_id}-${attachment.zotero_key}`;

    // Captured once the target attachment is resolved so error responses can
    // report which child was actually targeted.
    let resolvedRef: ZoteroItemReference | null = null;
    let resolvedKind: 'pdf' | 'image' | null = null;

    const errorResponse = (
        error: string,
        error_code: ViewImagesErrorCode,
        total_pages: number | null = null,
    ): WSZoteroViewImagesResponse => ({
        type: 'zotero_view_images',
        request_id,
        attachment,
        resolved_attachment: resolvedRef,
        kind: resolvedKind,
        images: [],
        total_pages,
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
        // 1. Look up the requested item
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

        // 2. Resolve to a PDF or image attachment
        const target = await resolveViewTarget(zoteroItem, requestKey);
        if (!target.resolved) {
            return errorResponse(target.error, target.error_code);
        }
        resolvedKind = target.kind;
        const targetRef: ZoteroItemReference = {
            library_id: target.item.libraryID,
            zotero_key: target.item.key,
        };
        if (
            targetRef.library_id !== attachment.library_id
            || targetRef.zotero_key !== attachment.zotero_key
        ) {
            resolvedRef = targetRef;
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
                attachment,
                resolved_attachment: resolvedRef,
                kind: 'pdf',
                images,
                total_pages: pdfResponse.total_pages,
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
            attachment,
            resolved_attachment: resolvedRef,
            kind: 'image',
            images: [{
                image_data: imageResponse.image.image_data,
                format: imageResponse.image.format,
                width: imageResponse.image.width,
                height: imageResponse.image.height,
            }],
            total_pages: null,
        };

    } catch (error) {
        logger(`handleZoteroViewImagesRequest: Failed: ${error}`, 1);
        return errorResponse(
            `Failed to retrieve images for ${requestKey}: ${error instanceof Error ? error.message : String(error)}`,
            'view_failed'
        );
    }
}
