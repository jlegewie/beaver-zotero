/**
 * Utilities for executing and undoing edit_metadata agent actions.
 * These functions are used by AgentActionView for post-run action handling.
 */

import { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { logger } from '@beaver/agent-core/platform/logger';
import { AppliedMetadataEdit, CreatorJSON, EditMetadataProposedData, EditMetadataResultData, MetadataEdit } from '@beaver/agent-core/types/agentActions/base';
import { resolveItemReference } from '../../utils/libraryIdentity';
import { resolveFieldForItemType, sanitizeCreators } from '../../utils/zoteroUtils';
import { actionError, unboundedExecutionContext } from '../agentDataProvider/actions/actionExecution';
import { applyEditMetadata } from '../agentDataProvider/actions/editMetadata';
import { joinList, ManualApplyOptions, staleProposalError } from './staleProposal';

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

function readField(item: Zotero.Item, field: string): any {
    try {
        return item.getField(field, false, true) ?? null;
    } catch {
        // Field might not exist, treat as null
        return null;
    }
}

function fieldLabel(field: string): string {
    try {
        return Zotero.ItemFields.getLocalizedString(field) || field;
    } catch {
        return field;
    }
}

/**
 * Throw `stale_proposal` when a field or the creators changed in Zotero since
 * the edit was proposed: the current value matches neither the value the user
 * saw (`old_value`, `old_creators`) nor the one the edit writes. Edits stored
 * without those baselines are not checked.
 */
function assertMetadataUnchanged(
    item: Zotero.Item,
    edits: MetadataEdit[],
    creators: CreatorJSON[] | null | undefined,
    oldCreators: CreatorJSON[] | null | undefined,
): void {
    const changed: string[] = [];
    for (const edit of edits) {
        if (edit.old_value === undefined) continue;
        const field = resolveFieldForItemType(item.itemTypeID, edit.field) ?? edit.field;
        const current = readField(item, field);
        if (!valuesEqual(current, edit.old_value) && !valuesEqual(current, edit.new_value)) {
            changed.push(fieldLabel(field));
        }
    }
    if (creators && creators.length > 0 && Array.isArray(oldCreators)) {
        const current = item.getCreatorsJSON() as CreatorJSON[];
        if (!creatorsEqual(current, oldCreators) && !creatorsEqual(current, sanitizeCreators(creators))) {
            changed.push('Creators');
        }
    }
    if (changed.length > 0) {
        throw staleProposalError(
            `${joinList(changed)} changed in Zotero after this edit was proposed.`,
        );
    }
}

/**
 * Apply a stored edit_metadata action through the shared executor
 * (`applyEditMetadata`), which records each field's value before the edit for
 * undo.
 *
 * Refuses with `stale_proposal` when an edited field changed since the
 * proposal, unless `options.skipStaleCheck`. When some edits fail but others
 * are saved, the result lists the failures in `failed_edits`, so the saved
 * ones stay undoable; it throws only when nothing was saved.
 */
export async function executeEditMetadataAction(
    action: AgentAction,
    options: ManualApplyOptions = {},
): Promise<EditMetadataResultData> {
    const data = action.proposed_data as EditMetadataProposedData;
    const result = await applyEditMetadata(data, unboundedExecutionContext(), {
        assertUnchanged: options.skipStaleCheck
            ? undefined
            : (item) => assertMetadataUnchanged(item, data.edits, data.creators, data.old_creators),
    });

    // Nothing saved: fail the action. Once something is saved, the result is
    // recorded (with its failures) so the saved fields can be undone.
    const nothingSaved = result.applied_edits.length === 0 && !result.new_creators;
    if (result.failed_edits.length > 0 && nothingSaved) {
        throw actionError(
            'edit_failed',
            `No edits could be applied: ${result.failed_edits.map(e => `${e.field} (${e.error})`).join(', ')}`,
        );
    }
    return result;
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
        library_ref?: string;
        zotero_key: string;
    };

    const resolved = await resolveItemReference(action.proposed_data as any);
    if (resolved.status === 'library_unavailable') {
        logger(`undoEditMetadataAction: Library unavailable for ${library_id}-${zotero_key}`, 1);
        return {
            fieldsReverted: 0,
            alreadyReverted: [],
            manuallyModified: [],
            needsConfirmation: false,
        };
    }
    if (resolved.status === 'not_found') {
        throw new Error(`Item not found: ${library_id}-${zotero_key}`);
    }
    const item = resolved.item;

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
        // Stored edits keep the agent-supplied label, which may belong to
        // another item type; resolve it the same way the apply path did.
        const field = resolveFieldForItemType(item.itemTypeID, edit.field) ?? edit.field;
        const oldValue = 'old_value' in edit ? edit.old_value : null;
        const appliedValue = 'applied_value' in edit ? edit.applied_value : (edit as MetadataEdit).new_value;

        // Get current value in Zotero
        let currentValue: any = null;
        try {
            currentValue = item.getField(field, false, true);
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
