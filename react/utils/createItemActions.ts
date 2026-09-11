import * as operations from '../../src/services/manualActions/createItemActions';
import { captureAttachmentCompletion } from '../runtime/attachmentCompletion';
import { runWindowOperation } from '../runtime/libraryMutation';
export type { BatchExecuteResult, BatchUndoResult } from '../../src/services/manualActions/createItemActions';

export function executeCreateItemActions(...args: Parameters<typeof operations.executeCreateItemActions>): ReturnType<typeof operations.executeCreateItemActions> {
    return runWindowOperation('executeCreateItemActions', [args[0], { ...args[1], onAttachmentResolved: captureAttachmentCompletion() }]);
}

export function undoCreateItemActions(...args: Parameters<typeof operations.undoCreateItemActions>): ReturnType<typeof operations.undoCreateItemActions> {
    return runWindowOperation('undoCreateItemActions', args);
}

export function undoCreateItemAction(...args: Parameters<typeof operations.undoCreateItemAction>): ReturnType<typeof operations.undoCreateItemAction> {
    return runWindowOperation('undoCreateItemAction', args);
}

export function executeCreateItemAction(...args: Parameters<typeof operations.executeCreateItemAction>): ReturnType<typeof operations.executeCreateItemAction> {
    return runWindowOperation('executeCreateItemAction', [args[0], { ...args[1], onAttachmentResolved: captureAttachmentCompletion() }]);
}
