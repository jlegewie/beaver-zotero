/**
 * Utilities for executing and undoing manage_collections agent actions
 * from the UI (post-run apply / undo).
 *
 * Design:
 *  - `executeManageCollectionsAction` re-snapshots the pre-apply state at
 *    execute time (collection name, parent) and returns it in
 *    ManageCollectionsResultData. This snapshot is what rename/move undo
 *    consume. A re-apply after manual library edits overwrites it.
 *  - Delete uses Zotero's soft delete (`collection.deleted = true; saveTx()`).
 *    This keeps the key stable, and `collectionItems` rows are preserved.
 *    Undo is a one-line restore-from-trash.
 *  - Delete is refused when the collection has direct subcollections,
 *    so undo only ever has to flip a single row in `deletedCollections`.
 *  - Permanent erase only happens when the user explicitly empties the trash
 *    (or deletes the collection permanently from the Trash view).
 *
 * Zotero APIs:
 *   - collection.name = ...; await collection.saveTx(): rename.
 *   - collection.parentKey = key | false; await collection.saveTx(): move.
 *     `false` promotes to top-level (see collection.js parentKey setter).
 *   - collection.deleted = true|false; await collection.saveTx(): trash/restore.
 *   - Zotero.Collections.getByLibraryAndKeyAsync() returns trashed collections
 *     too (no `includeTrashed` filter on primary lookup) — check the
 *     `deleted` property to detect trash state.
 */

import { AgentAction, ManageCollectionsAgentAction } from '../agents/agentActions';
import type { ManageCollectionsProposedData, ManageCollectionsResultData } from '../types/agentActions/base';
import { logger } from '../../src/utils/logger';


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
    let itemsAffected: number | null = null;
    if (op === 'delete') {
        // Mirror the validator: refuse delete when subcollections exist. With
        // soft-delete the subtree would cascade into trash, but each descendant
        // would have its own `deletedCollections` row — restoring only the
        // parent wouldn't bring them back. Force the agent to walk leaves first.
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
        itemsAffected = (collection.getChildItems(true, false) as number[]).length;
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
        (collection as any).deleted = true;
        await collection.saveTx();
        logger(`executeManageCollectionsAction: Trashed collection ${library_id}-${collection_key}`, 1);
    } else {
        throw new Error(`Unsupported manage_collections action: ${op}`);
    }

    return {
        library_id,
        action: op,
        collection_key,
        new_name: new_name ?? null,
        new_parent_key: new_parent_key ?? null,
        items_affected: itemsAffected,
        old_name: oldName,
        old_parent_key: oldParentKey,
    };
}


/**
 * Undo a manage_collections action.
 *
 * Reads the pre-apply snapshot from `action.result_data` (captured at the
 * most recent apply).
 *
 * - `rename`: restore old_name.
 * - `move`: restore old_parent_key.
 * - `delete`: flip `deleted = false` on the trashed collection.
 */
export async function undoManageCollectionsAction(
    action: AgentAction,
): Promise<void> {
    const data = action.proposed_data as ManageCollectionsProposedData;
    const { library_id, action: op, collection_key } = data;
    const result = (action.result_data ?? {}) as Partial<ManageCollectionsResultData>;
    const old_name = result.old_name ?? null;
    const old_parent_key = result.old_parent_key ?? null;

    if (op === 'rename') {
        const collection = await Zotero.Collections.getByLibraryAndKeyAsync(library_id, collection_key);
        if (!collection) {
            logger(`undoManageCollectionsAction: Collection ${library_id}-${collection_key} not found; skipping`, 1);
            return;
        }
        const originalName = (old_name ?? '').trim();
        if (!originalName) throw new Error('old_name missing in result_data — cannot undo rename');
        collection.name = originalName;
        await collection.saveTx();
        logger(`undoManageCollectionsAction: Restored name '${originalName}'`, 1);
        return;
    }

    if (op === 'move') {
        const collection = await Zotero.Collections.getByLibraryAndKeyAsync(library_id, collection_key);
        if (!collection) {
            logger(`undoManageCollectionsAction: Collection ${library_id}-${collection_key} not found; skipping`, 1);
            return;
        }
        (collection as any).parentKey = old_parent_key ? old_parent_key : false;
        await collection.saveTx();
        logger(`undoManageCollectionsAction: Restored parent '${old_parent_key ?? 'top-level'}'`, 1);
        return;
    }

    if (op === 'delete') {
        const collection = await Zotero.Collections.getByLibraryAndKeyAsync(library_id, collection_key);
        if (!collection) {
            // Trash was emptied (manually or by auto-empty). The collection
            // is gone from the DB and its key is unrecoverable.
            const label = old_name ? `'${old_name}'` : collection_key;
            throw new Error(
                `Collection ${label} was permanently deleted from the trash and cannot be restored.`
            );
        }
        if (!(collection as any).deleted) {
            // Already restored (e.g. user clicked "Restore to Library" in
            // Zotero). Treat as success.
            logger(`undoManageCollectionsAction: Collection ${library_id}-${collection_key} already restored; skipping`, 1);
            return;
        }
        (collection as any).deleted = false;
        await collection.saveTx();
        logger(`undoManageCollectionsAction: Restored collection '${collection.name}' from trash`, 1);
        return;
    }

    throw new Error(`Unsupported manage_collections action: ${op}`);
}


/**
 * Undo a batch of manage_collections actions in reverse-chronological order.
 * Per-action failures are logged and do not stop the loop.
 */
export async function undoManageCollectionsActions(
    actions: ManageCollectionsAgentAction[]
): Promise<void> {
    for (const action of [...actions].reverse()) {
        try {
            await undoManageCollectionsAction(action);
        } catch (error) {
            logger(`undoManageCollectionsActions: Failed to undo action ${action.id}: ${error}`, 1);
        }
    }
}
