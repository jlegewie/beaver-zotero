import * as operations from '../../src/services/manualActions/editNoteActions';
import { captureWindowMutationOptions, runWindowOperation } from '../runtime/libraryMutation';
import { captureNoteOperationContext } from '../runtime/noteOperationContext';
import { prepareOperationRendering } from '../runtime/prepareOperationRendering';
export { getUserFacingErrorMessage, isBatchReplaceAllAlreadyUndone, undoBatchReplaceAllViaContexts } from '../../src/services/manualActions/editNoteActions';

export async function executeEditNoteOrBatchAction(action: Parameters<typeof operations.executeEditNoteAction>[0]) {
    return action.action_type === 'edit_note_batch' ? executeEditNoteBatchAction(action) : executeEditNoteAction(action);
}

export async function undoEditNoteOrBatchAction(action: Parameters<typeof operations.undoEditNoteBatchAction>[0]) {
    return action.action_type === 'edit_note_batch' ? undoEditNoteBatchAction(action) : undoEditNoteAction(action);
}

export async function undoEditNoteAction(action: Parameters<typeof operations.undoEditNoteAction>[0]): ReturnType<typeof operations.undoEditNoteAction> {
    const options = captureWindowMutationOptions();
    const context = await prepareOperationRendering('edit_note', action.proposed_data, captureNoteOperationContext());
    return runWindowOperation('undoEditNoteAction', [action, context!], options);
}

export function undoEditNoteBatchAction(...args: Parameters<typeof operations.undoEditNoteBatchAction>): ReturnType<typeof operations.undoEditNoteBatchAction> {
    return runWindowOperation('undoEditNoteBatchAction', args);
}

export async function executeEditNoteAction(action: Parameters<typeof operations.executeEditNoteAction>[0]): ReturnType<typeof operations.executeEditNoteAction> {
    const options = captureWindowMutationOptions();
    const context = await prepareOperationRendering('edit_note', action.proposed_data, captureNoteOperationContext());
    return runWindowOperation('executeEditNoteAction', [action, context!], options);
}

export async function executeEditNoteBatchAction(action: Parameters<typeof operations.executeEditNoteBatchAction>[0]): ReturnType<typeof operations.executeEditNoteBatchAction> {
    const options = captureWindowMutationOptions();
    const context = await prepareOperationRendering('edit_note_batch', action.proposed_data, captureNoteOperationContext());
    return runWindowOperation('executeEditNoteBatchAction', [action, context!], options);
}
