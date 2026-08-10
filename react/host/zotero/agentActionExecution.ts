import { atom } from 'jotai';
import { logger } from '@beaver/agent-core/platform/logger';
import type { CreateItemProposedData } from '@beaver/agent-core/types/agentActions/items';
import {
    AgentAction,
    ackAgentActionsAtom,
    rejectAgentActionAtom,
    setAgentActionsToErrorAtom,
    undoAgentActionAtom,
} from '../../agents/agentActions';
import { markExternalReferenceImportedAtom, markExternalReferenceDeletedAtom } from '../../atoms/externalReferences';
import { currentThreadIdAtom } from '../../atoms/threads';
import { executeEditMetadataAction, undoEditMetadataAction, UndoResult } from '../../utils/editMetadataActions';
import { executeCreateCollectionAction, undoCreateCollectionAction } from '../../utils/createCollectionActions';
import { executeOrganizeItemsAction, undoOrganizeItemsAction } from '../../utils/organizeItemsActions';
import { executeCreateItemActions, undoCreateItemActions } from '../../utils/createItemActions';
import { executeCreateNoteAction, undoCreateNoteAction } from '../../utils/createNoteActions';
import { executeManageTagsAction, undoManageTagsAction } from '../../utils/manageTagsActions';
import { executeManageCollectionsAction, undoManageCollectionsAction } from '../../utils/manageCollectionsActions';
import {
    executeCreateHighlightAnnotationsAction,
    executeCreateNoteAnnotationsAction,
    undoCreateAnnotationsAction,
} from '../../utils/createAnnotationsActions';
import { executeEditAnnotationsAction, undoEditAnnotationsAction } from '../../utils/editAnnotationsActions';
import { confirmOverwriteManualChanges } from './components/agentActionViewHelpers';

/**
 * Apply / undo / reject for stored agent actions, as write atoms so any
 * surface can drive them: the in-stream card, and anything that only has the
 * action records themselves.
 */

export interface AgentActionFailure {
    actionId: string;
    error: string;
    errorDetails?: Record<string, any>;
}

export interface ApplyAgentActionsResult {
    applied: string[];
    failed: AgentActionFailure[];
    /** Set only when the operation threw as a whole, not per action. */
    fatalError?: string;
}

export interface UndoAgentActionsResult {
    undone: string[];
    failed: AgentActionFailure[];
    fatalError?: string;
}

/**
 * Dispatch on the action type, not the tool name. Three tool names differ from
 * the action type they store, and callers may hold either.
 */
function normalizeActionType(actionType: string): string {
    if (actionType === 'create_items') return 'create_item';
    if (actionType === 'edit_item') return 'edit_metadata';
    // A deletion is an edit_annotations action with proposed_data.operation
    // 'delete'; both route to the same executor.
    if (actionType === 'delete_annotations') return 'edit_annotations';
    return actionType;
}

/** Action types applied by one call whose result is acked as-is. */
const APPLY_EXECUTORS = new Map<string, (action: AgentAction, runId: string) => Promise<any>>([
    ['edit_metadata', (action) => executeEditMetadataAction(action)],
    ['create_collection', (action) => executeCreateCollectionAction(action)],
    ['organize_items', (action) => executeOrganizeItemsAction(action)],
    ['manage_tags', (action) => executeManageTagsAction(action)],
    ['manage_collections', (action) => executeManageCollectionsAction(action)],
    ['create_note', (action, runId) => executeCreateNoteAction(action, runId)],
    ['create_highlight_annotations', (action) => executeCreateHighlightAnnotationsAction(action)],
    ['create_note_annotations', (action) => executeCreateNoteAnnotationsAction(action)],
    ['edit_annotations', (action) => executeEditAnnotationsAction(action)],
]);

/** Action types undone by one call with no confirmation step. */
const UNDO_EXECUTORS = new Map<string, (action: AgentAction) => Promise<void>>([
    ['create_collection', undoCreateCollectionAction],
    ['organize_items', undoOrganizeItemsAction],
    ['manage_tags', undoManageTagsAction],
    ['manage_collections', undoManageCollectionsAction],
    ['create_note', undoCreateNoteAction],
    ['create_highlight_annotations', undoCreateAnnotationsAction],
    ['create_note_annotations', undoCreateAnnotationsAction],
]);

/**
 * Undo for the action types that can hit fields the user edited afterwards:
 * re-runs with forceRevert once the user confirms the overwrite.
 */
async function undoWithOverwriteConfirmation(
    action: AgentAction,
    undoAction: (action: AgentAction, forceRevert: boolean) => Promise<UndoResult>,
    fieldLabel: string,
): Promise<UndoResult> {
    let result = await undoAction(action, false);
    if (result.needsConfirmation && result.manuallyModified.length > 0) {
        if (confirmOverwriteManualChanges(result.manuallyModified)) {
            result = await undoAction(action, true);
            logger(`agentActionExecution: Force-reverted ${result.fieldsReverted} ${fieldLabel} after user confirmation`, 1);
        } else {
            logger(`agentActionExecution: User declined to overwrite ${result.manuallyModified.length} manually modified ${fieldLabel}`, 1);
        }
    }
    if (result.alreadyReverted.length > 0) {
        logger(`agentActionExecution: ${fieldLabel} already at original value: ${result.alreadyReverted.join(', ')}`, 1);
    }
    return result;
}

function toFailures(actions: AgentAction[], error: string, errorDetails: Record<string, any>): AgentActionFailure[] {
    return actions.map((action) => ({ actionId: action.id, error, errorDetails }));
}

/**
 * Apply a tool call's actions. Single-action types apply `actions[0]`; only
 * create_item is a batch. Unknown action types are a no-op.
 */
export const applyAgentActionsAtom = atom(
    null,
    async (get, set, { actions, runId }: { actions: AgentAction[]; runId: string }): Promise<ApplyAgentActionsResult> => {
        const applied: string[] = [];
        const failed: AgentActionFailure[] = [];
        if (actions.length === 0) return { applied, failed };

        const action = actions[0];
        const actionType = normalizeActionType(action.action_type);
        try {
            if (actionType === 'create_item') {
                const actionsToApply = actions.filter((candidate) => candidate.status !== 'applied');
                if (actionsToApply.length === 0) return { applied, failed };

                const batchResult = await executeCreateItemActions(actionsToApply, {
                    runId,
                    threadId: get(currentThreadIdAtom) ?? undefined,
                });
                if (batchResult.successes.length > 0) {
                    await set(ackAgentActionsAtom, runId, batchResult.successes.map((success) => ({
                        action_id: success.action.id,
                        result_data: success.result,
                    })));
                    logger(`agentActionExecution: Applied ${batchResult.successes.length} create_item actions`, 1);

                    for (const success of batchResult.successes) {
                        applied.push(success.action.id);
                        const proposedData = success.action.proposed_data as CreateItemProposedData;
                        if (proposedData?.item?.source_id) {
                            set(markExternalReferenceImportedAtom, proposedData.item.source_id, {
                                library_id: success.result.library_id,
                                zotero_key: success.result.zotero_key,
                                library_ref: success.result.library_ref,
                            });
                        }
                    }
                }

                for (const failure of batchResult.failures) {
                    set(setAgentActionsToErrorAtom, [failure.action.id], failure.error, failure.errorDetails);
                    failed.push({ actionId: failure.action.id, error: failure.error, errorDetails: failure.errorDetails });
                }
                if (batchResult.failures.length > 0) {
                    logger(`agentActionExecution: Failed to apply ${batchResult.failures.length} create_item actions`, 1);
                }
            } else {
                const executeAction = APPLY_EXECUTORS.get(actionType);
                if (!executeAction) {
                    // Note edits and the legacy per-annotation types apply through
                    // their own surfaces. Log it: a caller with a wider set of
                    // actions than the in-stream card would otherwise see a
                    // successful-looking no-op.
                    logger(`agentActionExecution: No apply executor for action type ${actionType}`, 1);
                    return { applied, failed };
                }

                const result = await executeAction(action, runId);
                await set(ackAgentActionsAtom, runId, [{ action_id: action.id, result_data: result }]);
                applied.push(action.id);
                logger(`agentActionExecution: Applied ${actionType} action ${action.id}`, 1);
            }
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to apply action';
            const stackTrace = error?.stack || '';
            logger(`agentActionExecution: Failed to apply actions: ${errorMessage}\nStack trace:\n${stackTrace}`, 1);
            const errorDetails = { stack_trace: stackTrace, error_name: error?.name };
            set(setAgentActionsToErrorAtom, actions.map((candidate) => candidate.id), errorMessage, errorDetails);
            return { applied: [], failed: toFailures(actions, errorMessage, errorDetails), fatalError: errorMessage };
        }

        return { applied, failed };
    }
);

/**
 * Undo a tool call's actions. Single-action types undo `actions[0]`; only
 * create_item is a batch. Unknown action types are a no-op.
 */
export const undoAgentActionsAtom = atom(
    null,
    async (_get, set, { actions }: { actions: AgentAction[] }): Promise<UndoAgentActionsResult> => {
        const undone: string[] = [];
        const failed: AgentActionFailure[] = [];
        if (actions.length === 0) return { undone, failed };

        const action = actions[0];
        const actionType = normalizeActionType(action.action_type);
        try {
            if (actionType === 'create_item') {
                const actionsToUndo = actions.filter((candidate) => candidate.status === 'applied');
                if (actionsToUndo.length === 0) return { undone, failed };

                const batchResult = await undoCreateItemActions(actionsToUndo);
                for (const actionId of batchResult.successes) {
                    set(undoAgentActionAtom, actionId);
                    undone.push(actionId);
                    const undoneAction = actionsToUndo.find((candidate) => candidate.id === actionId);
                    const proposedData = undoneAction?.proposed_data as CreateItemProposedData | undefined;
                    if (proposedData?.item?.source_id) {
                        set(markExternalReferenceDeletedAtom, proposedData.item.source_id);
                    }
                }
                for (const failure of batchResult.failures) {
                    set(setAgentActionsToErrorAtom, [failure.actionId], failure.error, failure.errorDetails);
                    failed.push({ actionId: failure.actionId, error: failure.error, errorDetails: failure.errorDetails });
                }
                logger(`agentActionExecution: Undone ${batchResult.successes.length} create_item actions`, 1);
                if (batchResult.failures.length > 0) {
                    logger(`agentActionExecution: Failed to undo ${batchResult.failures.length} create_item actions`, 1);
                }
            } else if (actionType === 'edit_metadata' || actionType === 'edit_annotations') {
                const isMetadata = actionType === 'edit_metadata';
                const result = await undoWithOverwriteConfirmation(
                    action,
                    isMetadata ? undoEditMetadataAction : undoEditAnnotationsAction,
                    isMetadata ? 'fields' : 'annotation fields',
                );
                // Also reached when the user declined the overwrite: the fields
                // they kept are theirs, but the action is no longer applied.
                set(undoAgentActionAtom, action.id);
                undone.push(action.id);
                logger(`agentActionExecution: Undone ${actionType} action ${action.id} (${result.fieldsReverted} fields reverted)`, 1);
            } else {
                const undoAction = UNDO_EXECUTORS.get(actionType);
                if (!undoAction) {
                    logger(`agentActionExecution: No undo executor for action type ${actionType}`, 1);
                    return { undone, failed };
                }

                await undoAction(action);
                set(undoAgentActionAtom, action.id);
                undone.push(action.id);
                logger(`agentActionExecution: Undone ${actionType} action ${action.id}`, 1);
            }
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to undo action';
            const stackTrace = error?.stack || '';
            logger(`agentActionExecution: Failed to undo actions: ${errorMessage}\nStack trace:\n${stackTrace}`, 1);

            const errorDetails = { stack_trace: stackTrace, error_name: error?.name };
            const appliedActions = actions.filter((candidate) => candidate.status === 'applied');
            if (appliedActions.length > 0) {
                set(setAgentActionsToErrorAtom, appliedActions.map((candidate) => candidate.id), errorMessage, errorDetails);
            }
            // Only a thrown failure sets fatalError — callers use it to point
            // Retry back at undo instead of re-applying. Per-action batch
            // failures above must not set it.
            return { undone: [], failed: toFailures(actions, errorMessage, errorDetails), fatalError: errorMessage };
        }

        return { undone, failed };
    }
);

/** Reject the given agent actions. */
export const rejectAgentActionsAtom = atom(
    null,
    (_get, set, { actions }: { actions: AgentAction[] }): void => {
        for (const action of actions) {
            set(rejectAgentActionAtom, action.id);
        }
    }
);
