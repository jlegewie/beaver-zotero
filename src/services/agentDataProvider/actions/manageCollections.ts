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
import { getDeferredToolPreference, isLibrarySearchable, getCollectionByIdOrName } from '../utils';
import { TimeoutContext, checkAborted, TimeoutError } from '../timeout';
import { logger } from '../../../utils/logger';

const MAX_SNAPSHOT_ITEMS = 5000;

/**
 * Parse a collection identifier that may be a plain 8-char Zotero key or a
 * compound '<libraryID>-<key>' string. Returns { libraryId, key } where
 * libraryId is null if the input was a plain key.
 */
function parseCollectionRef(ref: string): { libraryId: number | null; key: string } {
    const compound = ref.match(/^(\d+)-(.+)$/);
    if (compound) {
        return { libraryId: parseInt(compound[1], 10), key: compound[2] };
    }
    return { libraryId: null, key: ref };
}


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
    const { action, collection_key: rawCollectionKey, new_name: rawNewName, new_parent_key: rawNewParentKey, library_id: rawLibraryId } = request.action_data as {
        action: 'rename' | 'move' | 'delete';
        collection_key: string;
        new_name?: string | null;
        new_parent_key?: string | null;
        library_id?: number | null;
    };

    if (!rawCollectionKey || typeof rawCollectionKey !== 'string' || !rawCollectionKey.trim()) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'collection_key cannot be empty',
            error_code: 'invalid_collection_key',
            preference: 'always_ask',
        };
    }

    const trimmedCollectionKey = rawCollectionKey.trim();
    const hintLibraryId = typeof rawLibraryId === 'number' && rawLibraryId > 0 ? rawLibraryId : undefined;

    // Consistency check: when both the compound collection_key and the
    // separate library_id are sent, they must agree. (library_id is on its
    // way out — once all agents send compound collection_key it can be
    // dropped from the schema.)
    const parsed = parseCollectionRef(trimmedCollectionKey);
    if (parsed.libraryId !== null && hintLibraryId !== undefined && parsed.libraryId !== hintLibraryId) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `collection_key embeds library ${parsed.libraryId} but library_id=${hintLibraryId} was also provided`,
            error_code: 'invalid_library_id',
            preference: 'always_ask',
        };
    }

    // Pass the raw input through getCollectionByIdOrName. It handles the
    // compound form strictly (lookup scoped to the embedded library with no
    // cross-library fallback), and uses library_id as a hint for plain keys.
    const effectiveLibraryId = parsed.libraryId ?? hintLibraryId;
    const lookup = getCollectionByIdOrName(trimmedCollectionKey, effectiveLibraryId);
    if (!lookup) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Collection not found: ${rawCollectionKey}`,
            error_code: 'collection_not_found',
            preference: 'always_ask',
        };
    }

    const collection = lookup.collection;
    const libraryID = lookup.libraryID;
    const library = Zotero.Libraries.get(libraryID);
    if (!library) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library not found for collection '${rawCollectionKey}'`,
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
        const trimmedParent = rawNewParentKey ? rawNewParentKey.trim() || null : null;
        if (trimmedParent) {
            // Accept plain 8-char key or compound '<libraryID>-<key>'. The
            // compound form must reference the same library as the child being
            // moved (Zotero can't reparent across libraries — that's a copy).
            const parsedParent = parseCollectionRef(trimmedParent);
            if (!parsedParent) {
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: `Invalid new_parent_key format: '${trimmedParent}'`,
                    error_code: 'invalid_parent',
                    preference: 'always_ask',
                };
            }
            if (parsedParent.libraryId !== null && parsedParent.libraryId !== libraryID) {
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: `new_parent_key '${trimmedParent}' is in library ${parsedParent.libraryId}, but the collection is in library ${libraryID}. Cross-library moves are not supported.`,
                    error_code: 'invalid_parent',
                    preference: 'always_ask',
                };
            }
            const parentKeyLookup = parsedParent.key;
            const parent = await Zotero.Collections.getByLibraryAndKeyAsync(libraryID, parentKeyLookup);
            if (!parent) {
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: `Parent collection not found in library '${library.name}': ${trimmedParent}`,
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
            newParentKey = parent.key;
        } else {
            newParentKey = null;
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
        // Normalize to plain scalars so execute, the persisted AgentAction, and
        // the UI apply/undo path all see the resolved library_id + 8-char keys
        // regardless of whether the agent sent a compound '<lib>-<key>' form.
        // Snapshots are captured at execute time, not here.
        normalized_action_data: {
            library_id: libraryID,
            collection_key: collection.key,
            ...(action === 'move' ? { new_parent_key: newParentKey } : {}),
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
