import * as operations from '../../src/services/manualActions/createNoteActions';
import { captureWindowMutationOptions, runWindowOperation } from '../runtime/libraryMutation';
import { captureNoteOperationContext } from '../runtime/noteOperationContext';
import { prepareOperationRendering } from '../runtime/prepareOperationRendering';
export type { CreateNoteResultData } from '../../src/services/manualActions/createNoteActions';

export function undoCreateNoteAction(...args: Parameters<typeof operations.undoCreateNoteAction>): ReturnType<typeof operations.undoCreateNoteAction> {
    return runWindowOperation('undoCreateNoteAction', args);
}

/** `threadId` is the thread that owns `runId`; the note's Beaver footer links to it. */
export async function executeCreateNoteAction(action: Parameters<typeof operations.executeCreateNoteAction>[0], runId?: string, threadId?: string): ReturnType<typeof operations.executeCreateNoteAction> {
    const options = captureWindowMutationOptions();
    const context = await prepareOperationRendering('create_note', action.proposed_data, captureNoteOperationContext(threadId));
    return runWindowOperation('executeCreateNoteAction', [action, runId, context!], options);
}
