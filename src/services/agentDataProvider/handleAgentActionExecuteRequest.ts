import { logger } from '../../utils/logger';
import { WSAgentActionExecuteRequest, WSAgentActionExecuteResponse, FrontendTimingMetadata } from '../agentProtocol';
import type { CreateItemProposedData, CreateItemResultData } from '../../../react/types/agentActions/items';
import { applyCreateItemData } from '../../../react/utils/addItemActions';
import { TimeoutContext, checkAborted, DEFAULT_TIMEOUT_SECONDS } from './timeout';
import { TimeoutError } from './timeout';
import { executeEditNoteAction } from './actions/editNote';
import { executeEditMetadataAction } from './actions/editMetadata';
import { executeOrganizeItemsAction } from './actions/organizeItems';
import { executeCreateNoteAction } from './actions/createNote';
import { executeManageTagsAction } from './actions/manageTags';
import { executeManageCollectionsAction } from './actions/manageCollections';
import { executeCreateCollectionAction } from './actions/createCollection';
import { TimingAccumulator } from '../../utils/timing';


/**
 * Handle agent_action_execute request from backend.
 * Executes the action and returns the result.
 *
 * Timeout handling:
 * - Uses timeout_seconds from request (default: 25s)
 * - Uses cooperative cancellation via AbortController so executors
 *   check the signal before irreversible operations (saves, transactions)
 * - Returns detailed diagnostics on timeout
 */
export async function handleAgentActionExecuteRequest(
    request: WSAgentActionExecuteRequest
): Promise<WSAgentActionExecuteResponse> {
    const rawTimeout = request.timeout_seconds;
    const timeoutSeconds = (typeof rawTimeout === 'number' && rawTimeout > 0)
        ? rawTimeout
        : DEFAULT_TIMEOUT_SECONDS;
    const startTime = Date.now();

    logger(`handleAgentActionExecuteRequest: Executing ${request.action_type} with timeout ${timeoutSeconds}s`, 1);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

    try {
        const ctx: TimeoutContext = {
            signal: controller.signal,
            timeoutSeconds,
            startTime,
        };

        let result: WSAgentActionExecuteResponse;

        if (request.action_type === 'edit_metadata') {
            result = await executeEditMetadataAction(request, ctx);
        } else if (request.action_type === 'create_collection') {
            result = await executeCreateCollectionAction(request, ctx);
        } else if (request.action_type === 'organize_items') {
            result = await executeOrganizeItemsAction(request, ctx);
        } else if (request.action_type === 'create_item') {
            result = await executeCreateItemAction(request, ctx);
        } else if (request.action_type === 'edit_note') {
            result = await executeEditNoteAction(request, ctx);
        } else if (request.action_type === 'create_note') {
            result = await executeCreateNoteAction(request, ctx);
        } else if (request.action_type === 'manage_tags') {
            result = await executeManageTagsAction(request, ctx);
        } else if (request.action_type === 'manage_collections') {
            result = await executeManageCollectionsAction(request, ctx);
        } else {
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: `Unsupported action type: ${request.action_type}`,
                error_code: 'unsupported_action_type',
            };
        }

        return result;
    } catch (error) {
        const elapsedMs = Date.now() - startTime;

        if (error instanceof TimeoutError) {
            logger(`handleAgentActionExecuteRequest: Timeout after ${error.elapsedMs}ms in phase '${error.phase}'`, 1);
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: `Operation timed out after ${error.timeoutSeconds} seconds`,
                error_code: 'timeout',
                result_data: {
                    started_at: startTime,
                    elapsed_ms: error.elapsedMs,
                    phase: error.phase,
                    action_type: request.action_type,
                    timeout_seconds: error.timeoutSeconds,
                },
                timing: { total_ms: error.elapsedMs },
            };
        }

        logger(`handleAgentActionExecuteRequest: Error after ${elapsedMs}ms: ${error}`, 1);
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: String(error),
            error_code: 'execution_failed',
            result_data: {
                started_at: startTime,
                elapsed_ms: elapsedMs,
                action_type: request.action_type,
            },
            timing: { total_ms: elapsedMs },
        };
    } finally {
        clearTimeout(timer);
    }
}


/**
 * Execute a create_item action.
 * Creates the item in Zotero from the proposed data.
 * 
 * Note: This handler is called once PER ITEM from the backend.
 * The action_data contains a single item's proposed_data.
 */
async function executeCreateItemAction(
    request: WSAgentActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const startTime = Date.now();
    const ta = new TimingAccumulator();

    const buildTiming = (): FrontendTimingMetadata => ({
        total_ms: Date.now() - startTime,
        ...ta.getAll(),
    });

    // The action_data is the proposed_data for a single create_item action
    const proposedData = request.action_data as CreateItemProposedData;

    // Validate we have item data
    if (!proposedData || !proposedData.item) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: 'No item data provided',
            error_code: 'missing_item_data',
            timing: buildTiming(),
        };
    }

    // Resolve target library: use provided ID, resolve name, or default to user's main library
    const libResolveStart = Date.now();
    let library_id: number;

    if (proposedData.library_id != null && proposedData.library_id !== 0) {
        if (typeof proposedData.library_id === 'number' && proposedData.library_id > 0) {
            library_id = proposedData.library_id;
        } else {
            ta.record('resolve_library_ms', Date.now() - libResolveStart);
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: `Invalid library ID: ${proposedData.library_id}`,
                error_code: 'library_not_found',
                timing: buildTiming(),
            };
        }
    } else if (proposedData.library_name) {
        const allLibraries = Zotero.Libraries.getAll();
        const matchedLibrary = allLibraries.find(
            (lib) => lib.name.toLowerCase() === proposedData.library_name!.toLowerCase()
        );
        if (!matchedLibrary) {
            ta.record('resolve_library_ms', Date.now() - libResolveStart);
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: `Library not found: "${proposedData.library_name}"`,
                error_code: 'library_not_found',
                timing: buildTiming(),
            };
        }
        library_id = matchedLibrary.libraryID;
    } else {
        library_id = Zotero.Libraries.userLibraryID;
    }
    ta.record('resolve_library_ms', Date.now() - libResolveStart);

    try {
        logger(`executeCreateItemAction: Creating item "${proposedData.item.title}" in library ${library_id}`, 1);

        // Checkpoint: abort before starting item creation
        checkAborted(ctx, 'create_item:before_apply');

        // Create the item using the existing utility function
        const result: CreateItemResultData = await ta.track('apply_ms', () =>
            applyCreateItemData(proposedData, {
                libraryId: library_id,
                skipUrlTranslation: true,
                timing: ta,
            })
        );

        logger(`executeCreateItemAction: Successfully created item ${result.library_id}-${result.zotero_key}`, 1);

        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: true,
            result_data: result,
            timing: buildTiming(),
        };
    } catch (error: any) {
        // Re-throw TimeoutError so it propagates to the main handler
        if (error instanceof TimeoutError) throw error;
        const errorMsg = error?.message || String(error) || 'Failed to create item';
        const errorStack = error?.stack || '';
        logger(`executeCreateItemAction: Failed to create item: ${errorMsg}`, 1);
        if (errorStack) {
            logger(`executeCreateItemAction: Stack: ${errorStack}`, 1);
        }
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: errorMsg,
            error_code: 'create_failed',
            timing: buildTiming(),
        };
    }
}
