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
