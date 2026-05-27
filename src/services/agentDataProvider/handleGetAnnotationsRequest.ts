/**
 * Handle get_annotations requests from the backend.
 */

import { logger } from '../../utils/logger';
import { serializeAnnotation } from '../../utils/zoteroSerializers';
import {
    WSGetAnnotationsRequest,
    WSGetAnnotationsResponse,
} from '../agentProtocol';


function invalidResponse(
    request: WSGetAnnotationsRequest,
    error: string,
    errorCode: string,
): WSGetAnnotationsResponse {
    return {
        type: 'get_annotations',
        request_id: request.request_id,
        annotations: [],
        total_count: 0,
        error,
        error_code: errorCode,
    };
}


/**
 * Return paginated annotations for a Zotero file attachment.
 */
export async function handleGetAnnotationsRequest(
    request: WSGetAnnotationsRequest
): Promise<WSGetAnnotationsResponse> {
    logger(`handleGetAnnotationsRequest: Getting annotations for ${request.attachment_id}`, 1);

    try {
        const dashIndex = request.attachment_id.indexOf('-');
        if (dashIndex === -1) {
            return invalidResponse(request, 'Invalid attachment_id format', 'invalid_attachment_id');
        }

        const libraryId = parseInt(request.attachment_id.substring(0, dashIndex), 10);
        const key = request.attachment_id.substring(dashIndex + 1);
        if (isNaN(libraryId) || !key) {
            return invalidResponse(request, 'Invalid attachment_id format', 'invalid_attachment_id');
        }

        const attachment = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, key);
        if (!attachment) {
            return invalidResponse(request, 'Attachment not found', 'not_found');
        }

        if (!attachment.isFileAttachment?.()) {
            return invalidResponse(request, 'Item is not a file attachment', 'not_attachment');
        }

        await Zotero.Items.loadDataTypes([attachment], ['primaryData', 'itemData', 'childItems']);

        const allAnnotations: Zotero.Item[] = attachment.getAnnotations();
        const totalCount = allAnnotations.length;
        const offset = Math.max(0, request.offset || 0);
        const limit = Math.max(0, request.limit || 0);
        const annotationItems = allAnnotations.slice(offset, offset + limit);

        if (annotationItems.length > 0) {
            await Zotero.Items.loadDataTypes(annotationItems, ['primaryData', 'itemData', 'tags']);
        }

        let itemInfo: { item_id: string; title: string } | null = null;
        if (attachment.parentID) {
            const parent = await Zotero.Items.getAsync(attachment.parentID);
            if (parent) {
                await parent.loadDataType('itemData');
                let title = '';
                try {
                    title = (parent.getField('title') as string) || '';
                } catch {
                    title = parent.getDisplayTitle?.() || '';
                }
                itemInfo = {
                    item_id: `${parent.libraryID}-${parent.key}`,
                    title,
                };
            }
        }

        const attachmentInfo = { item_id: request.attachment_id };
        const annotations = annotationItems.map(annotation =>
            serializeAnnotation(annotation, attachmentInfo, itemInfo)
        );

        logger(`handleGetAnnotationsRequest: Returning ${annotations.length}/${totalCount} annotations`, 1);

        return {
            type: 'get_annotations',
            request_id: request.request_id,
            annotations,
            total_count: totalCount,
        };
    } catch (error: any) {
        logger(`handleGetAnnotationsRequest: Failed: ${error}`, 1);
        return invalidResponse(
            request,
            error instanceof Error ? error.message : String(error),
            'internal_error',
        );
    }
}
