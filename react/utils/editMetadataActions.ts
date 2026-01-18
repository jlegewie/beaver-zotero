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
    old_value: any;
    new_value: any;
}

/**
 * Result of an undo operation
 */
export interface UndoResult {
    /** Whether any fields were actually reverted */
    fieldsReverted: number;
    /** Fields that were already at old_value (no change needed) */
    alreadyReverted: string[];
    /** Fields that were manually modified by the user (not reverted to preserve user changes) */
    manuallyModified: string[];
    /** Whether user confirmation is needed (some fields were manually modified) */
    needsConfirmation: boolean;
}

/**
 * Normalize a field value for comparison.
 * Handles null, undefined, empty strings, and type coercion.
 */
function normalizeValue(value: any): string {
    if (value === null || value === undefined) return '';
    return String(value);
}

/**
 * Compare two field values for equality.
 */
function valuesEqual(a: any, b: any): boolean {
    return normalizeValue(a) === normalizeValue(b);
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
            let oldValue: any = null;
            try {
                const currentValue = item.getField(edit.field);
                oldValue = currentValue ?? null;
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
 * 
 * Handles three scenarios for each field:
 * 1. current_value == applied_value: Normal undo - revert to old_value
 * 2. current_value == old_value: Already reverted - no change needed
 * 3. current_value differs from both: User manually edited - preserve user's change
 * 
 * @param action The agent action to undo (must have been applied)
 * @param forceRevert If true, revert all fields even if manually modified (skip confirmation)
 * @returns Information about what was reverted and what needs confirmation
 */
export async function undoEditMetadataAction(
    action: AgentAction,
    forceRevert: boolean = false
): Promise<UndoResult> {
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
    
    const editsToProcess = appliedEdits ?? proposedEdits;
    
    if (!editsToProcess || editsToProcess.length === 0) {
        throw new Error('No edit data available for undo');
    }

    const result: UndoResult = {
        fieldsReverted: 0,
        alreadyReverted: [],
        manuallyModified: [],
        needsConfirmation: false,
    };

    let needsSave = false;

    for (const edit of editsToProcess) {
        const field = edit.field;
        const oldValue = 'old_value' in edit ? edit.old_value : null;
        const appliedValue = 'applied_value' in edit ? edit.applied_value : (edit as MetadataEdit).new_value;
        
        // Get current value in Zotero
        let currentValue: any = null;
        try {
            currentValue = item.getField(field);
        } catch {
            currentValue = null;
        }

        // Determine scenario
        if (valuesEqual(currentValue, oldValue)) {
            // Scenario 2: Already reverted - no change needed
            result.alreadyReverted.push(field);
            logger(`undoEditMetadataAction: Field '${field}' already at old value, skipping`, 1);
        } else if (valuesEqual(currentValue, appliedValue)) {
            // Scenario 1: Normal undo - revert to old_value
            try {
                item.setField(field, oldValue ?? '');
                result.fieldsReverted++;
                needsSave = true;
                logger(`undoEditMetadataAction: Reverted '${field}' to old value`, 1);
            } catch (error) {
                logger(`undoEditMetadataAction: Failed to revert ${field}: ${error}`, 1);
            }
        } else {
            // Scenario 3: User manually edited the field
            if (forceRevert) {
                // Force revert even if manually modified
                try {
                    item.setField(field, oldValue ?? '');
                    result.fieldsReverted++;
                    needsSave = true;
                    logger(`undoEditMetadataAction: Force-reverted manually modified '${field}'`, 1);
                } catch (error) {
                    logger(`undoEditMetadataAction: Failed to revert ${field}: ${error}`, 1);
                }
            } else {
                // Don't overwrite user's manual changes
                result.manuallyModified.push(field);
                logger(`undoEditMetadataAction: Field '${field}' was manually modified, preserving user's change`, 1);
            }
        }
    }

    // Save the item if any fields were reverted
    if (needsSave) {
        try {
            await item.saveTx();
            logger(`undoEditMetadataAction: Saved ${result.fieldsReverted} reverted fields on ${library_id}-${zotero_key}`, 1);
        } catch (error) {
            throw new Error(`Failed to save item after undo: ${error}`);
        }
    }

    // Set flag if confirmation is needed for manually modified fields
    result.needsConfirmation = result.manuallyModified.length > 0 && !forceRevert;

    return result;
}
