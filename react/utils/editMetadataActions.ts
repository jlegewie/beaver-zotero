/**
 * Utilities for executing and undoing edit_metadata agent actions.
 * These functions are used by AgentActionView for post-run action handling.
 */

import { AgentAction } from '../agents/agentActions';
import { EditMetadataResultData, AppliedMetadataEdit, FailedMetadataEdit } from '../types/agentActions/base';
import { logger } from '../../src/utils/logger';

/**
 * Metadata edit from proposed_data
 */
interface MetadataEdit {
    field: string;
    old_value: string | null;
    new_value: string;
}

/**
 * Execute an edit_metadata agent action by applying edits to the Zotero item.
 * @param action The agent action to execute
 * @returns Result data including applied and failed edits
 */
export async function executeEditMetadataAction(
    action: AgentAction
): Promise<EditMetadataResultData> {
    const { library_id, zotero_key, edits } = action.proposed_data as {
        library_id: number;
        zotero_key: string;
        edits: MetadataEdit[];
    };

    // Get the item
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) {
        throw new Error(`Item not found: ${library_id}-${zotero_key}`);
    }

    const appliedEdits: AppliedMetadataEdit[] = [];
    const failedEdits: FailedMetadataEdit[] = [];

    // Apply each edit
    for (const edit of edits) {
        try {
            item.setField(edit.field, edit.new_value);
            appliedEdits.push({
                field: edit.field,
                applied_value: edit.new_value,
            });
        } catch (error) {
            failedEdits.push({
                field: edit.field,
                error: String(error),
            });
        }
    }

    // Save the item if any edits were applied
    if (appliedEdits.length > 0) {
        try {
            await item.saveTx();
            logger(`executeEditMetadataAction: Saved ${appliedEdits.length} edits to ${library_id}-${zotero_key}`, 1);
        } catch (error) {
            throw new Error(`Failed to save item: ${error}`);
        }
    }

    if (failedEdits.length > 0) {
        throw new Error(`Some edits failed: ${failedEdits.map(e => e.field).join(', ')}`);
    }

    return {
        library_id,
        zotero_key,
        applied_edits: appliedEdits,
        rejected_edits: [],
        failed_edits: failedEdits,
    };
}

/**
 * Undo an edit_metadata agent action by reverting edits to the original values.
 * @param action The agent action to undo (must have been applied)
 */
export async function undoEditMetadataAction(action: AgentAction): Promise<void> {
    const { library_id, zotero_key, edits } = action.proposed_data as {
        library_id: number;
        zotero_key: string;
        edits: MetadataEdit[];
    };

    // Get the item
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) {
        throw new Error(`Item not found: ${library_id}-${zotero_key}`);
    }

    // Revert each edit to the old value
    for (const edit of edits) {
        try {
            // old_value can be null (meaning field was empty), so use empty string
            item.setField(edit.field, edit.old_value ?? '');
        } catch (error) {
            logger(`undoEditMetadataAction: Failed to revert ${edit.field}: ${error}`, 1);
            // Continue with other fields
        }
    }

    // Save the item
    try {
        await item.saveTx();
        logger(`undoEditMetadataAction: Reverted ${edits.length} edits on ${library_id}-${zotero_key}`, 1);
    } catch (error) {
        throw new Error(`Failed to save item after undo: ${error}`);
    }
}
