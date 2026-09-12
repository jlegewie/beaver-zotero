import * as operations from '../../src/services/manualActions/manageTagsActions';
import { runWindowOperation } from '../runtime/libraryMutation';

export function undoManageTagsAction(...args: Parameters<typeof operations.undoManageTagsAction>): ReturnType<typeof operations.undoManageTagsAction> {
    return runWindowOperation('undoManageTagsAction', args);
}

export function executeManageTagsAction(...args: Parameters<typeof operations.executeManageTagsAction>): ReturnType<typeof operations.executeManageTagsAction> {
    return runWindowOperation('executeManageTagsAction', args);
}
