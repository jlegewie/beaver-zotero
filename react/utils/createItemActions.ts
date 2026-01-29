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
