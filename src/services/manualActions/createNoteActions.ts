import { assertLibraryWritable } from '../collections/collectionMutations';
import { collectionNotFoundError } from '../collections/collectionIdentity';
import type { OperationContext } from '../agentDataProvider/operationContext';
/**
 * Utility functions for create_note agent actions.
 * Used by AgentActionView for post-run manual apply and undo.
 */

import { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { logger } from '@beaver/agent-core/platform/logger';
import { hasLibraryIdentity, libraryRefForLibraryID, resolveItemReference, resolveWriteTargetLibrary } from '../../utils/libraryIdentity';
import { unboundedExecutionContext } from '../agentDataProvider/actions/actionExecution';
import { applyCreateNote, type CreateNoteApplyData, type CreateNoteResultData } from '../agentDataProvider/actions/createNote';
import { resolveCreateNoteParent } from '../agentDataProvider/actions/resolveCreateNoteParent';
import { getCollectionByIdOrName } from '../agentDataProvider/utils';

export type { CreateNoteResultData };

/** A stored create_note proposal, including fields older proposals carry unresolved. */
type StoredCreateNoteData = CreateNoteApplyData & {
    /** The model's parent argument: "<library_ref>-<zotero_key>". */
    parent_item_id?: string;
    /** Raw collection key or name. */
    collection?: string;
    /** Raw collection keys or names (create_note_tags_collections). */
    collections?: string[];
};

/**
 * Apply a stored create_note action through the shared executor
 * (`applyCreateNote`).
 *
 * Proposals stored before validation resolved their parent and collections
 * are resolved here first, the way validation does now. There is no drift
 * check: a new note overwrites nothing.
 */
export async function executeCreateNoteAction(action: AgentAction, runId: string | undefined, context: OperationContext): Promise<CreateNoteResultData> {
    const data = await resolveStoredCreateNote(action.proposed_data as StoredCreateNoteData);
    return applyCreateNote(data, unboundedExecutionContext(), context, { runId });
}

/**
 * The apply data for a stored proposal: normalized proposals pass through;
 * older ones get their parent and raw collection keys or names resolved now.
 */
async function resolveStoredCreateNote(proposed: StoredCreateNoteData): Promise<CreateNoteApplyData> {
    const has = (field: string) => Object.prototype.hasOwnProperty.call(proposed, field);
    if (!proposed.title || !proposed.content) return proposed;

    const targetLibrary = resolveWriteTargetLibrary({
        library_ref: proposed.library_ref,
        library_id: proposed.library_id,
        library_name: proposed.library,
    });
    if (!targetLibrary.ok) return proposed; // the executor reports the failure
    let targetLibraryId = targetLibrary.libraryID;
    const data: CreateNoteApplyData = { ...proposed };

    // Parent recovery: normalized proposals carry `parent_key` (possibly null).
    if (proposed.parent_item_id && !has('parent_key')) {
        const resolution = await resolveCreateNoteParent(proposed.parent_item_id, proposed.library_ref);
        if (!resolution.ok) {
            throw new Error(resolution.error);
        }
        if (resolution.resolvedLibraryId != null) {
            targetLibraryId = resolution.resolvedLibraryId;
        }
        Object.assign(data, {
            library_id: targetLibraryId,
            // The resolved parent's library is the target; a stale ref must not override it.
            library_ref: libraryRefForLibraryID(targetLibraryId) ?? null,
            parent_key: resolution.parentKey,
            related_item_key: resolution.relatedItemKey,
            warning: resolution.warning,
        });
    }
    if (data.parent_key) return data;

    // Collections: keys resolved by validation pass through; raw keys or
    // names from older proposals are resolved against the target library.
    if (data.collection_ids || data.collection_keys || data.collection_key) return data;
    const rawCollections = (proposed.collections && proposed.collections.length > 0)
        ? proposed.collections
        : (proposed.collection ? [proposed.collection] : []);
    const collectionKeys: string[] = [];
    for (const entry of rawCollections) {
        const match = getCollectionByIdOrName(entry, targetLibraryId);
        if (!match) throw collectionNotFoundError(entry);
        if (!collectionKeys.includes(match.collection.key)) collectionKeys.push(match.collection.key);
    }

    return collectionKeys.length > 0 ? { ...data, collection_keys: collectionKeys } : data;
}


/**
 * Undo a create_note action by deleting the created note.
 */
export async function undoCreateNoteAction(action: AgentAction): Promise<void> {
    const resultData = action.result_data as CreateNoteResultData | undefined;
    // A portable `library_ref` is a complete reference; the numeric id may be
    // the unresolved sentinel. `resolveItemReference` below prefers the ref
    // anyway, so rejecting on the rowid alone fails an undo that would work.
    if (!resultData?.zotero_key || !hasLibraryIdentity(resultData)) {
        throw new Error('Cannot undo: no result data with note reference');
    }

    const resolved = await resolveItemReference(resultData);
    if (resolved.status === 'library_unavailable') {
        logger(`undoCreateNoteAction: Library unavailable for note ${resultData.library_ref || resultData.library_id}-${resultData.zotero_key}`, 1);
        return;
    }
    if (resolved.status === 'not_found') {
        logger(`undoCreateNoteAction: Note ${resultData.library_id}-${resultData.zotero_key} not found, may have been manually deleted`, 1);
        return;
    }

    assertLibraryWritable(resolved.item.libraryID);
    await resolved.item.eraseTx();
    logger(`undoCreateNoteAction: Deleted note ${resultData.library_id}-${resultData.zotero_key}`, 1);
}
