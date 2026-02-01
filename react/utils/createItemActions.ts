/**
 * Create Item Action Utilities
 * 
 * Functions for executing and undoing create_item agent actions.
 * These are used by AgentActionView for post-run action handling.
 */

import { AgentAction } from '../agents/agentActions';
import { CreateItemProposedData, CreateItemResultData } from '../types/agentActions/items';
import { applyCreateItemData } from './addItemActions';
import { logger } from '../../src/utils/logger';
import { ensureItemSynced } from '../../src/utils/sync';
import { scheduleBackgroundTask, generateTaskId, cancelTasksForItem, deduplicatedSync } from '../../src/utils/backgroundTasks';

/** Maximum concurrent item creations in batch operations */
const BATCH_CONCURRENCY_LIMIT = 3;

/**
 * Execute a create_item agent action.
 * Creates the item in Zotero and returns the result data.
 * Sync is scheduled as a background task (non-blocking).
 */
export async function executeCreateItemAction(action: AgentAction): Promise<CreateItemResultData> {
    const proposedData = action.proposed_data as CreateItemProposedData;
    
    if (!proposedData || !proposedData.item) {
        throw new Error('Invalid action: missing item data');
    }

    logger(`executeCreateItemAction: Creating item "${proposedData.item.title}"`, 1);

    // Create the item using the existing utility function
    // Pass target library when provided to avoid defaulting to context library
    const result = await applyCreateItemData(proposedData, {
        libraryId: proposedData.library_id,
    });

    logger(`executeCreateItemAction: Successfully created item ${result.library_id}-${result.zotero_key}`, 1);

    // Schedule sync as background task (non-blocking)
    scheduleSyncTask(result.library_id, result.zotero_key);

    return result;
}

/**
 * Schedule a background task to sync an item to the backend.
 */
function scheduleSyncTask(libraryId: number, itemKey: string): void {
    const taskId = generateTaskId('sync', libraryId, itemKey);

    scheduleBackgroundTask(
        taskId,
        'sync',
        async (signal: AbortSignal) => {
            if (signal.aborted) return;
            try {
                await deduplicatedSync(libraryId, itemKey, async () => { await ensureItemSynced(libraryId, itemKey); });
                logger(`scheduleSyncTask: Synced item ${libraryId}-${itemKey}`, 2);
            } catch (error) {
                logger(`scheduleSyncTask: Failed to sync item ${libraryId}-${itemKey}: ${error}`, 1);
                throw error; // Re-throw to mark task as failed
            }
        },
        {
            itemKey,
            libraryId,
            progressMessage: 'Syncing to Beaver...',
        }
    );
}

/**
 * Undo a create_item agent action.
 * Deletes the item that was created from Zotero.
 */
export async function undoCreateItemAction(action: AgentAction): Promise<void> {
    const resultData = action.result_data as CreateItemResultData | undefined;

    if (!resultData?.library_id || !resultData?.zotero_key) {
        throw new Error('Cannot undo: no result data available (item was not created)');
    }

    logger(`undoCreateItemAction: Deleting item ${resultData.library_id}-${resultData.zotero_key}`, 1);

    // Cancel any background tasks (PDF fetch, sync) for this item before deletion
    cancelTasksForItem(resultData.library_id, resultData.zotero_key);

    // Get the item
    const item = await Zotero.Items.getByLibraryAndKeyAsync(
        resultData.library_id,
        resultData.zotero_key
    );

    if (!item) {
        // Item doesn't exist (may have been manually deleted)
        logger(`undoCreateItemAction: Item not found, may have been already deleted`, 1);
        return;
    }

    // Erase the item
    await item.eraseTx();

    logger(`undoCreateItemAction: Successfully deleted item ${resultData.library_id}-${resultData.zotero_key}`, 1);
}

/**
 * Result of a batch execute operation
 */
export interface BatchExecuteResult {
    /** Successfully executed actions with their results */
    successes: Array<{ action: AgentAction; result: CreateItemResultData }>;
    /** Failed actions with their errors */
    failures: Array<{ action: AgentAction; error: string }>;
}

/**
 * Execute multiple create_item agent actions in batch with concurrency limiting.
 * Returns results for all actions, tracking successes and failures separately.
 * 
 * Uses a concurrency limit to avoid overwhelming Zotero's database
 * while still being faster than sequential execution.
 */
export async function executeCreateItemActions(actions: AgentAction[]): Promise<BatchExecuteResult> {
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
                const itemResult = await executeCreateItemAction(action);
                return { success: true as const, action, result: itemResult };
            } catch (error: any) {
                const errorMessage = error?.message || 'Failed to create item';
                logger(`executeCreateItemActions: Failed to execute action ${action.id}: ${errorMessage}`, 2);
                return { success: false as const, action, error: errorMessage };
            }
        },
        BATCH_CONCURRENCY_LIMIT
    );

    // Separate successes and failures
    for (const res of results) {
        if (res.success) {
            result.successes.push({ action: res.action, result: res.result });
        } else {
            result.failures.push({ action: res.action, error: res.error });
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
    failures: Array<{ actionId: string; error: string }>;
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
                logger(`undoCreateItemActions: Failed to undo action ${action.id}: ${errorMessage}`, 2);
                return { success: false as const, actionId: action.id, error: errorMessage };
            }
        },
        BATCH_CONCURRENCY_LIMIT
    );

    // Separate successes and failures
    for (const res of results) {
        if (res.success) {
            result.successes.push(res.actionId);
        } else {
            result.failures.push({ actionId: res.actionId, error: res.error });
        }
    }

    logger(`undoCreateItemActions: Completed batch - ${result.successes.length} succeeded, ${result.failures.length} failed`, 1);
    return result;
}
