/**
 * Utilities for executing and undoing manage_collections agent actions.
 * Used by AgentActionView for post-run apply/undo.
 *
 * Design:
 *  - `executeManageCollectionsAction` re-snapshots the pre-apply state at
 *    execute time (collection name, parent, items if delete) and returns it
 *    in ManageCollectionsResultData. This is the authoritative snapshot used
 *    by undo. A re-apply after manual library edits overwrites it with a
 *    fresh snapshot.
 *  - `undoManageCollectionsAction` reads the snapshot from
 *    `action.result_data` — NOT `action.proposed_data`.
 *  - Delete refuses if the collection has direct subcollections at apply
 *    time. Recursive delete cannot be cleanly undone (the subtree would
 *    silently vanish), so the agent must delete leaves first.
 *
 * Zotero APIs:
 *   - collection.name = ...; await collection.saveTx(): rename.
 *   - collection.parentKey = key | false; await collection.saveTx(): move.
 *     `false` promotes to top-level (see collection.js parentKey setter).
 *   - await collection.eraseTx(): delete. Items become unfiled, not trashed,
 *     when deleteItems option is not set.
 *   - new Zotero.Collection({name, libraryID, parentID?}): create for undo.
 */

import { AgentAction, ManageCollectionsAgentAction } from '../agents/agentActions';
import type { ManageCollectionsProposedData, ManageCollectionsResultData } from '../types/agentActions/base';
import { logger } from '../../src/utils/logger';

const MAX_SNAPSHOT_ITEMS = 5000;


function splitItemId(itemId: string): { libraryId: number; zoteroKey: string } | null {
    const parts = itemId.split('-');
    if (parts.length < 2) return null;
    const libraryId = parseInt(parts[0], 10);
    if (isNaN(libraryId)) return null;
    return { libraryId, zoteroKey: parts.slice(1).join('-') };
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


export async function executeManageCollectionsAction(
    action: AgentAction
): Promise<ManageCollectionsResultData> {
    const data = action.proposed_data as ManageCollectionsProposedData;
    const { library_id, action: op, collection_key, new_name, new_parent_key } = data;

    const collection = await Zotero.Collections.getByLibraryAndKeyAsync(library_id, collection_key);
    if (!collection) {
        throw new Error(`Collection not found: ${collection_key}`);
    }

    // Snapshot the authoritative pre-apply state RIGHT BEFORE the op.
    const oldName: string = collection.name;
    const oldParentKey: string | null = collection.parentKey ? String(collection.parentKey) : null;
    let oldItemIds: string[] | undefined;
    if (op === 'delete') {
        // Mirror the validator: refuse delete when subcollections exist so a
        // re-apply via the UI never silently erases a subtree.
        if (collection.hasChildCollections(false)) {
            const subs: any[] = collection.getChildCollections(false, false);
            const list = subs
                .map((c: any) => {
                    const items = (c.getChildItems(true, false) as number[]).length;
                    return `  - '${c.name}' (key=${c.key}, ${items} item${items === 1 ? '' : 's'})`;
                })
                .join('\n');
            throw new Error(
                `Cannot delete collection '${oldName}' because it contains ${subs.length} subcollection${subs.length === 1 ? '' : 's'}. Delete or move each subcollection first:\n${list}`
            );
        }
        const childItemIDs = collection.getChildItems(true, false) as number[];
        if (childItemIDs.length > MAX_SNAPSHOT_ITEMS) {
            throw new Error(`Collection '${oldName}' contains ${childItemIDs.length} items (over the ${MAX_SNAPSHOT_ITEMS} safety cap for undo snapshot)`);
        }
        oldItemIds = await itemIdsToKeys(library_id, childItemIDs);
    }

    if (op === 'rename') {
        const target = (new_name ?? '').trim();
        if (!target) throw new Error('new_name required for rename');
        collection.name = target;
        await collection.saveTx();
        logger(`executeManageCollectionsAction: Renamed collection ${library_id}-${collection_key}`, 1);
    } else if (op === 'move') {
        (collection as any).parentKey = new_parent_key ? new_parent_key : false;
        await collection.saveTx();
        logger(`executeManageCollectionsAction: Moved collection ${library_id}-${collection_key}`, 1);
    } else if (op === 'delete') {
        await collection.eraseTx();
        logger(`executeManageCollectionsAction: Deleted collection ${library_id}-${collection_key}`, 1);
    } else {
        throw new Error(`Unsupported manage_collections action: ${op}`);
    }

    return {
        library_id,
        action: op,
        collection_key,
        new_name: new_name ?? null,
        new_parent_key: new_parent_key ?? null,
        items_affected: op === 'delete' ? (oldItemIds?.length ?? 0) : null,
        old_name: oldName,
        old_parent_key: oldParentKey,
        old_item_ids: oldItemIds,
    };
}


/**
 * Undo a manage_collections action.
 *
 * Reads the pre-apply snapshot from `action.result_data` (captured at the
 * most recent apply). Falls back to empty with a warning if missing.
 *
 * - `rename`: restore old_name.
 * - `move`: restore old_parent_key (translated through keyMap if the former
 *   parent was itself deleted and recreated earlier in this undo pass).
 * - `delete`: recreate a collection with the same name and parent, then
 *   re-add items from the snapshot. Recreated collection gets a NEW key,
 *   which is returned in `new_collection_key` so callers can extend the
 *   keyMap for subsequent undos. (Delete is refused if subcollections
 *   existed, so undo never has to reconstruct a subtree.)
 *
 * keyMap: maps original-pre-delete keys to the newly-created keys. When a
 *   parent collection was deleted and later undone, its key changed; this
 *   map lets child undos resolve the new parent without relying on names.
 */
export async function undoManageCollectionsAction(
    action: AgentAction,
    keyMap?: Map<string, string>,
): Promise<ManageCollectionsResultData | null> {
    const data = action.proposed_data as ManageCollectionsProposedData;
    const { library_id, action: op, collection_key } = data;
    const result = (action.result_data ?? {}) as Partial<ManageCollectionsResultData>;
    const old_name = result.old_name ?? null;
    const rawOldParentKey = result.old_parent_key ?? null;
    const old_parent_key = rawOldParentKey ? (keyMap?.get(rawOldParentKey) ?? rawOldParentKey) : null;
    const old_item_ids = result.old_item_ids ?? [];

    if (op === 'rename') {
        const collection = await Zotero.Collections.getByLibraryAndKeyAsync(library_id, collection_key);
        if (!collection) {
            logger(`undoManageCollectionsAction: Collection ${library_id}-${collection_key} not found; skipping`, 1);
            return null;
        }
        const originalName = (old_name ?? '').trim();
        if (!originalName) throw new Error('old_name missing in result_data — cannot undo rename');
        collection.name = originalName;
        await collection.saveTx();
        logger(`undoManageCollectionsAction: Restored name '${originalName}'`, 1);
        return null;
    }

    if (op === 'move') {
        const collection = await Zotero.Collections.getByLibraryAndKeyAsync(library_id, collection_key);
        if (!collection) {
            logger(`undoManageCollectionsAction: Collection ${library_id}-${collection_key} not found; skipping`, 1);
            return null;
        }
        (collection as any).parentKey = old_parent_key ? old_parent_key : false;
        await collection.saveTx();
        logger(`undoManageCollectionsAction: Restored parent '${old_parent_key ?? 'top-level'}'`, 1);
        return null;
    }

    if (op === 'delete') {
        const name = (old_name ?? '').trim();
        if (!name) throw new Error('old_name missing in result_data — cannot recreate collection');

        let parentID: number | undefined;
        if (old_parent_key) {
            const parent = await Zotero.Collections.getByLibraryAndKeyAsync(library_id, old_parent_key);
            if (parent) parentID = parent.id;
        }

        const params: { name: string; libraryID: number; parentID?: number } = {
            name,
            libraryID: library_id,
        };
        if (parentID !== undefined) params.parentID = parentID;
        const recreated = new Zotero.Collection(params);
        await recreated.saveTx();

        let itemsAdded = 0;
        if (old_item_ids.length > 0) {
            const resolvedItemIDs: number[] = [];
            for (const itemId of old_item_ids) {
                const parts = splitItemId(itemId);
                if (!parts) continue;
                try {
                    const item = await Zotero.Items.getByLibraryAndKeyAsync(parts.libraryId, parts.zoteroKey);
                    if (item && !item.isAttachment() && !item.isNote() && !item.isAnnotation()) {
                        resolvedItemIDs.push(item.id);
                    }
                } catch (_) { /* skip */ }
            }
            if (resolvedItemIDs.length > 0) {
                await Zotero.DB.executeTransaction(async () => {
                    await recreated.addItems(resolvedItemIDs);
                });
                itemsAdded = resolvedItemIDs.length;
            }
        }

        logger(`undoManageCollectionsAction: Recreated collection '${name}' with key ${recreated.key} and re-added ${itemsAdded} items`, 1);
        return {
            library_id,
            action: 'delete',
            collection_key,
            items_affected: itemsAdded,
            new_collection_key: recreated.key,
        };
    }

    throw new Error(`Unsupported manage_collections action: ${op}`);
}


/**
 * Undo a batch of manage_collections actions in reverse-chronological order.
 *
 * Builds an oldKey→newKey map across the loop so that when a former parent
 * was itself deleted and is recreated earlier in this pass, a later child
 * undo resolves its old_parent_key to the new key instead of the
 * gone-forever original. Per-action failures are logged and do not stop
 * the loop (matches prior inline behavior).
 */
export async function undoManageCollectionsActions(
    actions: ManageCollectionsAgentAction[]
): Promise<void> {
    const collectionKeyMap = new Map<string, string>();
    for (const action of [...actions].reverse()) {
        try {
            const res = await undoManageCollectionsAction(action, collectionKeyMap);
            if (res?.action === 'delete' && res.new_collection_key) {
                collectionKeyMap.set(action.proposed_data.collection_key, res.new_collection_key);
            }
        } catch (error) {
            logger(`undoManageCollectionsActions: Failed to undo action ${action.id}: ${error}`, 1);
        }
    }
}
