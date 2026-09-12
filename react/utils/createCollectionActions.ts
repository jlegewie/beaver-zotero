import * as operations from '../../src/services/manualActions/createCollectionActions';
import { runWindowOperation } from '../runtime/libraryMutation';

export function undoCreateCollectionAction(...args: Parameters<typeof operations.undoCreateCollectionAction>): ReturnType<typeof operations.undoCreateCollectionAction> {
    return runWindowOperation('undoCreateCollectionAction', args);
}

export function executeCreateCollectionAction(...args: Parameters<typeof operations.executeCreateCollectionAction>): ReturnType<typeof operations.executeCreateCollectionAction> {
    return runWindowOperation('executeCreateCollectionAction', args);
}
