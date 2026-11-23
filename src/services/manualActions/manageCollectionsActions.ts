/**
 * Utilities for executing and undoing manage_collections agent actions
 * from the UI (post-run apply / undo).
 *
 * Design:
 *  - `executeManageCollectionsAction` runs the shared executor
 *    (`applyManageCollections`), refusing the write when the collection
 *    changed since the proposal. The executor re-snapshots the pre-apply
 *    state (collection name, parent) into ManageCollectionsResultData; that
 *    snapshot is what rename/move undo consume.
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
import { readCollectionActionData } from '@beaver/agent-core/identity/collectionActionData';
import { assertLibraryWritable, recheckCollectionForUndo, recheckCollectionParent } from '../collections/collectionMutations';
import { AgentAction, ManageCollectionsAgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { logger } from '@beaver/agent-core/platform/logger';
import type { ManageCollectionsProposedData, ManageCollectionsResultData } from '@beaver/agent-core/types/agentActions/base';
import { resolveWriteTargetLibrary } from '../../utils/libraryIdentity';
import { unboundedExecutionContext } from '../agentDataProvider/actions/actionExecution';
import { applyManageCollections } from '../agentDataProvider/actions/manageCollections';
import { itemCountPhrase, joinList, ManualApplyOptions, staleProposalError } from './staleProposal';

/**
 * Throw `stale_proposal` when the collection changed since the proposal
 * (`proposed_data.baseline`): its name, its parent, or (delete) the number of
 * items in it. A proposal without a baseline is not checked. A null
 * `parent_key` means top-level, unless nothing else was recorded either.
 */
function assertCollectionUnchanged(data: ManageCollectionsProposedData, collection: Zotero.Collection): void {
    const baseline = data.baseline;
    if (!baseline) return;
    const hasName = typeof baseline.name === 'string';
    const hasItemCount = typeof baseline.item_count === 'number';
    if (!hasName && !hasItemCount && baseline.parent_key == null) return;
    const label = hasName ? baseline.name : collection.name;
    const changes: string[] = [];
    if (hasName && collection.name !== baseline.name) {
        changes.push(`was renamed to '${collection.name}'`);
    }
    const parentKey = collection.parentKey ? String(collection.parentKey) : null;
    if (parentKey !== (baseline.parent_key ?? null)) {
        changes.push('was moved');
    }
    if (hasItemCount) {
        const count = (collection.getChildItems(true, false) as number[]).length;
        if (count !== baseline.item_count) {
            changes.push(`now has ${itemCountPhrase(count)}, not ${baseline.item_count}`);
        }
    }
    if (changes.length > 0) {
        throw staleProposalError(`The collection '${label}' changed after this was proposed: it ${joinList(changes)}.`);
    }
}
export async function executeManageCollectionsAction(
    action: AgentAction,
    options: ManualApplyOptions = {},
): Promise<ManageCollectionsResultData> {
    const data = readCollectionActionData(action.proposed_data) as ManageCollectionsProposedData;
    return applyManageCollections(action.proposed_data, unboundedExecutionContext(), {
        assertUnchanged: options.skipStaleCheck ? undefined : (collection) => assertCollectionUnchanged(data, collection),
    });
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
    const raw = action.proposed_data;
    const data = readCollectionActionData(raw) as ManageCollectionsProposedData;
    const { library_id, action: op, collection_key } = data;
    if ((!library_id || typeof library_id !== 'number') && !data.library_ref) {
        logger(`undoManageCollectionsAction: missing target library (${collection_key}); skipping`, 1);
        return;
    }
    const resolution = resolveWriteTargetLibrary(data);
    if (!resolution.ok) {
        logger(`undoManageCollectionsAction: ${resolution.message} (${data.library_ref || library_id}-${collection_key}); skipping`, 1);
        return;
    }
    const resolvedLibraryID = resolution.libraryID;
    assertLibraryWritable(resolvedLibraryID);
    const result = readCollectionActionData(action.result_data ?? {}) as Partial<ManageCollectionsResultData>;
    const old_name = result.old_name ?? null;
    const old_parent_key = result.old_parent_key ?? null;

    if (op === 'rename') {
        const collection = recheckCollectionForUndo(collection_key, resolvedLibraryID)?.collection;
        if (!collection) {
            logger(`undoManageCollectionsAction: Collection ${resolvedLibraryID}-${collection_key} not found; skipping`, 1);
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
        const collection = recheckCollectionForUndo(collection_key, resolvedLibraryID)?.collection;
        if (!collection) {
            logger(`undoManageCollectionsAction: Collection ${resolvedLibraryID}-${collection_key} not found; skipping`, 1);
            return;
        }
        (collection as any).parentKey = recheckCollectionParent(collection, old_parent_key) || false;
        await collection.saveTx();
        logger(`undoManageCollectionsAction: Restored parent '${old_parent_key ?? 'top-level'}'`, 1);
        return;
    }

    if (op === 'delete') {
        const collection = recheckCollectionForUndo(collection_key, resolvedLibraryID)?.collection;
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
            logger(`undoManageCollectionsAction: Collection ${resolvedLibraryID}-${collection_key} already restored; skipping`, 1);
            return;
        }
        recheckCollectionParent(collection, collection.parentKey || null);
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
