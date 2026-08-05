/**
 * Validate and execute library-wide collection operations (manage_collections).
 *
 * Supports three actions:
 *   - 'rename': changes the collection name.
 *   - 'move':   reparents the collection. new_parent_key=null means top-level.
 *               Rejects cycles (moving into self or a descendant) and
 *               cross-library moves (Zotero requires copy+delete).
 *   - 'delete': soft-deletes the collection (collection.deleted = true; saveTx)
 *               Refuses if the collection has direct subcollections.
 *
 * Snapshots (old_name, old_parent_key) are captured at execute time to
 * support undo for rename/move. Delete undo is a plain restore-from-trash
 * and doesn't need an item-level snapshot.
 */

import {
    WSAgentActionValidateRequest,
    WSAgentActionValidateResponse,
    WSAgentActionExecuteRequest,
    WSAgentActionExecuteResponse,
} from '@beaver/agent-core/protocol/agentProtocol';
import {
    checkLibraryExcluded,
    excludedLibraryMessage,
    getDeferredToolPreference,
    getSearchableLibraryIds,
    isLibrarySearchable,
    parseScopedCollectionId,
    resolveCollectionForWrite,
} from '../utils';
import {
    libraryRefForLibraryID,
    resolveWriteTargetLibrary,
    UNRESOLVED_LIBRARY_ID,
    writeTargetLibraryError,
} from '../../../utils/libraryIdentity';
import { TimeoutContext, checkAborted, TimeoutError } from '../timeout';
import { logger } from '@beaver/agent-core/platform/logger';

interface SubcollectionSummary {
    key: string;
    name: string;
    item_count: number;
}


/**
 * Summarize direct child collections of `collection` (not deep descendants —
 * the agent should walk one level at a time so deletion stays explicit).
 * Returns name, key and direct item count for each, excluding trashed.
 */
function summarizeChildCollections(collection: any): SubcollectionSummary[] {
    const children: any[] = collection.getChildCollections(false, false);
    return children.map((child) => ({
        key: String(child.key),
        name: String(child.name),
        item_count: (child.getChildItems(true, false) as number[]).length,
    }));
}


function formatSubcollectionList(subs: SubcollectionSummary[]): string {
    return subs
        .map((s) => `  - '${s.name}' (key=${s.key}, ${s.item_count} item${s.item_count === 1 ? '' : 's'})`)
        .join('\n');
}


/**
 * When a collection lookup fails, check whether the key actually belongs to a
 * library item so we can tell the agent it pointed a collection-only tool at
 * the wrong object type. Returns a human-readable type label, or null if the
 * key is not an item.
 */
async function classifyNonCollectionKey(
    key: string,
    libraryIdHint: number | undefined,
): Promise<string | null> {
    // Best-effort on an error path. Scoped to the searchable libraries: this
    // message tells the agent what a key points at, and a library excluded from
    // Beaver must not disclose what it holds.
    try {
        const libraryIds = libraryIdHint !== undefined
            ? [libraryIdHint].filter(isLibrarySearchable)
            : getSearchableLibraryIds();
        for (const libraryID of libraryIds) {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
            if (item) {
                if (typeof (item as any).isAnnotation === 'function' && (item as any).isAnnotation()) return 'annotation';
                if (item.isAttachment()) return 'attachment';
                if (item.isNote()) return 'note';
                if (item.isRegularItem()) return 'regular library item';
                return 'library item';
            }
        }
    } catch {
        // Fall through to null — caller emits 'collection_not_found'.
    }
    return null;
}


export async function validateManageCollectionsAction(
    request: WSAgentActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    const { action, collection_key: rawCollectionKey, new_name: rawNewName, new_parent_key: rawNewParentKey, library_id: rawLibraryId, library_ref } = request.action_data as {
        action: 'rename' | 'move' | 'delete';
        collection_key: string;
        new_name?: string | null;
        new_parent_key?: string | null;
        library_id?: number | null;
        library_ref?: string | null;
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
    // A present library_ref is authoritative: resolve it strictly (exactly as
    // executeManageCollectionsAction does) so validate fails a malformed or
    // unavailable ref instead of falling back to a stale library_id and
    // scoping the collection lookup to the wrong library.
    let refLibraryId: number | undefined;
    if (library_ref) {
        const resolution = resolveWriteTargetLibrary({ library_ref, library_id: rawLibraryId });
        if (!resolution.ok) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                ...writeTargetLibraryError(resolution),
                preference: 'always_ask',
            };
        }
        refLibraryId = resolution.libraryID;
    }
    const hintLibraryId = refLibraryId
        ?? (typeof rawLibraryId === 'number' && rawLibraryId > 0 ? rawLibraryId : undefined);

    // Consistency check: when both the scoped collection_key and the separate
    // library_id are sent, they must agree.
    const scopedCollectionId = parseScopedCollectionId(trimmedCollectionKey);
    // The identifier embedded a portable library_ref this device can't map to a
    // local library. Report unavailability rather than resolving against the
    // unresolved sentinel.
    if (scopedCollectionId?.library_id === UNRESOLVED_LIBRARY_ID) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `The collection's library (${trimmedCollectionKey}) is not available on this computer.`,
            error_code: 'library_unavailable',
            preference: 'always_ask',
        };
    }
    if (scopedCollectionId && hintLibraryId !== undefined && scopedCollectionId.library_id !== hintLibraryId) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `collection_key embeds library ${scopedCollectionId.library_id} but library_id=${hintLibraryId} was also provided`,
            error_code: 'invalid_library_id',
            preference: 'always_ask',
        };
    }

    // The named library may come straight from the model, so it is
    // exclusion-checked before the collection is resolved: an excluded library
    // must not disclose whether the collection exists in it.
    if (hintLibraryId !== undefined) {
        const excluded = checkLibraryExcluded(hintLibraryId);
        if (excluded) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: excluded.message,
                error_code: 'library_not_searchable',
                preference: 'always_ask',
            };
        }
    }

    // A request that named a library confines the reference to it; otherwise any
    // searchable library may resolve it. A scoped identifier carries its own
    // library either way. Names are rejected: this tool acts on one collection,
    // and a name can denote several.
    const explicitLibrary = hintLibraryId !== undefined;
    const resolution = resolveCollectionForWrite(trimmedCollectionKey, {
        eligibleLibraryIds: explicitLibrary ? [hintLibraryId] : getSearchableLibraryIds(),
        explicitLibrary,
    });
    if (!resolution.ok) {
        if (resolution.code === 'collection_not_found') {
            // The key matched no collection. Check whether it belongs to a
            // library item so the agent gets a specific error instead of a bare
            // "not found" — the recurring failure is the agent passing a note /
            // item / attachment / annotation key to this collection-only tool.
            const objectType = await classifyNonCollectionKey(
                scopedCollectionId?.zotero_key ?? trimmedCollectionKey,
                scopedCollectionId?.library_id ?? hintLibraryId,
            );
            if (objectType) {
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error:
                        `The key '${rawCollectionKey}' refers to a ${objectType}, not a collection. ` +
                        `manage_collections operates only on collections (folders). It cannot rename, ` +
                        `move, or delete library items, notes, attachments, or annotations. ` +
                        `If the user asked to delete this object, tell them to do it manually in Zotero.`,
                    error_code: 'not_a_collection',
                    preference: 'always_ask',
                };
            }
        }
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: resolution.message,
            error_code: resolution.code,
            preference: 'always_ask',
        };
    }

    const collection = resolution.match.collection;
    const libraryID = resolution.match.libraryID;
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
            error: excludedLibraryMessage(libraryID),
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
            // Accept a scoped identifier or a plain key. A scoped identifier
            // must reference the same library as the child being moved (Zotero
            // can't reparent across libraries — that's a copy).
            const scopedParentId = parseScopedCollectionId(trimmedParent);
            if (scopedParentId && scopedParentId.library_id !== libraryID) {
                const parentLocation = scopedParentId.library_id === UNRESOLVED_LIBRARY_ID
                    ? 'a library that is not available on this computer'
                    : `library ${scopedParentId.library_id}`;
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: `new_parent_key '${trimmedParent}' is in ${parentLocation}, but the collection is in library ${libraryID}. Cross-library moves are not supported.`,
                    error_code: 'invalid_parent',
                    preference: 'always_ask',
                };
            }
            const parentResolution = resolveCollectionForWrite(trimmedParent, {
                eligibleLibraryIds: [libraryID],
                explicitLibrary: true,
            });
            if (!parentResolution.ok) {
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: parentResolution.code === 'collection_not_found'
                        ? `Parent collection not found in library '${library.name}': ${trimmedParent}`
                        : parentResolution.message,
                    error_code: parentResolution.code === 'collection_not_found' ? 'parent_not_found' : 'invalid_parent',
                    preference: 'always_ask',
                };
            }
            const parent = parentResolution.match.collection;
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
    if (action === 'delete') {
        // Refuse delete when subcollections exist. Recursive delete would
        // erase the whole subtree but undo can only restore the top-level
        // collection (with a new key), losing structure silently. Force the
        // agent to walk leaves first so the user sees and approves each level.
        if (collection.hasChildCollections(false)) {
            const subs = summarizeChildCollections(collection);
            const list = formatSubcollectionList(subs);
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error:
                    `Cannot delete collection '${collection.name}' because it contains ${subs.length} subcollection${subs.length === 1 ? '' : 's'}. ` +
                    `Delete or move each subcollection first, then retry:\n${list}`,
                error_code: 'has_subcollections',
                preference: 'always_ask',
            };
        }
        oldItemCount = (collection.getChildItems(true, false) as number[]).length;
    }

    const preference = getDeferredToolPreference('manage_collections');

    return {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: true,
        current_value: {
            library_id: libraryID,
            library_ref: libraryRefForLibraryID(libraryID) ?? undefined,
            library_name: library.name,
            action,
            collection_key: collection.key,
            collection_name: oldName,
            old_name: oldName,
            old_parent_key: oldParentKey,
            old_item_count: oldItemCount,
        },
        // Normalize to plain scalars so execute, the persisted AgentAction, and
        // the UI apply/undo path all see the resolved library_id + 8-char keys
        // regardless of whether the agent sent a compound '<lib>-<key>' form.
        // Snapshots are captured at execute time, not here.
        normalized_action_data: {
            library_id: libraryID,
            library_ref: libraryRefForLibraryID(libraryID) ?? undefined,
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
    const { action, collection_key, new_name, new_parent_key, library_id, library_ref } = request.action_data as {
        action: 'rename' | 'move' | 'delete';
        collection_key: string;
        new_name?: string | null;
        new_parent_key?: string | null;
        library_id: number;
        library_ref?: string | null;
    };

    // A device-portable library_ref is a valid target on its own, so only
    // reject when neither a usable library_id nor a library_ref is present.
    if ((!library_id || typeof library_id !== 'number') && !library_ref) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: 'library_id missing or invalid in action_data',
            error_code: 'invalid_library_id',
        };
    }

    const targetResolution = resolveWriteTargetLibrary({ library_id, library_ref });
    if (!targetResolution.ok) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            ...writeTargetLibraryError(targetResolution),
        };
    }
    const resolvedLibraryId = targetResolution.libraryID;

    // TOCTOU guard: never rename/move/delete collections in a library the user
    // excluded from Beaver, even if validation passed earlier or was skipped.
    const excluded = checkLibraryExcluded(resolvedLibraryId);
    if (excluded) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: excluded.message,
            error_code: 'library_not_searchable',
        };
    }

    try {
        // Validation resolves collection_key to a bare key, but an action
        // executed without going through it still carries what the agent wrote,
        // which may be a scoped identifier.
        const collectionResolution = resolveCollectionForWrite(collection_key, {
            eligibleLibraryIds: [resolvedLibraryId],
            explicitLibrary: true,
        });
        if (!collectionResolution.ok) {
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: collectionResolution.message,
                error_code: collectionResolution.code,
            };
        }
        const collection = collectionResolution.match.collection;

        // Re-snapshot the authoritative pre-apply state at execute time.
        // A re-apply after manual library edits produces a fresh snapshot
        // that the next undo can correctly reverse.
        const oldName: string = collection.name;
        const oldParentKey: string | null = collection.parentKey ? String(collection.parentKey) : null;
        let itemsAffected: number | null = null;
        if (action === 'delete') {
            // Defensive re-check: subcollections may have been added between
            // validation and execute (manual edit, race). Refuse here too so
            // the undo contract ("single collection, items stay attached")
            // always holds.
            if (collection.hasChildCollections(false)) {
                const subs = summarizeChildCollections(collection);
                const list = formatSubcollectionList(subs);
                return {
                    type: 'agent_action_execute_response',
                    request_id: request.request_id,
                    success: false,
                    error:
                        `Cannot delete collection '${oldName}' because it now contains ${subs.length} subcollection${subs.length === 1 ? '' : 's'}. ` +
                        `Delete or move each subcollection first, then retry:\n${list}`,
                    error_code: 'has_subcollections',
                };
            }
            itemsAffected = (collection.getChildItems(true, false) as number[]).length;
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
            logger(`executeManageCollectionsAction: Renamed collection ${resolvedLibraryId}-${collection_key} → '${target}'`, 1);
        } else if (action === 'move') {
            // Zotero uses `false` to signal top-level (see collection.js parentKey setter).
            checkAborted(ctx, 'manage_collections:before_move');
            let parentKeyToApply: string | false = false;
            if (new_parent_key) {
                const parentResolution = resolveCollectionForWrite(new_parent_key, {
                    eligibleLibraryIds: [resolvedLibraryId],
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
                parentKeyToApply = parentResolution.match.collection.key;
            }
            (collection as any).parentKey = parentKeyToApply;
            await collection.saveTx();
            logger(`executeManageCollectionsAction: Moved collection ${resolvedLibraryId}-${collection_key} to parent ${new_parent_key ?? 'top-level'}`, 1);
        } else if (action === 'delete') {
            checkAborted(ctx, 'manage_collections:before_delete');
            // Soft-delete (trash): collection is hidden from the library view,
            // items stay attached via collectionItems. Reversible with
            // `collection.deleted = false; saveTx()` until the user explicitly
            // empties the trash — Zotero's `trashAutoEmptyDays` timer only
            // auto-empties trashed items, not trashed collections
            // (see Zotero.Items.startEmptyTrashTimer in items.js).
            (collection as any).deleted = true;
            await collection.saveTx();
            logger(`executeManageCollectionsAction: Trashed collection ${resolvedLibraryId}-${collection_key}`, 1);
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
                library_id: resolvedLibraryId,
                library_ref: libraryRefForLibraryID(resolvedLibraryId) ?? undefined,
                action,
                collection_key,
                new_name: new_name ?? null,
                new_parent_key: new_parent_key ?? null,
                items_affected: itemsAffected,
                old_name: oldName,
                old_parent_key: oldParentKey,
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
