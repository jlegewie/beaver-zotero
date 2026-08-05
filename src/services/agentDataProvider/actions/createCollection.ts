import { logger } from '@beaver/agent-core/platform/logger';
import { searchableLibraryIdsAtom } from '../../../../react/atoms/profile';
import { store } from '../../../../react/store';
import {
    WSAgentActionValidateRequest,
    WSAgentActionValidateResponse,
    WSAgentActionExecuteRequest,
    WSAgentActionExecuteResponse,

} from '@beaver/agent-core/protocol/agentProtocol';
import { checkLibraryExcluded, excludedLibraryMessage, getDeferredToolPreference, resolveCollectionForWrite } from '../utils';
import {
    libraryRefForLibraryID,
    resolveItemReference,
    resolveObjectId,
    resolveWriteTargetLibrary,
    UNRESOLVED_LIBRARY_ID,
    writeTargetLibraryError,
} from '../../../utils/libraryIdentity';
import { TimeoutContext, checkAborted } from '../timeout';
import { TimeoutError } from '../timeout';


/**
 * Validate a create_collection action.
 * Checks if the library exists and is editable.
 */
async function validateCreateCollectionAction(
    request: WSAgentActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    const { library_id: rawLibraryId, library_ref, library_name, name, parent_key, item_ids } = request.action_data as {
        library_id?: number | null;
        library_ref?: string | null;
        library_name?: string | null;
        name: string;
        parent_key?: string | null;
        item_ids?: string[];
    };

    const targetResolution = resolveWriteTargetLibrary({ library_ref, library_id: rawLibraryId, library_name });
    if (!targetResolution.ok) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            ...writeTargetLibraryError(targetResolution),
            preference: 'always_ask',
        };
    }
    const library_id = targetResolution.libraryID;

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

    // Validate parent collection if provided. The target library is a hard
    // scope, so a scoped identifier from another library is reported as a scope
    // conflict rather than silently missing. Names are rejected: a subcollection
    // must be attached to one specific parent.
    let resolvedParentKey: string | null = null;
    if (parent_key) {
        const parentResolution = resolveCollectionForWrite(parent_key, {
            eligibleLibraryIds: [library_id],
            explicitLibrary: true,
        });
        if (!parentResolution.ok) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: parentResolution.message,
                error_code: parentResolution.code === 'collection_not_found' ? 'parent_not_found' : parentResolution.code,
                preference: 'always_ask',
            };
        }
        resolvedParentKey = parentResolution.match.collection.key;
    }

    // Validate item IDs if provided. Accepts both the portable
    // "<library_ref>-<zotero_key>" grammar and the legacy
    // "<library_id>-<zotero_key>" numeric grammar.
    if (item_ids && item_ids.length > 0) {
        for (const itemId of item_ids) {
            const parsedRef = resolveObjectId(itemId);
            if (!parsedRef) {
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: `Invalid item_id format: ${itemId}. Expected "<library_ref>-<zotero_key>" or "<library_id>-<zotero_key>"`,
                    error_code: 'invalid_item_id',
                    preference: 'always_ask',
                };
            }

            // Items must be in the same (resolved) library as the target
            // collection. An unresolvable portable ref gets its own error
            // rather than being reported as a library mismatch.
            if (parsedRef.library_id !== library_id) {
                if (parsedRef.library_id === UNRESOLVED_LIBRARY_ID) {
                    return {
                        type: 'agent_action_validate_response',
                        request_id: request.request_id,
                        valid: false,
                        error: `Item ${itemId} is in a library that is not available on this computer.`,
                        error_code: 'library_unavailable',
                        preference: 'always_ask',
                    };
                }
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: `Item ${itemId} is not in library ${library_id}`,
                    error_code: 'item_library_mismatch',
                    preference: 'always_ask',
                };
            }

            const item = await Zotero.Items.getByLibraryAndKeyAsync(parsedRef.library_id, parsedRef.zotero_key);
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
        library_ref: libraryRefForLibraryID(library_id) ?? undefined,
        library_name: library.name,
        parent_key: resolvedParentKey,
        item_count: item_ids?.length || 0,
    };

    return {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: true,
        current_value: currentValue,
        // Report the resolved target library and the parent as a bare key in
        // it, whatever grammar the agent used, for consumers that read
        // normalized_action_data.
        normalized_action_data: {
            library_id,
            library_ref: libraryRefForLibraryID(library_id) ?? undefined,
            parent_key: resolvedParentKey,
        },
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
    const { library_id: rawLibraryId, library_ref, library_name, name, parent_key, item_ids } = request.action_data as {
        library_id?: number | null;
        library_ref?: string | null;
        library_name?: string | null;
        name: string;
        parent_key?: string | null;
        item_ids?: string[];
    };

    const targetResolution = resolveWriteTargetLibrary({ library_ref, library_id: rawLibraryId, library_name });
    if (!targetResolution.ok) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            ...writeTargetLibraryError(targetResolution),
        };
    }
    const library_id = targetResolution.libraryID;

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

    // Set parent if provided. The `parent_key` this path receives may still be
    // the value the agent authored, in either grammar (bare key or scoped
    // identifier), so it is resolved against the target library.
    if (parent_key) {
        const parentResolution = resolveCollectionForWrite(parent_key, {
            eligibleLibraryIds: [library_id],
            explicitLibrary: true,
        });
        if (!parentResolution.ok) {
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: parentResolution.message,
                error_code: parentResolution.code === 'collection_not_found' ? 'parent_not_found' : parentResolution.code,
            };
        }
        collectionParams.parentID = parentResolution.match.collection.id;
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
                    const parsedRef = resolveObjectId(itemIdStr);
                    if (!parsedRef) continue;
                    const resolved = await resolveItemReference(parsedRef);
                    if (resolved.status !== 'found') continue;
                    const item = resolved.item;
                    if (!item.isAttachment() && !item.isNote() && !item.isAnnotation()) {
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
                library_ref: libraryRefForLibraryID(library_id) ?? undefined,
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
