import { logger } from '../../../utils/logger';
import { searchableLibraryIdsAtom } from '../../../../react/atoms/profile';
import { store } from '../../../../react/store';
import {
    WSAgentActionValidateRequest,
    WSAgentActionValidateResponse,
    WSAgentActionExecuteRequest,
    WSAgentActionExecuteResponse,

} from '../../agentProtocol';
import { checkLibraryExcluded, excludedLibraryMessage, getDeferredToolPreference } from '../utils';
import { TimeoutContext, checkAborted } from '../timeout';
import { TimeoutError } from '../timeout';


/**
 * Validate a create_collection action.
 * Checks if the library exists and is editable.
 */
async function validateCreateCollectionAction(
    request: WSAgentActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
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
                const availableNames = allLibraries.map((lib) => lib.name).join(', ');
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: `Library not found: "${library_name}". Omit the library parameter to use the default library. Available libraries: ${availableNames}`,
                    error_code: 'library_not_found',
                    preference: 'always_ask',
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
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Invalid library ID: ${rawLibraryId}`,
            error_code: 'library_not_found',
            preference: 'always_ask',
        };
    }

    // Validate library exists
    const library = Zotero.Libraries.get(library_id);
    if (!library) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library not found: ${library_id}`,
            error_code: 'library_not_found',
            preference: 'always_ask',
        };
    }

    // Validate library is searchable
    const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
    if (!searchableLibraryIds.includes(library_id)) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: excludedLibraryMessage(library_id),
            error_code: 'library_not_searchable',
            preference: 'always_ask',
        };
    }

    // Check if library is editable
    if (!library.editable) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library '${library.name}' is read-only and cannot be modified`,
            error_code: 'library_not_editable',
            preference: 'always_ask',
        };
    }

    // Validate collection name
    if (!name || name.trim().length === 0) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'Collection name cannot be empty',
            error_code: 'invalid_name',
            preference: 'always_ask',
        };
    }

    // Validate parent collection if provided
    if (parent_key) {
        const parentCollection = await Zotero.Collections.getByLibraryAndKeyAsync(library_id, parent_key);
        if (!parentCollection) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: `Parent collection not found: ${parent_key}`,
                error_code: 'parent_not_found',
                preference: 'always_ask',
            };
        }
    }

    // Validate item IDs if provided
    if (item_ids && item_ids.length > 0) {
        for (const itemId of item_ids) {
            const [libId, key] = itemId.split('-');
            const itemLibraryId = parseInt(libId, 10);
            
            // Items must be in the same library
            if (itemLibraryId !== library_id) {
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: `Item ${itemId} is not in library ${library_id}`,
                    error_code: 'item_library_mismatch',
                    preference: 'always_ask',
                };
            }
            
            const item = await Zotero.Items.getByLibraryAndKeyAsync(itemLibraryId, key);
            if (!item) {
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: `Item not found: ${itemId}`,
                    error_code: 'item_not_found',
                    preference: 'always_ask',
                };
            }
        }
    }

    // Get user preference from settings
    const preference = getDeferredToolPreference('create_collection');

    // Build current value for preview (includes resolved library_id)
    const currentValue = {
        library_id: library_id,
        library_name: library.name,
        parent_key: parent_key || null,
        item_count: item_ids?.length || 0,
    };

    return {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: true,
        current_value: currentValue,
        preference,
    };
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

    // TOCTOU guard: never create in a library the user excluded from Beaver,
    // even if validation passed earlier or the execute request skipped it.
    const excluded = checkLibraryExcluded(library_id);
    if (excluded) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: excluded.message,
            error_code: 'library_not_searchable',
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

export { validateCreateCollectionAction, executeCreateCollectionAction };