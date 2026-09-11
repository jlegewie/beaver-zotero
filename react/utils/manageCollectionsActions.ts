import * as operations from '../../src/services/manualActions/manageCollectionsActions';
import { runWindowOperation } from '../runtime/libraryMutation';

export function undoManageCollectionsActions(...args: Parameters<typeof operations.undoManageCollectionsActions>): ReturnType<typeof operations.undoManageCollectionsActions> {
    return runWindowOperation('undoManageCollectionsActions', args);
}

export function undoManageCollectionsAction(...args: Parameters<typeof operations.undoManageCollectionsAction>): ReturnType<typeof operations.undoManageCollectionsAction> {
    return runWindowOperation('undoManageCollectionsAction', args);
}

export function executeManageCollectionsAction(...args: Parameters<typeof operations.executeManageCollectionsAction>): ReturnType<typeof operations.executeManageCollectionsAction> {
    return runWindowOperation('executeManageCollectionsAction', args);
}
