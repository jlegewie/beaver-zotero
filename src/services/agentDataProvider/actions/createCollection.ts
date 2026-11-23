import { readCollectionActionData } from '@beaver/agent-core/identity/collectionActionData';
import { CollectionResolutionError, resolveCollection, formatCollectionId, type ResolvedCollection } from '../../collections/collectionIdentity';
import { assertLibraryWritable, collectionDeletedSinceValidationMessage, recheckCollection } from '../../collections/collectionMutations';
import { logger } from '@beaver/agent-core/platform/logger';
import {
    WSAgentActionExecuteResponse,
    WSAgentActionValidateResponse
} from '@beaver/agent-core/protocol/agentProtocol';
import {
    libraryRefForLibraryID,
    resolveItemReference,
    resolveObjectId,
    resolveWriteTargetLibrary,
    UNRESOLVED_LIBRARY_ID,
    writeTargetLibraryError,
} from '../../../utils/libraryIdentity';
import type { ActionExecuteRequest, ActionValidateRequest } from '../operationContext';
import type { CreateCollectionResultData } from '@beaver/agent-core/types/agentActions/base';
import { checkAborted, TimeoutContext, TimeoutError } from '../timeout';
import { excludedLibraryMessage, getDeferredToolPreference } from '../utils';
import { actionError, assertLibraryNotExcluded, toExecuteResponse } from './actionExecution';


/**
 * Validate a create_collection action.
 * Checks if the library exists and is editable.
 */
async function validateCreateCollectionAction(
    request: ActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    const { library_id: rawLibraryId, library_ref, library_name, name, parent_key, item_ids } = readCollectionActionData(request.action_data) as {
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
    let library_id = targetResolution.libraryID;
    let parent: ResolvedCollection | null = null;
    if (parent_key) {
        try {
            parent = resolveCollection(parent_key, {
                libraryID: library_ref || rawLibraryId || library_name ? library_id : undefined,
            });
        } catch (error) {
            if (!(error instanceof CollectionResolutionError) || error.code !== 'collection_not_found') throw error;
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: `Parent collection not found: ${parent_key}`,
                error_code: 'parent_not_found',
                preference: 'always_ask',
            };
        }
        library_id = parent.libraryID;
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
    const searchableLibraryIds = (Zotero.Beaver.libraryScopeInitialized ? (Zotero.Beaver.searchableLibraryIds ?? []) : []);
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
    const preference = getDeferredToolPreference('create_collection', undefined, request.operation);

    // Build current value for preview (includes resolved library_id)
    const currentValue = {
        library_id: library_id,
        library_ref: libraryRefForLibraryID(library_id) ?? undefined,
        library_name: library.name,
        parent_key: parent?.key ?? null,
        parent_collection_id: parent?.collectionId,
        item_count: item_ids?.length || 0,
    };

    return {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: true,
        current_value: currentValue,
        normalized_action_data: {
            library_id, library_ref: libraryRefForLibraryID(library_id),
            parent_key: parent?.key ?? null, parent_collection_id: parent?.collectionId,
        },
        preference,
    };
}


/**
 * Create a collection, add the requested items to it and return its
 * `result_data`. A collection whose items could not be added is erased again,
 * so a failed apply leaves nothing behind.
 */
export async function applyCreateCollection(
    rawData: Record<string, any>,
    ctx: TimeoutContext,
): Promise<CreateCollectionResultData> {
    const { library_id: rawLibraryId, library_ref, library_name, name, parent_key, item_ids } = readCollectionActionData(rawData) as {
        library_id?: number | null;
        library_ref?: string | null;
        library_name?: string | null;
        name: string;
        parent_key?: string | null;
        item_ids?: string[];
    };

    const targetResolution = resolveWriteTargetLibrary({ library_ref, library_id: rawLibraryId, library_name });
    if (!targetResolution.ok) {
        const { error, error_code } = writeTargetLibraryError(targetResolution);
        throw actionError(error_code, error);
    }
    const library_id = targetResolution.libraryID;

    // TOCTOU guard: never create in a library the user excluded from Beaver,
    // even if validation passed earlier or the action waited for approval.
    assertLibraryNotExcluded(library_id);
    assertLibraryWritable(library_id);

    // Build collection params
    const collectionParams: { name: string; libraryID: number; parentID?: number } = {
        name,
        libraryID: library_id,
    };

    // Set parent if provided. A parent deleted since approval fails the
    // action; never fall back to creating at top level or to a same-named
    // replacement.
    if (parent_key) {
        let parentCollection: Zotero.Collection | null = null;
        try {
            parentCollection = recheckCollection(parent_key, library_id).collection;
        } catch (error) {
            if (!(error instanceof CollectionResolutionError) || error.code !== 'collection_not_found') throw error;
        }
        if (!parentCollection) {
            throw actionError('parent_not_found', collectionDeletedSinceValidationMessage('Parent collection', parent_key),
                { userMessage: `Parent collection not found: ${parent_key}` });
        }
        collectionParams.parentID = parentCollection.id;
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
        logger(`applyCreateCollection: Created collection "${name}" with key ${collection.key}`, 1);

        let itemsAdded = 0;
        // Reported by id so the backend can settle each one; a bare count
        // cannot say which items were left out.
        const skippedItemIds: string[] = [];

        // Add items to the collection if specified
        if (item_ids && item_ids.length > 0) {
            // Checkpoint: abort before item-adding transaction
            checkAborted(ctx, 'create_collection:before_add_items');

            await Zotero.DB.executeTransaction(async () => {
                const itemIdsToAdd: number[] = [];

                // Accepts both the portable "<library_ref>-<zotero_key>"
                // grammar and the legacy numeric grammar; unresolved, missing
                // or child items are skipped.
                for (const itemIdStr of item_ids) {
                    const parsedRef = resolveObjectId(itemIdStr);
                    if (!parsedRef) {
                        skippedItemIds.push(itemIdStr);
                        continue;
                    }
                    const resolved = await resolveItemReference(parsedRef);
                    if (resolved.status !== 'found') {
                        skippedItemIds.push(itemIdStr);
                        continue;
                    }
                    const item = resolved.item;
                    if (item.libraryID === library_id && !item.isAttachment() && !item.isNote() && !item.isAnnotation()) {
                        itemIdsToAdd.push(item.id);
                    } else {
                        skippedItemIds.push(itemIdStr);
                    }
                }

                if (itemIdsToAdd.length > 0) {
                    await collection.addItems(itemIdsToAdd);
                    itemsAdded = itemIdsToAdd.length;
                    logger(`applyCreateCollection: Added ${itemsAdded} items to collection`, 1);
                }
            });
        }

        return {
            library_id,
            library_ref: libraryRefForLibraryID(library_id) ?? undefined,
            collection_key: collection.key,
            collection_id: formatCollectionId(collection.libraryID, collection.key),
            items_added: itemsAdded,
            skipped_item_ids: skippedItemIds,
        };
    } catch (error) {
        // Compensating action: delete collection if it was persisted but
        // subsequent operations (item addition) failed or timed out.
        // This prevents orphaned empty collections from accumulating.
        if (collectionSaved) {
            try {
                await collection.eraseTx();
                logger(`applyCreateCollection: Rolled back collection "${name}"`, 1);
            } catch (eraseError) {
                logger(`applyCreateCollection: Failed to roll back collection: ${eraseError}`, 1);
            }
        }

        if (error instanceof TimeoutError) throw error;
        logger(`applyCreateCollection: Failed to create collection: ${error}`, 1);
        throw actionError('create_failed', `Failed to create collection: ${error}`,
            { userMessage: (error as Error)?.message || String(error) });
    }
}

/** Create a collection for the backend during a run. */
async function executeCreateCollectionAction(
    request: ActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    return toExecuteResponse(request.request_id, 'executeCreateCollectionAction',
        () => applyCreateCollection(request.action_data, ctx));
}

export { executeCreateCollectionAction, validateCreateCollectionAction };
