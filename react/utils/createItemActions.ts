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

/**
 * Execute a create_item agent action.
 * Creates the item in Zotero and returns the result data.
 */
export async function executeCreateItemAction(action: AgentAction): Promise<CreateItemResultData> {
    const proposedData = action.proposed_data as CreateItemProposedData;
    
    if (!proposedData || !proposedData.item) {
        throw new Error('Invalid action: missing item data');
    }

    logger(`executeCreateItemAction: Creating item "${proposedData.item.title}"`, 1);

    // Create the item using the existing utility function
    const result = await applyCreateItemData(proposedData);

    // Sync the newly created item to backend
    try {
        await ensureItemSynced(result.library_id, result.zotero_key);
    } catch (error) {
        logger(`executeCreateItemAction: Failed to sync item: ${error}`, 2);
    }

    logger(`executeCreateItemAction: Successfully created item ${result.library_id}-${result.zotero_key}`, 1);

    return result;
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
 * Execute multiple create_item agent actions in batch.
 * Returns results for all actions, tracking successes and failures separately.
 */
export async function executeCreateItemActions(actions: AgentAction[]): Promise<BatchExecuteResult> {
    const result: BatchExecuteResult = {
        successes: [],
        failures: [],
    };

    for (const action of actions) {
        try {
            const itemResult = await executeCreateItemAction(action);
            result.successes.push({ action, result: itemResult });
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to create item';
            logger(`executeCreateItemActions: Failed to execute action ${action.id}: ${errorMessage}`, 2);
            result.failures.push({ action, error: errorMessage });
        }
    }

    logger(`executeCreateItemActions: Completed batch - ${result.successes.length} succeeded, ${result.failures.length} failed`, 1);
    return result;
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
 * Undo multiple create_item agent actions in batch.
 * Returns results for all actions, tracking successes and failures separately.
 */
export async function undoCreateItemActions(actions: AgentAction[]): Promise<BatchUndoResult> {
    const result: BatchUndoResult = {
        successes: [],
        failures: [],
    };

    for (const action of actions) {
        try {
            await undoCreateItemAction(action);
            result.successes.push(action.id);
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to undo item creation';
            logger(`undoCreateItemActions: Failed to undo action ${action.id}: ${errorMessage}`, 2);
            result.failures.push({ actionId: action.id, error: errorMessage });
        }
    }

    logger(`undoCreateItemActions: Completed batch - ${result.successes.length} succeeded, ${result.failures.length} failed`, 1);
    return result;
}
