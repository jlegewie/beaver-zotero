/**
 * Validate and execute library-wide collection operations (manage_collections).
 *
 * Supports three actions:
 *   - 'rename': changes the collection name.
 *   - 'move':   reparents the collection. new_parent_key=null means top-level.
 *               Rejects cycles (moving into self or a descendant) and
 *               cross-library moves (Zotero requires copy+delete).
 *   - 'delete': erases the collection (eraseTx). Items in the collection
 *               are NOT deleted — they become unfiled. Subcollections ARE
 *               trashed with the parent.
 *
 * Snapshots (old_name, old_parent_key, old_item_ids, had_subcollections) are
 * captured at validation time to support undo.
 */

import {
    WSAgentActionValidateRequest,
    WSAgentActionValidateResponse,
    WSAgentActionExecuteRequest,
    WSAgentActionExecuteResponse,
} from '../../agentProtocol';
import { getDeferredToolPreference, isLibrarySearchable, getSearchableLibraries } from '../utils';
import { TimeoutContext, checkAborted, TimeoutError } from '../timeout';
import { logger } from '../../../utils/logger';

const MAX_SNAPSHOT_ITEMS = 5000;


async function itemIdsToKeys(libraryID: number, itemIDs: number[]): Promise<string[]> {
    if (itemIDs.length === 0) return [];
    const items = await Zotero.Items.getAsync(itemIDs);
    const valid = items.filter((i): i is Zotero.Item => i !== null);
    if (valid.length > 0) {
        await Zotero.Items.loadDataTypes(valid, ['primaryData']);
    }
    return valid.map((item) => `${libraryID}-${item.key}`);
}


export async function validateManageCollectionsAction(
    request: WSAgentActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    const { action, collection_key, new_name: rawNewName, new_parent_key: rawNewParentKey } = request.action_data as {
        action: 'rename' | 'move' | 'delete';
        collection_key: string;
        new_name?: string | null;
        new_parent_key?: string | null;
    };

    if (!collection_key || typeof collection_key !== 'string' || !collection_key.trim()) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'collection_key cannot be empty',
            error_code: 'invalid_collection_key',
            preference: 'always_ask',
        };
    }

    // Collection lookups need a library. We let the handler search all synced
    // libraries: find the unique collection with this key in any searchable lib.
    let collection: Zotero.Collection | null = null;
    const searchableLibs = getSearchableLibraries();
    for (const { library_id } of searchableLibs) {
        const c = await Zotero.Collections.getByLibraryAndKeyAsync(library_id, collection_key);
        if (c) {
            collection = c;
            break;
        }
    }
    if (!collection) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Collection not found: ${collection_key}`,
            error_code: 'collection_not_found',
            preference: 'always_ask',
        };
    }

    const libraryID = collection.libraryID;
    const library = Zotero.Libraries.get(libraryID);
    if (!library) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library not found for collection '${collection_key}'`,
            error_code: 'library_not_found',
            preference: 'always_ask',
        };
    }
    if (!isLibrarySearchable(libraryID)) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Collection '${collection.name}' is in library '${library.name}' which is not synced with Beaver.`,
            error_code: 'library_not_searchable',
            preference: 'always_ask',
        };
    }
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

    const oldName: string = collection.name;
    const oldParentKey: string | null = collection.parentKey ? String(collection.parentKey) : null;

    // Action-specific validation
    let newName: string | null = null;
    let newParentKey: string | null = null;

    if (action === 'rename') {
        newName = (rawNewName ?? '').trim();
        if (!newName) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: "action='rename' requires a non-empty new_name",
                error_code: 'invalid_new_name',
                preference: 'always_ask',
            };
        }
        if (newName === oldName) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: 'new_name must be different from the current name',
                error_code: 'invalid_new_name',
                preference: 'always_ask',
            };
        }
    } else if (action === 'move') {
        newParentKey = rawNewParentKey ? rawNewParentKey.trim() || null : null;
        if (newParentKey) {
            // Must exist in the same library
            const parent = await Zotero.Collections.getByLibraryAndKeyAsync(libraryID, newParentKey);
            if (!parent) {
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: `Parent collection not found in library '${library.name}': ${newParentKey}`,
                    error_code: 'parent_not_found',
                    preference: 'always_ask',
                };
            }
            // Cannot move into self
            if (parent.id === collection.id) {
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: 'Cannot move a collection into itself',
                    error_code: 'invalid_parent',
                    preference: 'always_ask',
                };
            }
            // Cannot move into a descendant (cycle)
            const descendantIds = new Set(
                collection.getDescendents(false, 'collection', false).map((d: any) => d.id)
            );
            if (descendantIds.has(parent.id)) {
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: 'Cannot move a collection into one of its own descendants (cycle)',
                    error_code: 'invalid_parent',
                    preference: 'always_ask',
                };
            }
        }
        // No-op move (same parent) — reject
        const currentParentKey = oldParentKey;
        if ((newParentKey ?? null) === currentParentKey) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: `Collection is already at this location (parent: ${currentParentKey ?? 'top-level'})`,
                error_code: 'no_change',
                preference: 'always_ask',
            };
        }
    } else if (action !== 'delete') {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Unsupported action: '${action}'. Use 'rename', 'move', or 'delete'.`,
            error_code: 'invalid_action',
            preference: 'always_ask',
        };
    }

    // Preview-only counts (for the approval card). The authoritative
    // snapshot is captured at execute time — NOT here — so a re-apply after
    // manual library edits produces a fresh snapshot.
    let oldItemCount: number | undefined;
    let hadSubcollections: boolean | undefined;
    if (action === 'delete') {
        const childItemIDs = collection.getChildItems(true, false) as number[];
        if (childItemIDs.length > MAX_SNAPSHOT_ITEMS) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: `Collection '${collection.name}' contains ${childItemIDs.length} items (over the ${MAX_SNAPSHOT_ITEMS} safety cap for undo snapshot). Ask the user to perform this deletion in Zotero directly.`,
                error_code: 'too_many_items',
                preference: 'always_ask',
            };
        }
        oldItemCount = childItemIDs.length;
        hadSubcollections = collection.hasChildCollections(false);
    }

    const preference = getDeferredToolPreference('manage_collections');

    return {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: true,
        current_value: {
            library_id: libraryID,
            library_name: library.name,
            action,
            collection_key: collection.key,
            collection_name: oldName,
            old_name: oldName,
            old_parent_key: oldParentKey,
            old_item_count: oldItemCount,
            had_subcollections: hadSubcollections,
        },
        // Only resolved scalars go into normalized_action_data. Snapshots are
        // captured at execute time.
        normalized_action_data: {
            library_id: libraryID,
        },
        preference,
    };
}


export async function executeManageCollectionsAction(
    request: WSAgentActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const { action, collection_key, new_name, new_parent_key, library_id } = request.action_data as {
        action: 'rename' | 'move' | 'delete';
        collection_key: string;
        new_name?: string | null;
        new_parent_key?: string | null;
        library_id: number;
    };

    if (!library_id || typeof library_id !== 'number') {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: 'library_id missing or invalid in action_data',
            error_code: 'invalid_library_id',
        };
    }

    try {
        const collection = await Zotero.Collections.getByLibraryAndKeyAsync(library_id, collection_key);
        if (!collection) {
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: `Collection not found: ${collection_key}`,
                error_code: 'collection_not_found',
            };
        }

        // Re-snapshot the authoritative pre-apply state at execute time.
        // A re-apply after manual library edits produces a fresh snapshot
        // that the next undo can correctly reverse.
        const oldName: string = collection.name;
        const oldParentKey: string | null = collection.parentKey ? String(collection.parentKey) : null;
        let oldItemIds: string[] | undefined;
        let hadSubcollections: boolean | undefined;
        if (action === 'delete') {
            const childItemIDs = collection.getChildItems(true, false) as number[];
            if (childItemIDs.length > MAX_SNAPSHOT_ITEMS) {
                return {
                    type: 'agent_action_execute_response',
                    request_id: request.request_id,
                    success: false,
                    error: `Collection '${oldName}' contains ${childItemIDs.length} items (over the ${MAX_SNAPSHOT_ITEMS} safety cap for undo snapshot).`,
                    error_code: 'too_many_items',
                };
            }
            oldItemIds = await itemIdsToKeys(library_id, childItemIDs);
            hadSubcollections = collection.hasChildCollections(false);
        }

        if (action === 'rename') {
            const target = (new_name ?? '').trim();
            if (!target) {
                return {
                    type: 'agent_action_execute_response',
                    request_id: request.request_id,
                    success: false,
                    error: 'new_name required for rename',
                    error_code: 'invalid_new_name',
                };
            }
            checkAborted(ctx, 'manage_collections:before_rename');
            collection.name = target;
            await collection.saveTx();
            logger(`executeManageCollectionsAction: Renamed collection ${library_id}-${collection_key} → '${target}'`, 1);
        } else if (action === 'move') {
            // Zotero uses `false` to signal top-level (see collection.js parentKey setter).
            checkAborted(ctx, 'manage_collections:before_move');
            (collection as any).parentKey = new_parent_key ? new_parent_key : false;
            await collection.saveTx();
            logger(`executeManageCollectionsAction: Moved collection ${library_id}-${collection_key} to parent ${new_parent_key ?? 'top-level'}`, 1);
        } else if (action === 'delete') {
            checkAborted(ctx, 'manage_collections:before_delete');
            await collection.eraseTx();
            logger(`executeManageCollectionsAction: Deleted collection ${library_id}-${collection_key}`, 1);
        } else {
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: `Unsupported action: '${action}'`,
                error_code: 'invalid_action',
            };
        }

        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: true,
            result_data: {
                library_id,
                action,
                collection_key,
                new_name: new_name ?? null,
                new_parent_key: new_parent_key ?? null,
                items_affected: action === 'delete' ? (oldItemIds?.length ?? 0) : null,
                old_name: oldName,
                old_parent_key: oldParentKey,
                old_item_ids: oldItemIds,
                had_subcollections: hadSubcollections,
            },
        };
    } catch (error) {
        if (error instanceof TimeoutError) {
            throw error;
        }
        logger(`executeManageCollectionsAction: Failed: ${error}`, 1);
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: String(error),
            error_code: 'execution_failed',
        };
    }
}
