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
import type { ManageTagsProposedData, ManageTagsResultData, TagColorSnapshot } from '@beaver/agent-core/types/agentActions/base';
import { logger } from '@beaver/agent-core/platform/logger';
import {
    isLibraryReferencePortable,
    libraryRefForLibraryID,
    modelObjectId,
    parseItemReference,
    resolveWriteTargetLibrary,
} from '../../src/utils/libraryIdentity';
import type { UndoActionOutcome } from './undoActionOutcome';

const MAX_SNAPSHOT_ITEMS = 5000;


function snapshotItemKey(itemId: string): string | null {
    // The action's resolved target library is authoritative. Snapshot prefixes
    // may be stale device-local rowids, so only retain the stable Zotero key.
    return parseItemReference(itemId)?.zotero_key ?? null;
}


async function itemIdsToKeys(libraryID: number, itemIDs: number[]): Promise<string[]> {
    if (itemIDs.length === 0) return [];
    const items = await Zotero.Items.getAsync(itemIDs);
    const valid = items.filter((i): i is Zotero.Item => i !== null);
    if (valid.length > 0) {
        await Zotero.Items.loadDataTypes(valid, ['primaryData']);
    }
    return valid.map((item) => modelObjectId(libraryID, item.key));
}


export async function executeManageTagsAction(
    action: AgentAction
): Promise<ManageTagsResultData> {
    const data = action.proposed_data as ManageTagsProposedData;
    const { action: op, name, new_name, library_id, library_ref } = data;
    // A destructive write must carry an explicit target. Reject a
    // stale/malformed action (e.g. library_id: 0 with no library_ref) instead
    // of letting resolveWriteTargetLibrary fall back to its personal-library
    // default, which could rename/delete a same-named tag in the wrong
    // library. Mirrors the backend execute guard.
    if ((!library_id || typeof library_id !== 'number') && !library_ref) {
        throw new Error('manage_tags action is missing a target library');
    }
    // Writes resolve strictly: a present-but-invalid library_ref must fail
    // rather than fall back to a stale device-local library_id. Legacy data
    // with no library_ref still falls back to library_id.
    const resolution = resolveWriteTargetLibrary(data);
    if (!resolution.ok) throw new Error(resolution.message);
    const resolvedLibraryID = resolution.libraryID;

    // Snapshot the authoritative pre-apply state RIGHT BEFORE the op.
    // The snapshot is the only record of which items carried the tag, so it is
    // a precondition of the write rather than a best effort: without it the op
    // would go through with no way back, and an empty snapshot on the record
    // would be indistinguishable from "the tag was on nothing".
    const tagID = Zotero.Tags.getID(name);
    let affectedItemIds: string[] = [];
    if (tagID !== false && tagID != null) {
        const ids = await Zotero.Tags.getTagItems(resolvedLibraryID, tagID);
        if (ids.length > MAX_SNAPSHOT_ITEMS) {
            throw new Error(`Tag '${name}' is used on ${ids.length} items (over the ${MAX_SNAPSHOT_ITEMS} safety cap)`);
        }
        affectedItemIds = await itemIdsToKeys(resolvedLibraryID, ids);
    }
    const rawColor = Zotero.Tags.getColor(resolvedLibraryID, name);
    const oldColor: TagColorSnapshot | null = rawColor && typeof rawColor === 'object'
        ? { color: (rawColor as any).color, position: (rawColor as any).position }
        : null;

    let isMerge: boolean | null = null;

    if (op === 'rename') {
        const target = (new_name ?? '').trim();
        if (!target) throw new Error('new_name required for rename');
        // A rename only merges when the target tag is already in *this*
        // library. An unknown answer counts as a merge, which sends undo down
        // the branch that re-tags from the snapshot rather than renaming back a
        // tag that may never have been merged.
        isMerge = (await tagIsInLibrary(resolvedLibraryID, target)) !== false;
        await Zotero.Tags.rename(resolvedLibraryID, name, target);
        logger(`executeManageTagsAction: Renamed '${name}' → '${target}' in library ${resolvedLibraryID}`, 1);
    } else if (op === 'delete') {
        if (tagID === false || tagID == null) {
            logger(`executeManageTagsAction: Tag '${name}' not found; treating as already deleted`, 1);
        } else {
            // onProgress and types are optional at runtime despite zotero-types .d.ts
            await (Zotero.Tags.removeFromLibrary as any)(resolvedLibraryID, [tagID]);
            logger(`executeManageTagsAction: Deleted '${name}' from library ${resolvedLibraryID}`, 1);
        }
    } else {
        throw new Error(`Unsupported manage_tags action: ${op}`);
    }

    return {
        library_id: resolvedLibraryID,
        library_ref: libraryRefForLibraryID(resolvedLibraryID) ?? undefined,
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
 * Reads the pre-apply snapshot from `action.result_data`, captured at the most
 * recent apply. The apply refuses to write without one, so an empty snapshot
 * says the tag was on no items rather than that the record is incomplete.
 *
 * - `rename` without merge: atomic rename back to the original name.
 * - `rename` WITH merge: cannot cleanly reverse the merge. Re-tags the
 *   snapshot, but the target tag stays on those items, so this reports
 *   `partial` — as far as the undo can go, and not a clean revert.
 * - `delete`: re-add the tag to the items in the snapshot.
 *
 * In all cases the tag color (if any) is restored, and anything the undo could
 * not put back — an item it could not reach, a color it could not restore, a
 * library reference too weak to read the result — comes back `unverifiable`
 * rather than as a completed revert.
 */
export async function undoManageTagsAction(
    action: AgentAction
): Promise<UndoActionOutcome> {
    const data = action.proposed_data as ManageTagsProposedData;
    const { library_id, action: op, name, new_name } = data;
    const result = (action.result_data ?? {}) as Partial<ManageTagsResultData>;
    // The apply stamps the library it actually wrote to, with a portable ref
    // where one is computable, so it identifies the target better than the
    // proposal it was resolved from. Fall back to the proposal for a record
    // that carries no result data.
    const target_library = {
        library_ref: result.library_ref ?? data.library_ref,
        library_id: result.library_id ?? library_id,
    };
    if ((!target_library.library_id || typeof target_library.library_id !== 'number') && !target_library.library_ref) {
        logger('undoManageTagsAction: missing target library; skipping', 1);
        return 'unverifiable';
    }
    const resolution = resolveWriteTargetLibrary(target_library);
    if (!resolution.ok) {
        logger(`undoManageTagsAction: ${resolution.message} (${target_library.library_ref || target_library.library_id}); skipping`, 1);
        return 'unverifiable';
    }
    const resolvedLibraryID = resolution.libraryID;
    const affected_item_ids = result.affected_item_ids ?? [];
    const old_color = result.old_color ?? null;
    const is_merge = result.is_merge ?? null;

    // Whether what is found in the resolved library proves anything. A bare
    // group `library_id` is numbered per device, so on another device it can
    // name a different library — where the lookups below may come up empty
    // while the tag is untouched in the library the action ran in, or match a
    // same-named tag that has nothing to do with this action.
    const targetIsPortable = isLibraryReferencePortable({
        library_ref: target_library.library_ref,
        library_id: target_library.library_id ?? resolvedLibraryID,
    });

    // Reports whether the color is back where it was. A color is part of what
    // the action changed, so a restore that fails leaves a residue.
    const restoreColor = async (): Promise<boolean> => {
        if (!old_color) return true;
        try {
            const c: TagColorSnapshot = old_color;
            await Zotero.Tags.setColor(resolvedLibraryID, name, c.color, c.position ?? 0);
            return true;
        } catch (e) {
            logger(`undoManageTagsAction: Failed to restore color: ${e}`, 1);
            return false;
        }
    };

    if (op === 'rename') {
        const target = (new_name ?? '').trim();
        if (!target) throw new Error('new_name missing — cannot undo');

        if (!is_merge) {
            // `rename` is silent when the tag is not in this library, so the
            // only evidence it acted is the tag being there beforehand — and
            // tag names collide across libraries, so that evidence is only
            // worth anything when the reference names its library portably.
            const present = await tagIsInLibrary(resolvedLibraryID, target);
            await Zotero.Tags.rename(resolvedLibraryID, target, name);
            const colorRestored = await restoreColor();
            logger(`undoManageTagsAction: Renamed '${target}' → '${name}' (undo)`, 1);
            if (!targetIsPortable || present === 'unknown') return 'unverifiable';
            // Present means the rename acted; absent means it was already off
            // this library, which for a portable reference is the whole story.
            return colorRestored ? 'reverted' : 'unverifiable';
        }

        // Merge case. The snapshot is a precondition of the apply, so an empty
        // one means the source tag was on no items and no membership moved.
        if (affected_item_ids.length === 0) {
            const colorRestored = await restoreColor();
            logger(`undoManageTagsAction: '${name}' was on no items; the merge moved no membership`, 1);
            if (!colorRestored) return 'unverifiable';
            // A colored source is not nothing: the rename carried that color to
            // the target and overwrote the target's own, which is recorded
            // nowhere, so restoring the source's leaves the target's gone.
            return old_color ? 'partial' : 'reverted';
        }
        // Otherwise re-tag the items that carried the source tag. The target
        // tag stays on them: which of them already had it before the merge is
        // recorded nowhere, and stripping it from all of them would take away a
        // tag the user had. So this is as far as the undo can go, and it says
        // so rather than claiming the merge is off the library.
        const merge = await retagItems(resolvedLibraryID, affected_item_ids, name);
        const colorRestored = await restoreColor();
        logger(`undoManageTagsAction: Re-tagged ${merge.found} items with '${name}'; '${target}' remains on them (merge undo)`, 1);
        if (merge.failed > 0 || !colorRestored) return 'unverifiable';
        if (merge.found === 0 && !targetIsPortable) return 'unverifiable';
        return 'partial';
    } else if (op === 'delete') {
        // As in the merge branch, an empty snapshot means the tag was on no
        // items here, so removing it took nothing off any of them.
        if (affected_item_ids.length === 0) {
            const colorRestored = await restoreColor();
            logger(`undoManageTagsAction: '${name}' was on no items; nothing to re-tag`, 1);
            return colorRestored ? 'reverted' : 'unverifiable';
        }
        const { found, failed } = await retagItems(resolvedLibraryID, affected_item_ids, name);
        const colorRestored = await restoreColor();
        logger(`undoManageTagsAction: Re-added tag '${name}' to ${found} of ${affected_item_ids.length} items (delete undo)`, 1);
        // An item the re-tag could not look up still exists without its tag.
        if (failed > 0 || !colorRestored) return 'unverifiable';
        // Reaching none of them is proof of nothing unless the reference names
        // its library portably: the items may be sitting in a library this
        // device numbers differently, still missing the tag.
        if (found === 0 && !targetIsPortable) return 'unverifiable';
        return 'reverted';
    } else {
        throw new Error(`Unsupported manage_tags action: ${op}`);
    }
}


/**
 * Whether a tag holds any state of its own in this library — items carrying it,
 * or a color assigned to it.
 *
 * `Zotero.Tags.getID` is database-global, so it cannot answer this. Tag colors
 * live in the library's synced settings rather than on items, so a tag with a
 * color and no items is still present here — and `Zotero.Tags.rename` moves a
 * color onto the name it renames to, overwriting whatever was there, which
 * makes a colored target every bit as consequential as one carrying items.
 *
 * A lookup that fails answers `'unknown'` rather than picking a side: the two
 * callers want opposite defaults, so neither can be built into the helper.
 */
async function tagIsInLibrary(libraryID: number, tagName: string): Promise<boolean | 'unknown'> {
    if (Zotero.Tags.getColor(libraryID, tagName)) return true;
    const tagID = Zotero.Tags.getID(tagName);
    if (tagID === false || tagID == null) return false;
    try {
        return (await Zotero.Tags.getTagItems(libraryID, tagID)).length > 0;
    } catch (error) {
        logger(`tagIsInLibrary: could not scope '${tagName}' to library ${libraryID}: ${error}`, 1);
        return 'unknown';
    }
}

/**
 * Re-add a tag to the snapshot items.
 *
 * `failed` counts items the lookup could not even attempt or that threw: those
 * are still there, untagged. `found` counts the ones it reached, which the
 * caller needs because a snapshot that resolves to nothing at all is the shape
 * an undo takes when it is running against the wrong library.
 */
async function retagItems(
    libraryId: number,
    itemIds: string[],
    tagName: string,
): Promise<{ found: number; failed: number }> {
    const items: Zotero.Item[] = [];
    let failed = 0;
    for (const itemId of itemIds) {
        const zoteroKey = snapshotItemKey(itemId);
        if (!zoteroKey) {
            failed++;
            continue;
        }
        try {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, zoteroKey);
            if (item) items.push(item);
        } catch (error) {
            logger(`retagItems: could not look up ${itemId}: ${error}`, 1);
            failed++;
        }
    }
    if (items.length === 0) return { found: 0, failed };
    await Zotero.Items.loadDataTypes(items, ['tags']);

    await Zotero.DB.executeTransaction(async () => {
        for (const item of items) {
            const existing = new Set(item.getTags().map((t: { tag: string }) => t.tag));
            if (!existing.has(tagName)) {
                item.addTag(tagName);
                await item.save();
            }
        }
    });
    return { found: items.length, failed };
}
