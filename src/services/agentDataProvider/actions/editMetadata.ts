import { logger } from '../../../utils/logger';
import { searchableLibraryIdsAtom } from '../../../../react/atoms/profile';
import { store } from '../../../../react/store';
import { MetadataEdit } from '../../../../react/types/agentActions/base';
import { canSetField, SETTABLE_PRIMARY_FIELDS, sanitizeCreators } from '../../../utils/zoteroUtils';
import {
    WSAgentActionValidateRequest,
    WSAgentActionValidateResponse,
    WSAgentActionExecuteRequest,
    WSAgentActionExecuteResponse,
} from '../../agentProtocol';
import { getDeferredToolPreference } from '../utils';
import { TimeoutContext, checkAborted } from '../timeout';
import { TimeoutError } from '../timeout';


/**
 * Fields that Beaver should NOT modify, even though they may be technically settable.
 * These are system fields, metadata, or fields that require special handling.
 * 
 * Note: This list only includes fields that CAN be set but SHOULD NOT be.
 * Fields that can't be set at all (like 'firstCreator', 'id', etc.) are 
 * already handled by canSetField().
 */
const AI_RESTRICTED_FIELDS = [
    // System metadata - technically settable but should be immutable
    'dateAdded',        // Creation timestamp - immutable record
    'dateModified',     // Managed automatically by Zotero
    
    // Sync/versioning - critical for data integrity
    'version',          // Used for sync conflict resolution
    'synced',           // Sync status flag
    
    // Group library metadata - user/permission related
    'createdByUserID',
    'lastModifiedByUserID',
    
    // Structural changes - too risky for AI
    'itemTypeID',       // Changing item type can lose data
] as const;

const ATTACHMENT_EDITABLE_FIELDS = ['title', 'url'] as const;

// ============================================================================
// Field Validation Types and Functions
// ============================================================================

/** Result of validating a single field edit */
export interface FieldValidationResult {
    allowed: boolean;
    error?: string;
    error_code?: 'field_restricted' | 'field_unknown' | 'field_invalid_for_type';
}

/** Error information for a failed field validation */
export interface FieldValidationError {
    field: string;
    error: string;
    error_code: 'field_restricted' | 'field_unknown' | 'field_invalid_for_type';
}

/** Result of validating all field edits */
export interface AllEditsValidationResult {
    valid: boolean;
    errors: FieldValidationError[];
}

// ============================================================================
// Creator Validation Types
// ============================================================================

/** A creator in Zotero's JSON API format */
interface CreatorJSON {
    firstName?: string;
    lastName?: string;
    name?: string;
    creatorType: string;
}

/** Error information for a failed creator validation */
interface CreatorValidationError {
    index: number;
    error: string;
    error_code: 'invalid_structure' | 'invalid_creator_type';
}

/** Result of validating all creator entries */
interface CreatorValidationResult {
    valid: boolean;
    errors: CreatorValidationError[];
}

/**
 * Validates whether a field can be edited, with detailed error information.
 * This combines policy checks (AI restrictions) with technical checks (Zotero schema).
 * 
 * @param item - The Zotero item being edited
 * @param field - The field name to validate
 * @returns Validation result with allowed status and error details if not allowed
 */
export function validateFieldEdit(item: Zotero.Item, field: string): FieldValidationResult {
    // Attachments are intentionally scoped to a small safe subset.
    if (
        item.isAttachment() &&
        !(ATTACHMENT_EDITABLE_FIELDS as readonly string[]).includes(field)
    ) {
        return {
            allowed: false,
            error: `Field '${field}' is not editable for attachments. Only these fields are allowed: ${ATTACHMENT_EDITABLE_FIELDS.join(', ')}`,
            error_code: 'field_restricted',
        };
    }

    // 1. Check if field is restricted by AI safety policy
    if ((AI_RESTRICTED_FIELDS as readonly string[]).includes(field)) {
        return {
            allowed: false,
            error: `Field '${field}' is a system field that should not be modified by AI`,
            error_code: 'field_restricted'
        };
    }
    
    // 2. Check if field exists in Zotero's schema
    const fieldID = Zotero.ItemFields.getID(field);
    if (!fieldID && !(SETTABLE_PRIMARY_FIELDS as readonly string[]).includes(field)) {
        return {
            allowed: false,
            error: `Field '${field}' does not exist in Zotero's schema`,
            error_code: 'field_unknown'
        };
    }
    
    // 3. Check if field is technically editable for this item type
    if (!canSetField(item, field)) {
        const itemType = Zotero.ItemTypes.getName(item.itemTypeID);
        const itemTypeID = item.itemTypeID;
        const typeFields = Zotero.ItemFields.getItemTypeFields(itemTypeID);
        const typeFieldNames = typeFields.map((fid: number) => Zotero.ItemFields.getName(fid));

        return {
            allowed: false,
            error: `Field '${field}' is not valid for item type '${itemType}'. Valid fields: ${typeFieldNames.join(', ')}`,
            error_code: 'field_invalid_for_type'
        };
    }
    
    return { allowed: true };
}

/**
 * Validates all field edits and returns detailed error information for each failure.
 * This reports ALL invalid fields at once instead of failing on the first one.
 * 
 * @param item - The Zotero item being edited
 * @param edits - Array of field edits to validate
 * @returns Validation result with all errors
 */
export function validateAllEdits(item: Zotero.Item, edits: MetadataEdit[]): AllEditsValidationResult {
    const errors: FieldValidationError[] = [];
    
    for (const edit of edits) {
        const result = validateFieldEdit(item, edit.field);
        if (!result.allowed) {
            errors.push({
                field: edit.field,
                error: result.error!,
                error_code: result.error_code!
            });
        }
    }
    
    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Validates an array of creators for structural correctness and type compatibility.
 * Reports ALL errors at once (batch pattern matching validateAllEdits).
 *
 * Checks per creator:
 * 1. Must have either `name` (org) or `lastName` (person), not both, not neither
 * 2. Must have `creatorType` string
 * 3. `creatorType` must be a known Zotero creator type
 * 4. `creatorType` must be valid for the item's type
 *
 * @param item - The Zotero item whose type determines valid creator types
 * @param creators - Array of creators in JSON API format
 * @returns Validation result with all errors
 */
export function validateCreators(item: Zotero.Item, creators: CreatorJSON[]): CreatorValidationResult {
    const errors: CreatorValidationError[] = [];
    const itemTypeID = item.itemTypeID;

    for (let i = 0; i < creators.length; i++) {
        const creator = creators[i];

        // Check structure: must have either name (org) or lastName (person), not both
        const hasName = typeof creator.name === 'string' && creator.name.length > 0;
        const hasLastName = typeof creator.lastName === 'string' && creator.lastName.length > 0;

        if (hasName && hasLastName) {
            errors.push({
                index: i,
                error: `Creator at index ${i} has both 'name' and 'lastName'. Use 'name' for organizations or 'firstName'/'lastName' for persons.`,
                error_code: 'invalid_structure',
            });
            continue;
        }

        if (!hasName && !hasLastName) {
            errors.push({
                index: i,
                error: `Creator at index ${i} must have either 'name' (organization) or 'lastName' (person).`,
                error_code: 'invalid_structure',
            });
            continue;
        }

        // Check creatorType is provided
        if (!creator.creatorType || typeof creator.creatorType !== 'string') {
            errors.push({
                index: i,
                error: `Creator at index ${i} must have a 'creatorType' string.`,
                error_code: 'invalid_structure',
            });
            continue;
        }

        // Check creatorType is known in Zotero's schema
        const creatorTypeID = Zotero.CreatorTypes.getID(creator.creatorType);
        if (!creatorTypeID) {
            errors.push({
                index: i,
                error: `Creator at index ${i} has unknown creator type '${creator.creatorType}'.`,
                error_code: 'invalid_creator_type',
            });
            continue;
        }

        // Check creatorType is valid for the item's type
        if (!Zotero.CreatorTypes.isValidForItemType(creatorTypeID, itemTypeID)) {
            const validTypes = Zotero.CreatorTypes.getTypesForItemType(itemTypeID);
            const validTypeNames = validTypes.map((t: { id: number; name: string }) => t.name);
            const itemType = Zotero.ItemTypes.getName(itemTypeID);
            errors.push({
                index: i,
                error: `Creator type '${creator.creatorType}' is not valid for item type '${itemType}'. Valid creator types: ${validTypeNames.join(', ')}`,
                error_code: 'invalid_creator_type',
            });
        }
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}


/**
 * Checks if Beaver should be allowed to edit this field.
 * More restrictive than canSetField() - focuses on safety and best practices.
 *
 * @deprecated Use validateFieldEdit() for detailed error information
 */
export function isFieldEditAllowed(item: Zotero.Item, field: string): boolean {
    return validateFieldEdit(item, field).allowed;
}

// ============================================================================
// In-memory rollback helpers
// ============================================================================

/**
 * Restore in-memory field values on an item after a failed save or timeout.
 * Prevents dirty in-memory state from leaking into future saves.
 */
function restoreFieldSnapshots(
    item: any,
    snapshots: Array<{ field: string; originalValue: any }>,
): void {
    for (const snap of snapshots) {
        try {
            item.setField(snap.field, snap.originalValue ?? '');
        } catch (_) {
            // Best-effort restoration — field may not be settable
        }
    }
}

/**
 * Restore in-memory creators on an item after a failed save or timeout.
 * Uses the internal format snapshot from item.getCreators().
 */
function restoreCreatorSnapshots(item: any, originalCreators: any[] | null): void {
    if (originalCreators === null) return;
    try {
        item.setCreators(originalCreators);
    } catch (_) {
        // Best-effort restoration — setCreators may fail if item is in bad state
    }
}


// ============================================================================
// Edit Metadata Action Validation and Execution
// ============================================================================

/**
 * Validate an edit_metadata action.
 * Checks if the item exists, validates all fields (batch), and returns current field values.
 */
async function validateEditMetadataAction(
    request: WSAgentActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    const { library_id, zotero_key, edits, creators } = request.action_data as {
        library_id: number;
        zotero_key: string;
        edits: MetadataEdit[];
        creators?: CreatorJSON[] | null;
    };

    // Validate library exists
    const library = Zotero.Libraries.get(library_id);
    if (!library) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library not found: ${library_id}`,
            error_code: 'library_not_found',
            preference: 'always_ask',
        };
    }

    // Validate library is searchable
    const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
    if (!searchableLibraryIds.includes(library_id)) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library exists but is not synced with Beaver. The user can update this setting in Beaver Preferences. Library: ${library.name} (ID: ${library_id})`,
            error_code: 'library_not_searchable',
            preference: 'always_ask',
        };
    }

    // Validate item exists
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Item not found: ${library_id}-${zotero_key}`,
            error_code: 'item_not_found',
            preference: 'always_ask',
        };
    }

    // Validate item type
    if (item.isNote()) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Editing Notes is not supported`,
            error_code: 'note_items_not_supported',
            preference: 'always_ask',
        };
    }

    if (item.isAnnotation()) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Editing Annotations is not supported`,
            error_code: 'annotation_items_not_supported',
            preference: 'always_ask',
        };
    }

    if (item.isAttachment()) {
        // Attachments support a limited set of fields (title, url).
        // Reject creator edits — attachments have no valid creator types.
        if (creators != null && creators.length > 0) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: 'Attachments do not support creators. Only the following fields can be edited on attachments: title, url.',
                error_code: 'creators_not_supported_for_attachments',
                preference: 'always_ask',
            };
        }
        // Attachment field allowlist is enforced by validateFieldEdit()/validateAllEdits() below.
    } else if (!item.isRegularItem()) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Editing items other than regular items is not supported`,
            error_code: 'item_type_not_supported',
            preference: 'always_ask',
        };
    }

    // Check if library is editable (check early to avoid unnecessary field validation)
    if (!library || !library.editable) {
        const libraryName = library && typeof library !== 'boolean' ? library.name : String(library_id);
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library '${libraryName}' is read-only and cannot be edited`,
            error_code: 'library_not_editable',
            preference: 'always_ask',
        };
    }

    // Check that at least one change is specified
    const hasEdits = edits && edits.length > 0;
    const hasCreators = creators != null && creators.length > 0;

    // Reject empty creators array — the agent cannot clear all creators
    if (Array.isArray(creators) && creators.length === 0) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'Empty creators array is not allowed. Provide at least one creator or omit the creators field.',
            error_code: 'empty_creators',
            preference: 'always_ask',
        };
    }

    if (!hasEdits && !hasCreators) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'No changes specified: at least one field edit or creators must be provided',
            error_code: 'no_changes',
            preference: 'always_ask',
        };
    }

    // Validate ALL fields using batch validation (reports all errors at once)
    if (hasEdits) {
        const validation = validateAllEdits(item, edits);
        if (!validation.valid) {
            const errorSummary = validation.errors
                .map(e => `${e.field}: ${e.error}`)
                .join('; ');

            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: errorSummary,
                error_code: 'field_validation_failed',
                errors: validation.errors,
                preference: 'always_ask',
            };
        }
    }

    // Validate creators if provided
    if (hasCreators) {
        const creatorValidation = validateCreators(item, creators!);
        if (!creatorValidation.valid) {
            const errorSummary = creatorValidation.errors
                .map(e => `[${e.index}]: ${e.error}`)
                .join('; ');

            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: errorSummary,
                error_code: 'creator_validation_failed',
                preference: 'always_ask',
            };
        }
    }

    // Get current values for all edited fields
    const currentValue: Record<string, any> = {};
    for (const edit of edits) {
        try {
            // includeBaseMapped=true so base fields resolve to type-specific fields
            const value = item.getField(edit.field, false, true);
            currentValue[edit.field] = value ? String(value) : null;
        } catch {
            currentValue[edit.field] = null;
        }
    }

    // Include current creators for before/after tracking (not applicable for attachments)
    if (item.isRegularItem()) {
        currentValue.current_creators = item.getCreatorsJSON();
    }

    // Get user preference from settings
    const preference = getDeferredToolPreference('edit_metadata');

    return {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: true,
        current_value: currentValue,
        preference,
    };
}


/**
 * Execute an edit_metadata action.
 * Applies the field edits to the Zotero item.
 */
async function executeEditMetadataAction(
    request: WSAgentActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const { library_id, zotero_key, edits, creators } = request.action_data as {
        library_id: number;
        zotero_key: string;
        edits: MetadataEdit[];
        creators?: Array<{ firstName?: string; lastName?: string; name?: string; creatorType: string }> | null;
    };

    // Get the item
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: `Item not found: ${library_id}-${zotero_key}`,
            error_code: 'item_not_found',
        };
    }

    const appliedEdits: Array<{ field: string; old_value: string | null; new_value: string }> = [];
    const failedEdits: Array<{ field: string; error: string }> = [];
    // Snapshot original field values for in-memory rollback on failure
    const fieldSnapshots: Array<{ field: string; originalValue: any }> = [];
    // Snapshot original creators for in-memory rollback on failure
    let creatorSnapshot: any[] | null = null;
    let oldCreatorsJSON: any[] | null = null;
    let creatorsApplied = false;

    try {
        // Apply each field edit (in-memory only, not persisted until saveTx)
        for (const edit of edits) {
            try {
                // includeBaseMapped=true so base fields (e.g. 'publicationTitle')
                // resolve to the type-specific field (e.g. 'bookTitle' on bookSection)
                const oldValue = item.getField(edit.field, false, true);
                fieldSnapshots.push({ field: edit.field, originalValue: oldValue });
                item.setField(edit.field, edit.new_value);
                appliedEdits.push({
                    field: edit.field,
                    old_value: oldValue ? String(oldValue) : null,
                    new_value: edit.new_value,
                });
            } catch (error) {
                // Re-throw TimeoutError so it propagates to the outer catch
                if (error instanceof TimeoutError) throw error;
                failedEdits.push({
                    field: edit.field,
                    error: String(error),
                });
            }
        }

        // Apply creators (in-memory only, not persisted until saveTx)
        if (creators && creators.length > 0) {
            try {
                creatorSnapshot = item.getCreators();
                oldCreatorsJSON = item.getCreatorsJSON();
                // Type assertion: creatorType has been validated by the validate handler
                item.setCreators(sanitizeCreators(creators) as any[]);
                creatorsApplied = true;
            } catch (error) {
                if (error instanceof TimeoutError) throw error;
                failedEdits.push({
                    field: 'creators',
                    error: String(error),
                });
            }
        }

        // Save the item if any changes were applied
        if (appliedEdits.length > 0 || creatorsApplied) {
            // Checkpoint: abort before persisting if timeout has fired
            checkAborted(ctx, 'edit_metadata:before_save');
            try {
                await item.saveTx();
                logger(`executeEditMetadataAction: Saved ${appliedEdits.length} edits${creatorsApplied ? ' + creators' : ''} to ${library_id}-${zotero_key}`, 1);
            } catch (error) {
                if (error instanceof TimeoutError) throw error;
                // Save failed — restore in-memory state so dirty fields don't leak
                restoreFieldSnapshots(item, fieldSnapshots);
                restoreCreatorSnapshots(item, creatorSnapshot);
                return {
                    type: 'agent_action_execute_response',
                    request_id: request.request_id,
                    success: false,
                    error: `Failed to save item: ${error}`,
                    error_code: 'save_failed',
                };
            }
        }

        const allSucceeded = failedEdits.length === 0;

        // Build result data
        const resultData: Record<string, any> = {
            applied_edits: appliedEdits,
            failed_edits: failedEdits,
        };

        // Include creator change info in result
        if (creatorsApplied) {
            resultData.old_creators = oldCreatorsJSON;
            resultData.new_creators = item.getCreatorsJSON();
        }

        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: allSucceeded,
            error: allSucceeded ? undefined : `Some edits failed: ${failedEdits.map(e => e.field).join(', ')}`,
            result_data: resultData,
        };
    } catch (error) {
        // Restore in-memory state on any unhandled error (including TimeoutError)
        restoreFieldSnapshots(item, fieldSnapshots);
        restoreCreatorSnapshots(item, creatorSnapshot);
        throw error;
    }
}

export { validateEditMetadataAction, executeEditMetadataAction };
