import { atom, Getter, Setter } from 'jotai';
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
import {
    executeEditNoteOrBatchAction,
    getUserFacingErrorMessage,
    undoEditNoteOrBatchAction,
} from '../../utils/editNoteActions';
import { confirmOverwriteManualChanges, hasFailedUndo } from './components/agentActionViewHelpers';
import { dismissActiveEditNotePreview } from './editNotePreviewLifecycle';
import { UNVERIFIABLE_UNDO_MESSAGE, type UndoActionOutcome } from '../../utils/undoActionOutcome';

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
    ['edit_note', (action) => executeEditNoteOrBatchAction(action)],
    ['edit_note_batch', (action) => executeEditNoteOrBatchAction(action)],
    ['create_collection', (action) => executeCreateCollectionAction(action)],
    ['organize_items', (action) => executeOrganizeItemsAction(action)],
    ['manage_tags', (action) => executeManageTagsAction(action)],
    ['manage_collections', (action) => executeManageCollectionsAction(action)],
    ['create_note', (action, runId) => executeCreateNoteAction(action, runId)],
    ['create_highlight_annotations', (action) => executeCreateHighlightAnnotationsAction(action)],
    ['create_note_annotations', (action) => executeCreateNoteAnnotationsAction(action)],
    ['edit_annotations', (action) => executeEditAnnotationsAction(action)],
]);

/**
 * Action types undone by one call with no confirmation step.
 *
 * Handlers that can return without having reverted anything report an
 * `UndoActionOutcome`; the rest say the same thing by throwing. Both are
 * handled in `undoClaimedActions` — an undo that is not proven to have run must
 * not mark the card undone.
 */
const UNDO_EXECUTORS = new Map<string, (action: AgentAction) => Promise<void | UndoActionOutcome>>([
    ['edit_note', undoEditNoteOrBatchAction],
    ['edit_note_batch', undoEditNoteOrBatchAction],
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

function toFailures(actions: AgentAction[], error: string, errorDetails?: Record<string, any>): AgentActionFailure[] {
    return actions.map((action) => ({ actionId: action.id, error, errorDetails }));
}

/**
 * Action ids with a Zotero write in flight, claimed here rather than by any one
 * surface.
 *
 * A terminal run's pending action is offered by every surface that can reach it —
 * the in-stream card and the review card both show Apply — and an action stays
 * `pending` until its write finishes and the ack lands. Surfaces each guarding
 * only their own buttons therefore let a second click through: two applies
 * duplicate the mutation, and a reject lands on an action whose write is still
 * running, so the ack flips it straight back to `applied` and the user's "no" is
 * lost. Claiming here covers every caller, including ones added later.
 *
 * An atom rather than a plain Set because the claim is the only thing that knows
 * a write is running — the action's status says `pending` throughout — so
 * surfaces need to observe it to disable their controls.
 */
export const inFlightAgentActionIdsAtom = atom<ReadonlySet<string>>(new Set<string>());

/** The actions not already being written; empty when another surface holds them all. */
function claimActions(get: Getter, set: Setter, actions: AgentAction[]): AgentAction[] {
    const inFlight = get(inFlightAgentActionIdsAtom);
    const claimed = actions.filter((action) => !inFlight.has(action.id));
    if (claimed.length > 0) {
        const next = new Set(inFlight);
        for (const action of claimed) next.add(action.id);
        set(inFlightAgentActionIdsAtom, next);
    }
    return claimed;
}

function releaseActions(get: Getter, set: Setter, actions: AgentAction[]): void {
    const next = new Set(get(inFlightAgentActionIdsAtom));
    for (const action of actions) next.delete(action.id);
    set(inFlightAgentActionIdsAtom, next);
}

/**
 * Report an action type this executor cannot handle. The legacy per-annotation
 * types still apply through their own surfaces.
 *
 * Reported as per-action failures rather than an empty success, so a caller that
 * hands over a wider set of actions than the in-stream card can tell "applied
 * nothing" from "nothing to apply". The action records are left alone: nothing
 * was attempted, so nothing failed in Zotero. `fatalError` stays unset on
 * purpose — the in-stream card reads it to switch Retry over to undo, and this
 * is not a failed attempt it could retry.
 */
function unsupportedActionTypeFailures(
    actions: AgentAction[],
    actionType: string,
    operation: 'apply' | 'undo',
): AgentActionFailure[] {
    const message = `No ${operation} executor for action type '${actionType}'`;
    logger(`agentActionExecution: ${message}`, 1);
    return toFailures(actions, message);
}

/**
 * Apply a tool call's actions. Single-action types apply `actions[0]`; only
 * create_item is a batch. An action type this executor does not handle comes
 * back as a per-action failure, never as an empty success.
 */
export const applyAgentActionsAtom = atom(
    null,
    async (get, set, { actions, runId }: { actions: AgentAction[]; runId: string }): Promise<ApplyAgentActionsResult> => {
        if (actions.length === 0) return { applied: [], failed: [] };

        const claimed = claimActions(get, set, actions);
        if (claimed.length === 0) {
            logger('agentActionExecution: apply skipped, another surface is already writing these actions', 1);
            return { applied: [], failed: [] };
        }
        try {
            return await applyClaimedActions(get, set, claimed, runId);
        } finally {
            releaseActions(get, set, claimed);
        }
    }
);

async function applyClaimedActions(
    get: Getter,
    set: Setter,
    actions: AgentAction[],
    runId: string,
): Promise<ApplyAgentActionsResult> {
    const applied: string[] = [];
    const failed: AgentActionFailure[] = [];
    const action = actions[0];
    const actionType = normalizeActionType(action.action_type);
    try {
        if (actionType === 'edit_note' || actionType === 'edit_note_batch') {
            await dismissActiveEditNotePreview();
        }
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
                return { applied, failed: unsupportedActionTypeFailures(actions, actionType, 'apply') };
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
        const errorDetails = {
            stack_trace: stackTrace,
            error_name: error?.name,
            ...(error?.code ? { error_code: error.code } : {}),
        };
        set(setAgentActionsToErrorAtom, actions.map((candidate) => candidate.id), errorMessage, errorDetails);
        return { applied: [], failed: toFailures(actions, errorMessage, errorDetails), fatalError: errorMessage };
    }

    return { applied, failed };
}

/**
 * Undo a tool call's actions. Single-action types undo `actions[0]`; only
 * create_item is a batch. An action type this executor does not handle comes
 * back as a per-action failure, never as an empty success.
 */
export const undoAgentActionsAtom = atom(
    null,
    async (get, set, { actions }: { actions: AgentAction[] }): Promise<UndoAgentActionsResult> => {
        if (actions.length === 0) return { undone: [], failed: [] };

        const claimed = claimActions(get, set, actions);
        if (claimed.length === 0) {
            logger('agentActionExecution: undo skipped, another surface is already writing these actions', 1);
            return { undone: [], failed: [] };
        }
        try {
            return await undoClaimedActions(set, claimed);
        } finally {
            releaseActions(get, set, claimed);
        }
    }
);

async function undoClaimedActions(set: Setter, actions: AgentAction[]): Promise<UndoAgentActionsResult> {
    const undone: string[] = [];
    const failed: AgentActionFailure[] = [];
    const action = actions[0];
    const actionType = normalizeActionType(action.action_type);
    try {
        if (actionType === 'edit_note' || actionType === 'edit_note_batch') {
            await dismissActiveEditNotePreview();
        }
        if (actionType === 'create_item') {
            // An action that errored with its result data intact failed its own
            // undo, so the item is still there and Retry Undo has to reach it.
            // Without that this branch would find nothing to do and the button
            // would spin on a card it can never resolve.
            const actionsToUndo = actions.filter(
                (candidate) => candidate.status === 'applied' || hasFailedUndo([candidate]),
            );
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
            // Marking the card undone would claim a revert that did not
            // happen: either nothing was touched because the library is not
            // reachable here, or a field could not be read or written and
            // still holds what the action wrote. Fields the user chose to keep
            // are a different matter and fall through — see below.
            if (result.unverifiable || (result.failed?.length ?? 0) > 0) {
                throw new Error(UNVERIFIABLE_UNDO_MESSAGE);
            }
            // Also reached when the user declined the overwrite: the fields
            // they kept are theirs, but the action is no longer applied.
            set(undoAgentActionAtom, action.id);
            undone.push(action.id);
            logger(`agentActionExecution: Undone ${actionType} action ${action.id} (${result.fieldsReverted} fields reverted)`, 1);
        } else {
            const undoAction = UNDO_EXECUTORS.get(actionType);
            if (!undoAction) {
                return { undone, failed: unsupportedActionTypeFailures(actions, actionType, 'undo') };
            }

            const outcome = await undoAction(action);
            if (outcome === 'unverifiable') {
                throw new Error(UNVERIFIABLE_UNDO_MESSAGE);
            }
            set(undoAgentActionAtom, action.id);
            undone.push(action.id);
            logger(`agentActionExecution: Undone ${actionType} action ${action.id}`, 1);
        }
    } catch (error: any) {
        const errorMessage = actionType === 'edit_note' || actionType === 'edit_note_batch'
            ? getUserFacingErrorMessage(error, 'Failed to undo note edit')
            : error?.message || 'Failed to undo action';
        const stackTrace = error?.stack || '';
        logger(`agentActionExecution: Failed to undo actions: ${errorMessage}\nStack trace:\n${stackTrace}`, 1);

        const errorDetails = {
            stack_trace: stackTrace,
            error_name: error?.name,
            ...(error?.code ? { error_code: error.code } : {}),
        };
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

/**
 * Reject the given agent actions, skipping any whose write is already running.
 *
 * Rejecting mid-write cannot stop the write, and its ack would overwrite the
 * `rejected` status with `applied` — the rejection silently lost while the
 * change stayed in the library. Skipping leaves the action to settle into its
 * applied state, where Undo reverses it in one more click.
 */
export const rejectAgentActionsAtom = atom(
    null,
    (get, set, { actions }: { actions: AgentAction[] }): void => {
        const inFlight = get(inFlightAgentActionIdsAtom);
        for (const action of actions) {
            if (inFlight.has(action.id)) {
                logger(`agentActionExecution: reject skipped for ${action.id}, its write is already running`, 1);
                continue;
            }
            if (action.action_type === 'edit_note' || action.action_type === 'edit_note_batch') {
                void dismissActiveEditNotePreview();
            }
            set(rejectAgentActionAtom, action.id);
        }
    }
);
