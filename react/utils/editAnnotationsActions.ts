import * as operations from '../../src/services/manualActions/editAnnotationsActions';
import { runWindowOperation } from '../runtime/libraryMutation';

export function undoEditAnnotationsAction(...args: Parameters<typeof operations.undoEditAnnotationsAction>): ReturnType<typeof operations.undoEditAnnotationsAction> {
    return runWindowOperation('undoEditAnnotationsAction', args);
}

export function executeEditAnnotationsAction(...args: Parameters<typeof operations.executeEditAnnotationsAction>): ReturnType<typeof operations.executeEditAnnotationsAction> {
    return runWindowOperation('executeEditAnnotationsAction', args);
}
