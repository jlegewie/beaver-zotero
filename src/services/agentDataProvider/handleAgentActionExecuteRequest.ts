/**
 * Agent Data Provider
 * 
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 * 
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */

import { logger } from '../../utils/logger';
import { WSAgentActionExecuteRequest, WSAgentActionExecuteResponse } from '../agentProtocol';


/**
 * Handle agent_action_execute request from backend.
 * Executes the action and returns the result.
 */
export async function handleAgentActionExecuteRequest(
    request: WSAgentActionExecuteRequest
): Promise<WSAgentActionExecuteResponse> {
    logger(`handleAgentActionExecuteRequest: Executing ${request.action_type}`, 1);

    try {
        if (request.action_type === 'edit_metadata') {
            return await executeEditMetadataAction(request);
        }

        // Unsupported action type
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: `Unsupported action type: ${request.action_type}`,
            error_code: 'unsupported_action_type',
        };
    } catch (error) {
        logger(`handleAgentActionExecuteRequest: Error: ${error}`, 1);
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: String(error),
            error_code: 'execution_failed',
        };
    }
}

/**
 * Execute an edit_metadata action.
 * Applies the field edits to the Zotero item.
 */
async function executeEditMetadataAction(
    request: WSAgentActionExecuteRequest
): Promise<WSAgentActionExecuteResponse> {
    const { library_id, zotero_key, edits } = request.action_data as {
        library_id: number;
        zotero_key: string;
        edits: Array<{ field: string; new_value: string }>;
    };

    // Get the item
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: `Item not found: ${library_id}-${zotero_key}`,
            error_code: 'item_not_found',
        };
    }

    const appliedEdits: Array<{ field: string; old_value: string | null; new_value: string }> = [];
    const failedEdits: Array<{ field: string; error: string }> = [];

    // Apply each edit
    for (const edit of edits) {
        try {
            const oldValue = item.getField(edit.field);
            item.setField(edit.field, edit.new_value);
            appliedEdits.push({
                field: edit.field,
                old_value: oldValue ? String(oldValue) : null,
                new_value: edit.new_value,
            });
        } catch (error) {
            failedEdits.push({
                field: edit.field,
                error: String(error),
            });
        }
    }

    // Save the item if any edits were applied
    if (appliedEdits.length > 0) {
        try {
            await item.saveTx();
            logger(`executeEditMetadataAction: Saved ${appliedEdits.length} edits to ${library_id}-${zotero_key}`, 1);
        } catch (error) {
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: `Failed to save item: ${error}`,
                error_code: 'save_failed',
            };
        }
    }

    const allSucceeded = failedEdits.length === 0;

    return {
        type: 'agent_action_execute_response',
        request_id: request.request_id,
        success: allSucceeded,
        error: allSucceeded ? undefined : `Some edits failed: ${failedEdits.map(e => e.field).join(', ')}`,
        result_data: {
            applied_edits: appliedEdits,
            failed_edits: failedEdits,
        },
    };
}
