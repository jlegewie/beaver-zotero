import { logger } from '../../utils/logger';
import { WSAgentActionExecuteRequest, WSAgentActionExecuteResponse } from '../agentProtocol';
import type { CreateItemProposedData, CreateItemResultData } from '../../../react/types/agentActions/items';
import { applyCreateItemData } from '../../../react/utils/addItemActions';
import { TimeoutContext, checkAborted, DEFAULT_TIMEOUT_SECONDS } from './timeout';
import { TimeoutError } from './timeout';
import { executeEditNoteAction } from './actions/editNote';
import { executeEditMetadataAction } from './actions/editMetadata';
import { executeOrganizeItemsAction } from './actions/organizeItems';
import { executeCreateNoteAction } from './actions/createNote';


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
        };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Execute a create_collection action.
 * Creates a new Zotero collection with the specified properties.
 */
async function executeCreateCollectionAction(
    request: WSAgentActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const { library_id: rawLibraryId, library_name, name, parent_key, item_ids } = request.action_data as {
        library_id?: number | null;
        library_name?: string | null;
        name: string;
        parent_key?: string | null;
        item_ids?: string[];
    };

    // Resolve target library: use provided ID, resolve name, or default to user's main library
    let library_id: number;

    if (rawLibraryId == null || rawLibraryId === 0) {
        // Not provided or normalized to 0 — try library_name, then default
        if (library_name) {
            const allLibraries = Zotero.Libraries.getAll();
            const matchedLibrary = allLibraries.find(
                (lib) => lib.name.toLowerCase() === library_name.toLowerCase()
            );
            if (!matchedLibrary) {
                return {
                    type: 'agent_action_execute_response',
                    request_id: request.request_id,
                    success: false,
                    error: `Library not found: "${library_name}"`,
                    error_code: 'library_not_found',
                };
            }
            library_id = matchedLibrary.libraryID;
        } else {
            library_id = Zotero.Libraries.userLibraryID;
        }
    } else if (typeof rawLibraryId === 'number' && rawLibraryId > 0) {
        library_id = rawLibraryId;
    } else {
        // Explicitly provided but invalid (negative, NaN, fractional, etc.)
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: `Invalid library ID: ${rawLibraryId}`,
            error_code: 'library_not_found',
        };
    }

    // Build collection params
    const collectionParams: { name: string; libraryID: number; parentID?: number } = {
        name,
        libraryID: library_id,
    };

    // Set parent if provided
    if (parent_key) {
        const parentCollection = await Zotero.Collections.getByLibraryAndKeyAsync(library_id, parent_key);
        if (parentCollection) {
            collectionParams.parentID = parentCollection.id;
        } else {
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: `Parent collection not found: ${parent_key}`,
                error_code: 'parent_not_found',
            };
        }
    }

    let collection: any = null;
    let collectionSaved = false;

    try {
        // Create the collection
        collection = new Zotero.Collection(collectionParams);

        // Checkpoint: abort before persisting collection
        checkAborted(ctx, 'create_collection:before_save');

        // Save the collection
        await collection.saveTx();
        collectionSaved = true;
        logger(`executeCreateCollectionAction: Created collection "${name}" with key ${collection.key}`, 1);

        let itemsAdded = 0;

        // Add items to the collection if specified
        if (item_ids && item_ids.length > 0) {
            // Checkpoint: abort before item-adding transaction
            checkAborted(ctx, 'create_collection:before_add_items');

            await Zotero.DB.executeTransaction(async () => {
                const itemIdsToAdd: number[] = [];

                for (const itemIdStr of item_ids) {
                    const [libId, key] = itemIdStr.split('-');
                    const item = await Zotero.Items.getByLibraryAndKeyAsync(parseInt(libId, 10), key);
                    if (item && !item.isAttachment() && !item.isNote() && !item.isAnnotation()) {
                        itemIdsToAdd.push(item.id);
                    }
                }

                if (itemIdsToAdd.length > 0) {
                    await collection.addItems(itemIdsToAdd);
                    itemsAdded = itemIdsToAdd.length;
                    logger(`executeCreateCollectionAction: Added ${itemsAdded} items to collection`, 1);
                }
            });
        }

        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: true,
            result_data: {
                library_id,
                collection_key: collection.key,
                items_added: itemsAdded,
            },
        };
    } catch (error) {
        // Compensating action: delete collection if it was persisted but
        // subsequent operations (item addition) failed or timed out.
        // This prevents orphaned empty collections from accumulating.
        if (collectionSaved) {
            try {
                await collection.eraseTx();
                logger(`executeCreateCollectionAction: Rolled back collection "${name}"`, 1);
            } catch (eraseError) {
                logger(`executeCreateCollectionAction: Failed to roll back collection: ${eraseError}`, 1);
            }
        }

        // Re-throw TimeoutError so it propagates to the main handler
        if (error instanceof TimeoutError) throw error;
        logger(`executeCreateCollectionAction: Failed to create collection: ${error}`, 1);
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: `Failed to create collection: ${error}`,
            error_code: 'create_failed',
        };
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
        };
    }

    // Resolve target library: use provided ID, resolve name, or default to user's main library
    let library_id: number;

    if (proposedData.library_id != null && proposedData.library_id !== 0) {
        if (typeof proposedData.library_id === 'number' && proposedData.library_id > 0) {
            library_id = proposedData.library_id;
        } else {
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: `Invalid library ID: ${proposedData.library_id}`,
                error_code: 'library_not_found',
            };
        }
    } else if (proposedData.library_name) {
        const allLibraries = Zotero.Libraries.getAll();
        const matchedLibrary = allLibraries.find(
            (lib) => lib.name.toLowerCase() === proposedData.library_name!.toLowerCase()
        );
        if (!matchedLibrary) {
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: `Library not found: "${proposedData.library_name}"`,
                error_code: 'library_not_found',
            };
        }
        library_id = matchedLibrary.libraryID;
    } else {
        library_id = Zotero.Libraries.userLibraryID;
    }

    try {
        logger(`executeCreateItemAction: Creating item "${proposedData.item.title}" in library ${library_id}`, 1);

        // Checkpoint: abort before starting item creation
        checkAborted(ctx, 'create_item:before_apply');

        // Create the item using the existing utility function
        // Pass library_id from resolved library to target the correct library
        const result: CreateItemResultData = await applyCreateItemData(proposedData, {
            libraryId: library_id,
        });

        logger(`executeCreateItemAction: Successfully created item ${result.library_id}-${result.zotero_key}`, 1);

        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: true,
            result_data: result,
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
        };
    }
}
