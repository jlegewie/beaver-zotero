/**
 * Undoing the applied actions of runs a retry removes.
 *
 * The window that asked for the retry confirms the undo; the session then runs
 * the undos here, in the plugin realm, as library operations owned by the
 * session, so the window closing cancels those still queued.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import {
    type AgentAction,
    hasAppliedBulkAnnotations,
    hasAppliedZoteroItem,
    isAnnotationAgentAction,
    isCreateAnnotationsAgentAction,
    isCreateCollectionAgentAction,
    isCreateItemAgentAction,
    isCreateNoteAgentAction,
    isEditAnnotationsAgentAction,
    isEditMetadataAgentAction,
    isEditNoteAgentAction,
    isEditNoteBatchAgentAction,
    isImportItemAgentAction,
    isManageCollectionsAgentAction,
    isManageTagsAgentAction,
    isOrganizeItemsAgentAction,
} from '@beaver/agent-core/agents/agentActionTypes';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import type { OperationContext } from '../agentDataProvider/operationContext';
import type { LibraryOperationMap, LibraryOperationName } from '../libraryOperations';
import type { MutationOptions } from '../libraryMutations';
import { resolveItemReference } from '../../utils/libraryIdentity';

export interface UndoContext {
    /** Queue options of the undos: their owner and when they stop being current. */
    mutation: MutationOptions;
    /** Inputs of a note undo: the chat's thread and external-reference mappings. */
    noteContext(): OperationContext;
}

/**
 * Undo all applied agent actions from removed runs in reverse chronological order.
 *
 * A single ordered loop is required because actions have cross-type dependencies.
 * Undoing in reverse chronological order restores the original state.
 *
 * Per-action failures are logged and do not stop the loop.
 */
export async function undoAppliedActions(actions: AgentAction[], context: UndoContext): Promise<void> {
    const run = <K extends LibraryOperationName>(name: K, args: Parameters<LibraryOperationMap[K]>) =>
        Zotero.Beaver.libraryOperations.run(name, args, context.mutation);

    // Filter applied actions, keeping their original array position as the
    // tiebreaker for chronological ordering.
    const indexed = actions
        .map((action, index) => ({ action, index }))
        .filter(({ action }) => {
            if (isCreateAnnotationsAgentAction(action)) {
                return hasAppliedBulkAnnotations(action);
            }
            if (isAnnotationAgentAction(action)) {
                return hasAppliedZoteroItem(action);
            }
            return action.status === 'applied';
        });

    // Sort reverse-chronologically by `created_at`, falling back to array
    // position (which reflects insertion order in the chat's actions).
    indexed.sort((a, b) => {
        const ta = a.action.created_at ? Date.parse(a.action.created_at) : NaN;
        const tb = b.action.created_at ? Date.parse(b.action.created_at) : NaN;
        if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return tb - ta;
        return b.index - a.index;
    });

    for (const { action } of indexed) {
        try {
            if (isCreateAnnotationsAgentAction(action)) {
                await run('undoCreateAnnotationsAction', [action]);
            } else if (isEditAnnotationsAgentAction(action)) {
                // Preserve fields the user manually modified after apply, as
                // the other edit-action retry paths do.
                await run('undoEditAnnotationsAction', [action, false]);
            } else if (isAnnotationAgentAction(action)) {
                const ref = action.result_data as ZoteroItemReference | undefined;
                if (!ref) continue;
                const resolved = await resolveItemReference(ref);
                // Not a queued operation: check the session is still current itself.
                context.mutation.assertCurrent?.();
                if (resolved.status === 'found') await resolved.item.eraseTx();
            } else if (isEditMetadataAgentAction(action)) {
                // false = preserve fields the user manually modified after apply
                await run('undoEditMetadataAction', [action, false]);
            } else if (isEditNoteAgentAction(action)) {
                await run('undoEditNoteAction', [action, context.noteContext()]);
            } else if (isEditNoteBatchAgentAction(action)) {
                await run('undoEditNoteBatchAction', [action]);
            } else if (isCreateItemAgentAction(action)) {
                await run('undoCreateItemAction', [action]);
            } else if (isImportItemAgentAction(action)) {
                await run('undoImportItemAction', [action]);
            } else if (isCreateCollectionAgentAction(action)) {
                await run('undoCreateCollectionAction', [action]);
            } else if (isOrganizeItemsAgentAction(action)) {
                await run('undoOrganizeItemsAction', [action]);
            } else if (isManageTagsAgentAction(action)) {
                await run('undoManageTagsAction', [action]);
            } else if (isManageCollectionsAgentAction(action)) {
                await run('undoManageCollectionsAction', [action]);
            } else if (isCreateNoteAgentAction(action)) {
                await run('undoCreateNoteAction', [action]);
            } else if (action.action_type === 'merge_items') {
                await run('undoMergeItemsAction', [action as Parameters<LibraryOperationMap['undoMergeItemsAction']>[0]]);
            }
        } catch (error) {
            logger(`undoAppliedActions: Failed to undo action ${action.id} (${action.action_type}): ${error}`, 1);
        }
    }
}
