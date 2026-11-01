import * as operations from "../../src/services/duplicates/merge";
import { runWindowOperation } from "../runtime/libraryMutation";
export function executeMergeItemsAction(
    ...args: Parameters<typeof operations.executeMergeItemsAction>
) {
    return runWindowOperation("executeMergeItemsAction", args);
}
export function undoMergeItemsAction(
    ...args: Parameters<typeof operations.undoMergeItemsAction>
) {
    return runWindowOperation("undoMergeItemsAction", args);
}
/**
 * A fresh proposal for a merge whose records changed. A read, so it runs here
 * like the validation it repeats, outside the library mutation queue.
 */
export function refreshMergeItemsProposal(
    ...args: Parameters<typeof operations.refreshMergeProposal>
) {
    return operations.refreshMergeProposal(...args);
}
