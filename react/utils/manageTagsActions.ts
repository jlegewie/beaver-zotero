/**
 * Utilities for executing and undoing manage_tags agent actions.
 * Used by AgentActionView for post-run apply/undo.
 *
 * Design:
 *  - `executeManageTagsAction` re-snapshots the pre-apply state at execute
 *    time (items that have the tag + tag color + merge re-check) and returns
 *    it in ManageTagsResultData. This is the authoritative snapshot used by
 *    undo. A re-apply after manual library edits overwrites it with a fresh
 *    snapshot.
 *  - `undoManageTagsAction` reads the snapshot from `action.result_data` —
 *    NOT `action.proposed_data`, which only carries the agent's proposal.
 *
 * Zotero APIs (see tags.js in zotero-main):
 *   - Zotero.Tags.rename(libraryID, oldName, newName): atomic rename; merges
 *     if newName already exists (UPDATE OR REPLACE + purge).
 *   - Zotero.Tags.removeFromLibrary(libraryID, tagIDs[]): atomic delete.
 *   - Zotero.Tags.getID(name): returns tagID or false.
 *   - Zotero.Tags.getTagItems(libraryID, tagID): returns itemID[].
 *   - Zotero.Tags.getColor/setColor: color snapshot.
 */

import { AgentAction } from '../agents/agentActions';
import type { ManageTagsProposedData, ManageTagsResultData, TagColorSnapshot } from '../types/agentActions/base';
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


export async function executeManageTagsAction(
    action: AgentAction
): Promise<ManageTagsResultData> {
    const data = action.proposed_data as ManageTagsProposedData;
    const { library_id, action: op, name, new_name } = data;

    // Snapshot the authoritative pre-apply state RIGHT BEFORE the op.
    const tagID = Zotero.Tags.getID(name);
    let affectedItemIds: string[] = [];
    if (tagID !== false && tagID != null) {
        try {
            const ids = await Zotero.Tags.getTagItems(library_id, tagID);
            if (ids.length > MAX_SNAPSHOT_ITEMS) {
                throw new Error(`Tag '${name}' is used on ${ids.length} items (over the ${MAX_SNAPSHOT_ITEMS} safety cap)`);
            }
            affectedItemIds = await itemIdsToKeys(library_id, ids);
        } catch (e) {
            logger(`executeManageTagsAction: getTagItems snapshot failed: ${e}`, 1);
        }
    }
    const rawColor = Zotero.Tags.getColor(library_id, name);
    const oldColor: TagColorSnapshot | null = rawColor && typeof rawColor === 'object'
        ? { color: (rawColor as any).color, position: (rawColor as any).position }
        : null;

    let isMerge: boolean | null = null;

    if (op === 'rename') {
        const target = (new_name ?? '').trim();
        if (!target) throw new Error('new_name required for rename');
        const existingTarget = Zotero.Tags.getID(target);
        isMerge = existingTarget !== false && existingTarget != null;
        await Zotero.Tags.rename(library_id, name, target);
        logger(`executeManageTagsAction: Renamed '${name}' → '${target}' in library ${library_id}`, 1);
    } else if (op === 'delete') {
        if (tagID === false || tagID == null) {
            logger(`executeManageTagsAction: Tag '${name}' not found; treating as already deleted`, 1);
        } else {
            // onProgress and types are optional at runtime despite zotero-types .d.ts
            await (Zotero.Tags.removeFromLibrary as any)(library_id, [tagID]);
            logger(`executeManageTagsAction: Deleted '${name}' from library ${library_id}`, 1);
        }
    } else {
        throw new Error(`Unsupported manage_tags action: ${op}`);
    }

    return {
        library_id,
        action: op,
        name,
        new_name: new_name ?? null,
        items_affected: affectedItemIds.length,
        affected_item_ids: affectedItemIds,
        old_color: oldColor,
        is_merge: isMerge,
    };
}


/**
 * Undo a manage_tags action.
 *
 * Reads the pre-apply snapshot from `action.result_data` (captured at the
 * most recent apply). Falls back to an empty snapshot with a warning if
 * result_data is missing — which should not happen for an applied action.
 *
 * - `rename` without merge: atomic rename back to original name.
 * - `rename` WITH merge: cannot cleanly reverse the merge. Re-tags the
 *   snapshot; items that had both tags before the merge keep the target tag.
 * - `delete`: re-add the tag to items in the snapshot.
 *
 * In all cases the tag color (if any) is restored.
 */
export async function undoManageTagsAction(
    action: AgentAction
): Promise<void> {
    const data = action.proposed_data as ManageTagsProposedData;
    const { library_id, action: op, name, new_name } = data;
    const result = (action.result_data ?? {}) as Partial<ManageTagsResultData>;
    const affected_item_ids = result.affected_item_ids ?? [];
    const old_color = result.old_color ?? null;
    const is_merge = result.is_merge ?? null;

    const restoreColor = async () => {
        if (!old_color) return;
        try {
            const c: TagColorSnapshot = old_color;
            await Zotero.Tags.setColor(library_id, name, c.color, c.position ?? 0);
        } catch (e) {
            logger(`undoManageTagsAction: Failed to restore color: ${e}`, 1);
        }
    };

    if (op === 'rename') {
        const target = (new_name ?? '').trim();
        if (!target) throw new Error('new_name missing — cannot undo');

        if (!is_merge) {
            await Zotero.Tags.rename(library_id, target, name);
            await restoreColor();
            logger(`undoManageTagsAction: Renamed '${target}' → '${name}' (undo)`, 1);
            return;
        }

        // Merge case: re-tag items that had the source tag before the merge.
        if (affected_item_ids.length === 0) {
            logger(`undoManageTagsAction: No affected_item_ids snapshot; cannot undo merge`, 1);
            return;
        }
        await retagItems(library_id, affected_item_ids, name);
        await restoreColor();
        logger(`undoManageTagsAction: Re-tagged ${affected_item_ids.length} items with '${name}' (merge undo)`, 1);
    } else if (op === 'delete') {
        if (affected_item_ids.length === 0) {
            logger(`undoManageTagsAction: No affected_item_ids snapshot; nothing to restore`, 1);
            await restoreColor();
            return;
        }
        await retagItems(library_id, affected_item_ids, name);
        await restoreColor();
        logger(`undoManageTagsAction: Re-added tag '${name}' to ${affected_item_ids.length} items (delete undo)`, 1);
    } else {
        throw new Error(`Unsupported manage_tags action: ${op}`);
    }
}


async function retagItems(libraryId: number, itemIds: string[], tagName: string): Promise<void> {
    const items: Zotero.Item[] = [];
    for (const itemId of itemIds) {
        const parts = splitItemId(itemId);
        if (!parts) continue;
        try {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(parts.libraryId, parts.zoteroKey);
            if (item) items.push(item);
        } catch (_) {
            // skip
        }
    }
    if (items.length === 0) return;

    await Zotero.DB.executeTransaction(async () => {
        for (const item of items) {
            const existing = new Set(item.getTags().map((t: { tag: string }) => t.tag));
            if (!existing.has(tagName)) {
                item.addTag(tagName);
                await item.save();
            }
        }
    });
}
