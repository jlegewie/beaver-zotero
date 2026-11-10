/**
 * Utilities for executing and undoing manage_tags agent actions.
 * Used by AgentActionView for post-run apply/undo.
 *
 * Design:
 *  - `executeManageTagsAction` runs the shared executor (`applyManageTags`),
 *    refusing the write when the tag changed since the proposal. The
 *    executor re-snapshots the pre-apply state (items that have the tag, tag
 *    color, merge re-check) into ManageTagsResultData: the authoritative
 *    snapshot undo reads.
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

import { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { logger } from '@beaver/agent-core/platform/logger';
import type { ManageTagsProposedData, ManageTagsResultData, TagColorSnapshot } from '@beaver/agent-core/types/agentActions/base';
import {
    parseItemReference,
    resolveWriteTargetLibrary,
} from '../../utils/libraryIdentity';
import { unboundedExecutionContext } from '../agentDataProvider/actions/actionExecution';
import { applyManageTags } from '../agentDataProvider/actions/manageTags';
import { itemCountPhrase, joinList, ManualApplyOptions, staleProposalError } from './staleProposal';

function snapshotItemKey(itemId: string): string | null {
    // The action's resolved target library is authoritative. Snapshot prefixes
    // may be stale device-local rowids, so only retain the stable Zotero key.
    return parseItemReference(itemId)?.zotero_key ?? null;
}


/**
 * Throw `stale_proposal` when the tag changed since the proposal
 * (`proposed_data.baseline`): it is on a different number of items, or
 * (rename) whether the new name already exists, which decides between a
 * rename and a merge, is no longer what the user saw. A proposal without a
 * baseline, or a baseline value that is null, is not checked.
 */
async function assertTagUnchanged(
    data: ManageTagsProposedData,
    libraryID: number,
    tagID: number | null,
): Promise<void> {
    const baseline = data.baseline;
    if (!baseline) return;
    const changes: string[] = [];
    if (typeof baseline.item_count === 'number') {
        const count = tagID != null
            ? (await Zotero.Tags.getTagItems(libraryID, tagID)).length
            : 0;
        if (count !== baseline.item_count) {
            changes.push(`'${data.name}' is now on ${itemCountPhrase(count)}, not ${baseline.item_count}`);
        }
    }
    if (data.action === 'rename' && typeof baseline.is_merge === 'boolean') {
        const target = (data.new_name ?? '').trim();
        const targetID = target ? Zotero.Tags.getID(target) : false;
        const isMerge = targetID !== false && targetID != null;
        if (isMerge !== baseline.is_merge) {
            changes.push(isMerge
                ? `'${target}' now exists, so renaming would merge the two tags`
                : `'${target}' no longer exists, so this is no longer a merge`);
        }
    }
    if (changes.length > 0) {
        throw staleProposalError(`Tags changed after this was proposed: ${joinList(changes)}.`);
    }
}

export async function executeManageTagsAction(
    action: AgentAction,
    options: ManualApplyOptions = {},
): Promise<ManageTagsResultData> {
    const data = action.proposed_data as ManageTagsProposedData;
    return applyManageTags(data, unboundedExecutionContext(), {
        assertUnchanged: options.skipStaleCheck ? undefined : (libraryID, tagID) => assertTagUnchanged(data, libraryID, tagID),
    });
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
    const { library_id, action: op, new_name } = data;
    // The apply records the tag it actually operated on, which can differ from
    // the proposed spelling when it resolved a case or form variant.
    const name = (action.result_data as Partial<ManageTagsResultData> | undefined)?.name || data.name;
    if ((!library_id || typeof library_id !== 'number') && !data.library_ref) {
        logger('undoManageTagsAction: missing target library; skipping', 1);
        return;
    }
    const resolution = resolveWriteTargetLibrary(data);
    if (!resolution.ok) {
        logger(`undoManageTagsAction: ${resolution.message} (${data.library_ref || library_id}); skipping`, 1);
        return;
    }
    const resolvedLibraryID = resolution.libraryID;
    const result = (action.result_data ?? {}) as Partial<ManageTagsResultData>;
    const affected_item_ids = result.affected_item_ids ?? [];
    const old_color = result.old_color ?? null;
    const is_merge = result.is_merge ?? null;

    const restoreColor = async () => {
        if (!old_color) return;
        try {
            const c: TagColorSnapshot = old_color;
            await Zotero.Tags.setColor(resolvedLibraryID, name, c.color, c.position ?? 0);
        } catch (e) {
            logger(`undoManageTagsAction: Failed to restore color: ${e}`, 1);
        }
    };

    if (op === 'rename') {
        const target = (new_name ?? '').trim();
        if (!target) throw new Error('new_name missing — cannot undo');

        if (!is_merge) {
            await Zotero.Tags.rename(resolvedLibraryID, target, name);
            await restoreColor();
            logger(`undoManageTagsAction: Renamed '${target}' → '${name}' (undo)`, 1);
            return;
        }

        // Merge case: re-tag items that had the source tag before the merge.
        if (affected_item_ids.length === 0) {
            logger(`undoManageTagsAction: No affected_item_ids snapshot; cannot undo merge`, 1);
            return;
        }
        await retagItems(resolvedLibraryID, affected_item_ids, name);
        await restoreColor();
        logger(`undoManageTagsAction: Re-tagged ${affected_item_ids.length} items with '${name}' (merge undo)`, 1);
    } else if (op === 'delete') {
        if (affected_item_ids.length === 0) {
            logger(`undoManageTagsAction: No affected_item_ids snapshot; nothing to restore`, 1);
            await restoreColor();
            return;
        }
        await retagItems(resolvedLibraryID, affected_item_ids, name);
        await restoreColor();
        logger(`undoManageTagsAction: Re-added tag '${name}' to ${affected_item_ids.length} items (delete undo)`, 1);
    } else {
        throw new Error(`Unsupported manage_tags action: ${op}`);
    }
}


async function retagItems(libraryId: number, itemIds: string[], tagName: string): Promise<void> {
    const items: Zotero.Item[] = [];
    for (const itemId of itemIds) {
        const zoteroKey = snapshotItemKey(itemId);
        if (!zoteroKey) continue;
        try {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, zoteroKey);
            if (item) items.push(item);
        } catch (_) {
            // skip
        }
    }
    if (items.length === 0) return;
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
}
