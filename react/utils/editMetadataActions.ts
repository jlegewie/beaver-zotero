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
 * Captures current values BEFORE applying so undo can reliably restore them.
 * @param action The agent action to execute
 * @returns Result data including applied edits with old values for undo
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

    // Apply each edit, capturing current value BEFORE applying for reliable undo
    for (const edit of edits) {
        try {
            // Capture current value before applying (for undo)
            let oldValue: string | null = null;
            try {
                const currentValue = item.getField(edit.field);
                oldValue = currentValue ? String(currentValue) : null;
            } catch {
                // Field might not exist, treat as null
                oldValue = null;
            }

            // Apply the new value
            item.setField(edit.field, edit.new_value);
            appliedEdits.push({
                field: edit.field,
                applied_value: edit.new_value,
                old_value: oldValue, // Store for undo
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
 * Uses old values from result_data.applied_edits (captured at apply-time) for reliability.
 * Falls back to proposed_data.edits if result_data is not available.
 * @param action The agent action to undo (must have been applied)
 */
export async function undoEditMetadataAction(action: AgentAction): Promise<void> {
    const { library_id, zotero_key } = action.proposed_data as {
        library_id: number;
        zotero_key: string;
    };

    // Get the item
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) {
        throw new Error(`Item not found: ${library_id}-${zotero_key}`);
    }

    // Prefer result_data.applied_edits (has old_value captured at apply-time)
    // Fall back to proposed_data.edits if result_data is not available
    const appliedEdits = action.result_data?.applied_edits as AppliedMetadataEdit[] | undefined;
    const proposedEdits = (action.proposed_data as { edits?: MetadataEdit[] }).edits;

    if (appliedEdits && appliedEdits.length > 0) {
        // Use old values from result_data (most reliable)
        for (const edit of appliedEdits) {
            try {
                // old_value can be null (meaning field was empty), so use empty string
                item.setField(edit.field, edit.old_value ?? '');
            } catch (error) {
                logger(`undoEditMetadataAction: Failed to revert ${edit.field}: ${error}`, 1);
                // Continue with other fields
            }
        }
        logger(`undoEditMetadataAction: Reverted ${appliedEdits.length} edits using result_data on ${library_id}-${zotero_key}`, 1);
    } else if (proposedEdits && proposedEdits.length > 0) {
        // Fallback: use old values from proposed_data (less reliable)
        logger(`undoEditMetadataAction: Falling back to proposed_data for ${library_id}-${zotero_key}`, 1);
        for (const edit of proposedEdits) {
            try {
                item.setField(edit.field, edit.old_value ?? '');
            } catch (error) {
                logger(`undoEditMetadataAction: Failed to revert ${edit.field}: ${error}`, 1);
            }
        }
    } else {
        throw new Error('No edit data available for undo');
    }

    // Save the item
    try {
        await item.saveTx();
    } catch (error) {
        throw new Error(`Failed to save item after undo: ${error}`);
    }
}
