/**
 * Agent Data Provider
 *
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 *
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */

import { lookupZoteroReferences } from './lookupZoteroReferences';
import {
    WSZoteroDataRequest,
    WSZoteroDataResponse,
} from '../agentProtocol';


/**
 * Handle zotero_data_request event.
 * Fetches item/attachment metadata for the requested references.
 */
export async function handleZoteroDataRequest(request: WSZoteroDataRequest): Promise<WSZoteroDataResponse> {
    const result = await lookupZoteroReferences(request.items, {
        include_attachments: request.include_attachments,
        include_parents: request.include_parents,
        file_status_level: request.file_status_level,
    });

    return {
        type: 'zotero_data',
        request_id: request.request_id,
        items: result.items,
        attachments: result.attachments,
        notes: result.notes.length > 0 ? result.notes : undefined,
        errors: result.errors.length > 0 ? result.errors : undefined,
    };
}
