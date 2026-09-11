import * as operations from '../../src/services/manualActions/editMetadataActions';
import { runWindowOperation } from '../runtime/libraryMutation';
export type { UndoResult } from '../../src/services/manualActions/editMetadataActions';

export function undoEditMetadataAction(...args: Parameters<typeof operations.undoEditMetadataAction>): ReturnType<typeof operations.undoEditMetadataAction> {
    return runWindowOperation('undoEditMetadataAction', args);
}

export function executeEditMetadataAction(...args: Parameters<typeof operations.executeEditMetadataAction>): ReturnType<typeof operations.executeEditMetadataAction> {
    return runWindowOperation('executeEditMetadataAction', args);
}
