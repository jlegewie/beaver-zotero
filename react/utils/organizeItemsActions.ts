import * as operations from '../../src/services/manualActions/organizeItemsActions';
import { runWindowOperation } from '../runtime/libraryMutation';

export function undoOrganizeItemsAction(...args: Parameters<typeof operations.undoOrganizeItemsAction>): ReturnType<typeof operations.undoOrganizeItemsAction> {
    return runWindowOperation('undoOrganizeItemsAction', args);
}

export function executeOrganizeItemsAction(...args: Parameters<typeof operations.executeOrganizeItemsAction>): ReturnType<typeof operations.executeOrganizeItemsAction> {
    return runWindowOperation('executeOrganizeItemsAction', args);
}
