import * as operations from '../../src/services/manualActions/editNoteActions';
import { captureWindowMutationOptions, runWindowOperation } from '../runtime/libraryMutation';
import { captureNoteOperationContext } from '../runtime/noteOperationContext';
import type { ManualApplyOptions } from '../../src/services/manualActions/staleProposal';
export { isBatchReplaceAllAlreadyUndone, undoBatchReplaceAllViaContexts } from '../../src/services/manualActions/editNoteActions';

/**
 * Options for a note apply from the UI. `threadId` is the thread that owns the
 * action's run; the "Edited by Beaver" footer links to it rather than to
 * whichever thread is in view.
 */
export type NoteApplyOptions = ManualApplyOptions & { threadId?: string };

export async function executeEditNoteOrBatchAction(action: Parameters<typeof operations.executeEditNoteAction>[0], options: NoteApplyOptions = {}) {
    return action.action_type === 'edit_note_batch' ? executeEditNoteBatchAction(action, options) : executeEditNoteAction(action, options);
}


export async function undoEditNoteOrBatchAction(action: Parameters<typeof operations.undoEditNoteBatchAction>[0]) {
    return action.action_type === 'edit_note_batch' ? undoEditNoteBatchAction(action) : undoEditNoteAction(action);
}

export async function undoEditNoteAction(action: Parameters<typeof operations.undoEditNoteAction>[0]): ReturnType<typeof operations.undoEditNoteAction> {
    const options = captureWindowMutationOptions();
    return runWindowOperation('undoEditNoteAction', [action, captureNoteOperationContext()], options);
}

export function undoEditNoteBatchAction(...args: Parameters<typeof operations.undoEditNoteBatchAction>): ReturnType<typeof operations.undoEditNoteBatchAction> {
    return runWindowOperation('undoEditNoteBatchAction', args);
}

export async function executeEditNoteAction(action: Parameters<typeof operations.executeEditNoteAction>[0], { threadId, ...applyOptions }: NoteApplyOptions = {}): ReturnType<typeof operations.executeEditNoteAction> {
    const options = captureWindowMutationOptions();
    return runWindowOperation('executeEditNoteAction', [action, captureNoteOperationContext(threadId), applyOptions], options);
}

export async function executeEditNoteBatchAction(action: Parameters<typeof operations.executeEditNoteBatchAction>[0], { threadId, ...applyOptions }: NoteApplyOptions = {}): ReturnType<typeof operations.executeEditNoteBatchAction> {
    const options = captureWindowMutationOptions();
    return runWindowOperation('executeEditNoteBatchAction', [action, captureNoteOperationContext(threadId), applyOptions], options);
}
