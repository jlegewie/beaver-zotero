/**
 * Utilities for executing and undoing edit_metadata agent actions.
 * These functions are used by AgentActionView for post-run action handling.
 */

import { AgentAction } from '../agents/agentActions';
import { EditMetadataResultData, AppliedMetadataEdit, FailedMetadataEdit, MetadataEdit, CreatorJSON } from '../types/agentActions/base';
import { logger } from '../../src/utils/logger';

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
 * Compare two CreatorJSON arrays for equality.
 * Order-sensitive: creators at the same index must match.
 */
function creatorsEqual(a: CreatorJSON[], b: CreatorJSON[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((creator, i) => {
        const other = b[i];
        return creator.creatorType === other.creatorType
            && (creator.firstName ?? '') === (other.firstName ?? '')
            && (creator.lastName ?? '') === (other.lastName ?? '')
            && (creator.name ?? '') === (other.name ?? '');
    });
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
    const { library_id, zotero_key, edits, creators } = action.proposed_data as {
        library_id: number;
        zotero_key: string;
        edits: MetadataEdit[];
        creators?: CreatorJSON[] | null;
    };

    // Get the item
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) {
        throw new Error(`Item not found: ${library_id}-${zotero_key}`);
    }

    const appliedEdits: AppliedMetadataEdit[] = [];
    const failedEdits: FailedMetadataEdit[] = [];
    let oldCreatorsJSON: CreatorJSON[] | null = null;
    let newCreatorsJSON: CreatorJSON[] | null = null;
    let creatorsApplied = false;

    // Apply each field edit, capturing current value BEFORE applying for reliable undo
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

    // Apply creators if provided (non-empty array)
    if (creators && creators.length > 0) {
        try {
            oldCreatorsJSON = item.getCreatorsJSON();
            item.setCreators(creators as any[]);
            creatorsApplied = true;
        } catch (error) {
            failedEdits.push({
                field: 'creators',
                error: String(error),
            });
        }
    }

    // Save the item if any changes were applied
    if (appliedEdits.length > 0 || creatorsApplied) {
        try {
            await item.saveTx();
            logger(`executeEditMetadataAction: Saved ${appliedEdits.length} edits${creatorsApplied ? ' + creators' : ''} to ${library_id}-${zotero_key}`, 1);
        } catch (error) {
            throw new Error(`Failed to save item: ${error}`);
        }
    }

    if (creatorsApplied) {
        newCreatorsJSON = item.getCreatorsJSON();
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
        old_creators: oldCreatorsJSON,
        new_creators: newCreatorsJSON,
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
    const editsToProcess = appliedEdits ?? proposedEdits ?? [];

    // Check if creators were changed (old_creators in result_data means they were applied)
    const oldCreators = action.result_data?.old_creators as CreatorJSON[] | null | undefined;
    const newCreators = action.result_data?.new_creators as CreatorJSON[] | null | undefined;
    const hasCreatorUndo = oldCreators != null;

    if (editsToProcess.length === 0 && !hasCreatorUndo) {
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

    // Restore creators if they were changed (same 3-way logic as field edits)
    if (hasCreatorUndo) {
        const currentCreators = item.getCreatorsJSON() as CreatorJSON[];

        if (creatorsEqual(currentCreators, oldCreators!)) {
            // Already at old value — no change needed
            result.alreadyReverted.push('creators');
            logger(`undoEditMetadataAction: Creators already at original values, skipping`, 1);
        } else if (newCreators && creatorsEqual(currentCreators, newCreators)) {
            // Current matches what we applied — normal undo
            try {
                item.setCreators(oldCreators as any[]);
                result.fieldsReverted++;
                needsSave = true;
                logger(`undoEditMetadataAction: Reverted creators to original values`, 1);
            } catch (error) {
                logger(`undoEditMetadataAction: Failed to revert creators: ${error}`, 1);
            }
        } else {
            // User manually modified creators since the apply
            if (forceRevert) {
                try {
                    item.setCreators(oldCreators as any[]);
                    result.fieldsReverted++;
                    needsSave = true;
                    logger(`undoEditMetadataAction: Force-reverted manually modified creators`, 1);
                } catch (error) {
                    logger(`undoEditMetadataAction: Failed to revert creators: ${error}`, 1);
                }
            } else {
                result.manuallyModified.push('creators');
                logger(`undoEditMetadataAction: Creators were manually modified, preserving user's change`, 1);
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
