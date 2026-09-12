/**
 * Create Item Action Utilities
 * 
 * Functions for executing and undoing create_item agent actions.
 * These are used by AgentActionView for post-run action handling.
 */

import { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { logger } from '@beaver/agent-core/platform/logger';
import { CreateItemProposedData, CreateItemResultData } from '@beaver/agent-core/types/agentActions/items';
import { cancelTasksForItem } from '../../utils/backgroundTasks';
import { hasLibraryIdentity, modelObjectIdFromReference, resolveItemReference, resolveLibraryRef, resolveWriteTargetLibrary } from '../../utils/libraryIdentity';
import { applyCreateItemData } from '../itemImport';
import type { AttachmentResolvedPayload } from '../attachmentResolved';

/** Maximum concurrent item creations in batch jobs */
const BATCH_CONCURRENCY_LIMIT = 3;

interface ExecuteCreateItemActionOptions {
    runId?: string;
    threadId?: string;
    onAttachmentResolved?: (payload: AttachmentResolvedPayload) => void;
}

/**
 * Execute a create_item agent action.
 * Creates the item in Zotero and returns the result data.
 */
export async function executeCreateItemAction(
    action: AgentAction,
    opts?: ExecuteCreateItemActionOptions,
): Promise<CreateItemResultData> {
    const proposedData = action.proposed_data as CreateItemProposedData;
    
    if (!proposedData || !proposedData.item) {
        throw new Error('Invalid action: missing item data');
    }

    const targetLibrary = resolveWriteTargetLibrary(proposedData);
    if (!targetLibrary.ok) throw new Error(targetLibrary.message);
    const libraryId = targetLibrary.libraryID;

    logger(`executeCreateItemAction: Creating item "${proposedData.item.title}" in library ${libraryId}`, 1);

    // Create the item using the existing utility function
    // Pass resolved library to target the correct library
    const result = await applyCreateItemData(proposedData, {
        libraryId,
        actionId: action.id,
        onAttachmentResolved: opts?.onAttachmentResolved,
        runId: opts?.runId,
        threadId: opts?.threadId,
    });

    logger(`executeCreateItemAction: Successfully created item ${result.library_id}-${result.zotero_key}`, 1);


    return result;
}

/**
 * Undo a create_item agent action.
 * Deletes the item that was created from Zotero.
 */
export async function undoCreateItemAction(action: AgentAction): Promise<void> {
    const resultData = action.result_data as CreateItemResultData | undefined;

    // A portable `library_ref` is a complete reference; the numeric id may be
    // the unresolved sentinel. `resolveItemReference` below prefers the ref
    // anyway, so rejecting on the rowid alone fails an undo that would work.
    if (!resultData?.zotero_key || !hasLibraryIdentity(resultData)) {
        throw new Error('Cannot undo: no result data available (item was not created)');
    }

    logger(`undoCreateItemAction: Deleting item ${modelObjectIdFromReference(resultData)}`, 1);

    // Cancel any background tasks (PDF fetch, sync) for this item before
    // deletion. Task keys are device-local, so resolve the ref to this
    // device's rowid rather than passing the wire value through.
    const taskLibraryId = resolveLibraryRef(resultData);
    if (taskLibraryId) cancelTasksForItem(taskLibraryId, resultData.zotero_key);

    const resolved = await resolveItemReference(resultData);

    if (resolved.status === 'library_unavailable') {
        logger(`undoCreateItemAction: Library unavailable for ${resultData.library_ref || resultData.library_id}-${resultData.zotero_key}`, 1);
        return;
    }

    if (resolved.status === 'not_found') {
        // Item doesn't exist (may have been manually deleted)
        logger(`undoCreateItemAction: Item not found, may have been already deleted`, 1);
        return;
    }

    // Erase the item
    await resolved.item.eraseTx();

    logger(`undoCreateItemAction: Successfully deleted item ${resultData.library_id}-${resultData.zotero_key}`, 1);
}

/**
 * Result of a batch execute operation
 */
export interface BatchExecuteResult {
    /** Successfully executed actions with their results */
    successes: Array<{ action: AgentAction; result: CreateItemResultData }>;
    /** Failed actions with their errors */
    failures: Array<{ action: AgentAction; error: string; errorDetails?: Record<string, any> }>;
}

/**
 * Execute multiple create_item agent actions in batch with concurrency limiting.
 * Returns results for all actions, tracking successes and failures separately.
 * 
 * Uses a concurrency limit to avoid overwhelming Zotero's database
 * while still being faster than sequential execution.
 */
export async function executeCreateItemActions(
    actions: AgentAction[],
    opts?: ExecuteCreateItemActionOptions,
): Promise<BatchExecuteResult> {
    const result: BatchExecuteResult = {
        successes: [],
        failures: [],
    };

    if (actions.length === 0) {
        return result;
    }

    logger(`executeCreateItemActions: Starting batch of ${actions.length} items with concurrency ${BATCH_CONCURRENCY_LIMIT}`, 1);

    // Process actions with concurrency limiting
    const results = await runWithConcurrency(
        actions,
        async (action) => {
            try {
                const itemResult = await executeCreateItemAction(action, opts);
                return { success: true as const, action, result: itemResult };
            } catch (error: any) {
                const errorMessage = error?.message || 'Failed to create item';
                const errorDetails = {
                    stack_trace: error?.stack || '',
                    error_name: error?.name,
                };
                logger(`executeCreateItemActions: Failed to execute action ${action.id}: ${errorMessage}`, 2);
                return { success: false as const, action, error: errorMessage, errorDetails };
            }
        },
        BATCH_CONCURRENCY_LIMIT
    );

    // Separate successes and failures
    for (const res of results) {
        if (res.success) {
            result.successes.push({ action: res.action, result: res.result });
        } else {
            result.failures.push({ action: res.action, error: res.error, errorDetails: res.errorDetails });
        }
    }

    logger(`executeCreateItemActions: Completed batch - ${result.successes.length} succeeded, ${result.failures.length} failed`, 1);
    return result;
}

/**
 * Run async functions with a concurrency limit.
 * Like Promise.all but limits how many run simultaneously.
 */
async function runWithConcurrency<T, R>(
    items: T[],
    fn: (item: T) => Promise<R>,
    concurrency: number
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let currentIndex = 0;

    async function worker(): Promise<void> {
        while (currentIndex < items.length) {
            const index = currentIndex++;
            results[index] = await fn(items[index]);
        }
    }

    // Start workers up to concurrency limit
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(concurrency, items.length); i++) {
        workers.push(worker());
    }

    await Promise.all(workers);
    return results;
}

/**
 * Result of a batch undo operation
 */
export interface BatchUndoResult {
    /** Successfully undone action IDs */
    successes: string[];
    /** Failed action IDs with their errors */
    failures: Array<{ actionId: string; error: string; errorDetails?: Record<string, any> }>;
}

/**
 * Undo multiple create_item agent actions in batch with concurrency limiting.
 * Returns results for all actions, tracking successes and failures separately.
 */
export async function undoCreateItemActions(actions: AgentAction[]): Promise<BatchUndoResult> {
    const result: BatchUndoResult = {
        successes: [],
        failures: [],
    };

    if (actions.length === 0) {
        return result;
    }

    logger(`undoCreateItemActions: Starting batch undo of ${actions.length} items`, 1);

    // Process actions with concurrency limiting
    const results = await runWithConcurrency(
        actions,
        async (action) => {
            try {
                await undoCreateItemAction(action);
                return { success: true as const, actionId: action.id };
            } catch (error: any) {
                const errorMessage = error?.message || 'Failed to undo item creation';
                const errorDetails = {
                    stack_trace: error?.stack || '',
                    error_name: error?.name,
                };
                logger(`undoCreateItemActions: Failed to undo action ${action.id}: ${errorMessage}`, 2);
                return { success: false as const, actionId: action.id, error: errorMessage, errorDetails };
            }
        },
        BATCH_CONCURRENCY_LIMIT
    );

    // Separate successes and failures
    for (const res of results) {
        if (res.success) {
            result.successes.push(res.actionId);
        } else {
            result.failures.push({ actionId: res.actionId, error: res.error, errorDetails: res.errorDetails });
        }
    }

    logger(`undoCreateItemActions: Completed batch - ${result.successes.length} succeeded, ${result.failures.length} failed`, 1);
    return result;
}
