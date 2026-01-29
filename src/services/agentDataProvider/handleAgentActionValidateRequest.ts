import { logger } from '../../utils/logger';
import { canSetField, SETTABLE_PRIMARY_FIELDS } from '../../utils/zoteroUtils';
import { searchableLibraryIdsAtom } from '../../../react/atoms/profile';
import type { MetadataEdit } from '../../../react/types/agentActions/base';
import { batchFindExistingReferences, BatchReferenceCheckItem } from '../../../react/utils/batchFindExistingReferences';

import { store } from '../../../react/store';
import {
    WSAgentActionValidateRequest,
    WSAgentActionValidateResponse,
} from '../agentProtocol';
import { getDeferredToolPreference } from './utils';


/**
 * Handle agent_action_validate request from backend.
 * Validates that an action can be performed and returns the current value
 * for before/after tracking, plus the user's preference.
 */
export async function handleAgentActionValidateRequest(
    request: WSAgentActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    logger(`handleAgentActionValidateRequest: Validating ${request.action_type}`, 1);

    try {
        if (request.action_type === 'edit_metadata') {
            return await validateEditMetadataAction(request);
        }

        if (request.action_type === 'create_collection') {
            return await validateCreateCollectionAction(request);
        }

        if (request.action_type === 'organize_items') {
            return await validateOrganizeItemsAction(request);
        }

        if (request.action_type === 'create_item') {
            return await validateCreateItemAction(request);
        }

        // Unsupported action type
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Unsupported action type: ${request.action_type}`,
            error_code: 'unsupported_action_type',
            preference: 'always_ask',
        };
    } catch (error) {
        logger(`handleAgentActionValidateRequest: Error: ${error}`, 1);
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: String(error),
            error_code: 'validation_failed',
            preference: 'always_ask',
        };
    }
}

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

/**
 * Validates whether a field can be edited, with detailed error information.
 * This combines policy checks (AI restrictions) with technical checks (Zotero schema).
 * 
 * @param item - The Zotero item being edited
 * @param field - The field name to validate
 * @returns Validation result with allowed status and error details if not allowed
 */
export function validateFieldEdit(item: Zotero.Item, field: string): FieldValidationResult {
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
        return {
            allowed: false,
            error: `Field '${field}' is not valid for item type '${itemType}'`,
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
 * Checks if Beaver should be allowed to edit this field.
 * More restrictive than canSetField() - focuses on safety and best practices.
 * 
 * @deprecated Use validateFieldEdit() for detailed error information
 */
export function isFieldEditAllowed(item: Zotero.Item, field: string): boolean {
    return validateFieldEdit(item, field).allowed;
}

/**
 * Validate an edit_metadata action.
 * Checks if the item exists, validates all fields (batch), and returns current field values.
 */
async function validateEditMetadataAction(
    request: WSAgentActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    const { library_id, zotero_key, edits } = request.action_data as {
        library_id: number;
        zotero_key: string;
        edits: MetadataEdit[];
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
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Editing Attachments is not supported`,
            error_code: 'attachment_items_not_supported',
            preference: 'always_ask',
        };
    }

    if (!item.isRegularItem()) {
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

    // Validate ALL fields using batch validation (reports all errors at once)
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

    // Get current values for all edited fields
    const currentValue: Record<string, string | null> = {};
    for (const edit of edits) {
        try {
            const value = item.getField(edit.field);
            // getField returns empty string for missing fields, or the field value
            currentValue[edit.field] = value ? String(value) : null;
        } catch {
            currentValue[edit.field] = null;
        }
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
 * Validate a create_collection action.
 * Checks if the library exists and is editable.
 */
async function validateCreateCollectionAction(
    request: WSAgentActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    const { library_id: rawLibraryId, name, parent_key, item_ids } = request.action_data as {
        library_id?: number | null;
        name: string;
        parent_key?: string | null;
        item_ids?: string[];
    };

    // Default to user's main library if not specified
    const library_id = rawLibraryId || Zotero.Libraries.userLibraryID;

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

    // Check if library is editable
    if (!library.editable) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library '${library.name}' is read-only and cannot be modified`,
            error_code: 'library_not_editable',
            preference: 'always_ask',
        };
    }

    // Validate collection name
    if (!name || name.trim().length === 0) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'Collection name cannot be empty',
            error_code: 'invalid_name',
            preference: 'always_ask',
        };
    }

    // Validate parent collection if provided
    if (parent_key) {
        const parentCollection = await Zotero.Collections.getByLibraryAndKeyAsync(library_id, parent_key);
        if (!parentCollection) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: `Parent collection not found: ${parent_key}`,
                error_code: 'parent_not_found',
                preference: 'always_ask',
            };
        }
    }

    // Validate item IDs if provided
    if (item_ids && item_ids.length > 0) {
        for (const itemId of item_ids) {
            const [libId, key] = itemId.split('-');
            const itemLibraryId = parseInt(libId, 10);
            
            // Items must be in the same library
            if (itemLibraryId !== library_id) {
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: `Item ${itemId} is not in library ${library_id}`,
                    error_code: 'item_library_mismatch',
                    preference: 'always_ask',
                };
            }
            
            const item = await Zotero.Items.getByLibraryAndKeyAsync(itemLibraryId, key);
            if (!item) {
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: `Item not found: ${itemId}`,
                    error_code: 'item_not_found',
                    preference: 'always_ask',
                };
            }
        }
    }

    // Get user preference from settings
    const preference = getDeferredToolPreference('create_collection');

    // Build current value for preview (includes resolved library_id)
    const currentValue = {
        library_id: library_id,
        library_name: library.name,
        parent_key: parent_key || null,
        item_count: item_ids?.length || 0,
    };

    return {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: true,
        current_value: currentValue,
        preference,
    };
}

/**
 * Validate an organize_items action.
 * Checks if items exist and are in editable libraries.
 * Returns current state of tags/collections for each item (for undo).
 */
async function validateOrganizeItemsAction(
    request: WSAgentActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    const { item_ids, tags, collections } = request.action_data as {
        item_ids: string[];
        tags?: { add?: string[]; remove?: string[] } | null;
        collections?: { add?: string[]; remove?: string[] } | null;
    };

    // Validate at least one item is provided
    if (!item_ids || item_ids.length === 0) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'At least one item_id must be provided',
            error_code: 'no_items',
            preference: 'always_ask',
        };
    }

    // Validate max items
    if (item_ids.length > 100) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'Maximum 100 items can be organized at once',
            error_code: 'too_many_items',
            preference: 'always_ask',
        };
    }

    // Validate at least one change is requested
    const hasTagChanges = tags && ((tags.add && tags.add.length > 0) || (tags.remove && tags.remove.length > 0));
    const hasCollectionChanges = collections && ((collections.add && collections.add.length > 0) || (collections.remove && collections.remove.length > 0));

    if (!hasTagChanges && !hasCollectionChanges) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'At least one tag or collection change must be specified',
            error_code: 'no_changes',
            preference: 'always_ask',
        };
    }

    // Validate all items exist and are in editable libraries
    // Also collect current state for undo
    const currentState: Record<string, { tags: string[]; collections: string[] }> = {};
    const searchableLibraryIds = store.get(searchableLibraryIdsAtom);

    for (const itemId of item_ids) {
        const parts = itemId.split('-');
        if (parts.length < 2) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: `Invalid item_id format: ${itemId}. Expected 'library_id-zotero_key'`,
                error_code: 'invalid_item_id',
                preference: 'always_ask',
            };
        }

        const libraryId = parseInt(parts[0], 10);
        const zoteroKey = parts.slice(1).join('-');

        // Validate library exists
        const library = Zotero.Libraries.get(libraryId);
        if (!library) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: `Library not found for item: ${itemId}`,
                error_code: 'library_not_found',
                preference: 'always_ask',
            };
        }

        // Validate library is searchable
        if (!searchableLibraryIds.includes(libraryId)) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: `Library '${library.name}' is not synced with Beaver`,
                error_code: 'library_not_searchable',
                preference: 'always_ask',
            };
        }

        // Validate library is editable
        if (!library.editable) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: `Library '${library.name}' is read-only`,
                error_code: 'library_not_editable',
                preference: 'always_ask',
            };
        }

        // Validate item exists
        const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, zoteroKey);
        if (!item) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: `Item not found: ${itemId}`,
                error_code: 'item_not_found',
                preference: 'always_ask',
            };
        }

        // Only regular items can be organized
        if (!item.isRegularItem()) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: `Only regular items can be organized. Item ${itemId} is not a regular item.`,
                error_code: 'item_type_not_supported',
                preference: 'always_ask',
            };
        }

        // Collect current state for undo
        const itemTags: string[] = item.getTags().map((t: { tag: string }) => t.tag);
        const itemCollections: string[] = item.getCollections().map((collectionId: number) => {
            const collection = Zotero.Collections.get(collectionId);
            return collection ? collection.key : null;
        }).filter(Boolean) as string[];

        currentState[itemId] = {
            tags: itemTags,
            collections: itemCollections,
        };
    }

    // Validate collection operations: all items must be in the same library
    if (hasCollectionChanges) {
        // Check that all items are in the same library
        const libraryIds = new Set<number>();
        for (const itemId of item_ids) {
            const parts = itemId.split('-');
            libraryIds.add(parseInt(parts[0], 10));
        }

        if (libraryIds.size > 1) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: 'Collection changes require all items to be in the same library. Items span multiple libraries.',
                error_code: 'mixed_libraries_for_collections',
                preference: 'always_ask',
            };
        }

        // Safe to use first value since we verified libraryIds.size >= 1 (from item_ids validation)
        const libraryId = [...libraryIds][0];

        // Validate collection keys exist (for add operations)
        if (collections?.add && collections.add.length > 0) {
            for (const collKey of collections.add) {
                const collection = await Zotero.Collections.getByLibraryAndKeyAsync(libraryId, collKey);
                if (!collection) {
                    return {
                        type: 'agent_action_validate_response',
                        request_id: request.request_id,
                        valid: false,
                        error: `Collection not found: ${collKey}. Use create_collection first.`,
                        error_code: 'collection_not_found',
                        preference: 'always_ask',
                    };
                }
            }
        }

        // Validate collection keys exist (for remove operations)
        if (collections?.remove && collections.remove.length > 0) {
            for (const collKey of collections.remove) {
                const collection = await Zotero.Collections.getByLibraryAndKeyAsync(libraryId, collKey);
                if (!collection) {
                    return {
                        type: 'agent_action_validate_response',
                        request_id: request.request_id,
                        valid: false,
                        error: `Collection not found: ${collKey}`,
                        error_code: 'collection_not_found',
                        preference: 'always_ask',
                    };
                }
            }
        }
    }

    // Get user preference
    const preference = getDeferredToolPreference('organize_items');

    return {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: true,
        current_value: currentState,
        preference,
    };
}

/**
 * Item data sent from backend for validation
 */
interface CreateItemValidationItem {
    source_id: string;
    title?: string;
    authors?: string[];
    year?: number;
    doi?: string;
    isbn?: string;
}

/**
 * Validate a create_item action.
 * Checks which items already exist in the library using batch reference checking.
 * Returns validation result with existing items info for partial processing.
 */
async function validateCreateItemAction(
    request: WSAgentActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    const { items, collections, tags } = request.action_data as {
        items: CreateItemValidationItem[];
        collections?: string[];
        tags?: string[];
    };

    // Validate at least one item is provided
    if (!items || items.length === 0) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'At least one item must be provided',
            error_code: 'no_items',
            preference: 'always_ask',
        };
    }

    // Get searchable library IDs - these are the libraries we can check for duplicates
    const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
    if (searchableLibraryIds.length === 0) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'No libraries are synced with Beaver',
            error_code: 'no_searchable_libraries',
            preference: 'always_ask',
        };
    }

    // Get the target library (user's main library by default)
    const targetLibraryId = Zotero.Libraries.userLibraryID;
    const targetLibrary = Zotero.Libraries.get(targetLibraryId);
    
    if (!targetLibrary || !targetLibrary.editable) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'Target library is not editable',
            error_code: 'library_not_editable',
            preference: 'always_ask',
        };
    }

    // Validate collections exist (if specified)
    const resolvedCollections: Array<{ key: string; name: string }> = [];
    if (collections && collections.length > 0) {
        for (const collectionKey of collections) {
            const collection = await Zotero.Collections.getByLibraryAndKeyAsync(targetLibraryId, collectionKey);
            if (!collection) {
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: `Collection not found: ${collectionKey}`,
                    error_code: 'collection_not_found',
                    preference: 'always_ask',
                };
            }
            resolvedCollections.push({
                key: collectionKey,
                name: collection.name,
            });
        }
    }

    // Check which items already exist in the library using batch reference checking
    const batchItems: BatchReferenceCheckItem[] = items.map(item => ({
        id: item.source_id,
        data: {
            title: item.title,
            date: item.year?.toString(),
            DOI: item.doi,
            ISBN: item.isbn,
            creators: item.authors,
        }
    }));

    let existingItems: string[] = [];
    try {
        const batchResults = await batchFindExistingReferences(batchItems, searchableLibraryIds);
        existingItems = batchResults
            .filter(result => result.item !== null)
            .map(result => result.id);
        
        logger(`validateCreateItemAction: Found ${existingItems.length}/${items.length} items already in library`, 1);
    } catch (error) {
        logger(`validateCreateItemAction: Batch reference check failed: ${error}`, 1);
        // Continue with empty existing items - let the frontend handle per-item checks
    }
    
    // Get user preference
    const preference = getDeferredToolPreference('create_item');

    return {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: true,
        current_value: {
            library_id: targetLibraryId,
            library_name: targetLibrary.name,
            items_count: items.length,
            existing_items: existingItems,
            resolved_collections: resolvedCollections,
            tags: tags || [],
        },
        preference,
    };
}
