import { logger } from '../../utils/logger';
import { store } from '../../../react/store';
import { searchableLibraryIdsAtom } from '../../../react/atoms/profile';
import { batchFindExistingReferences, BatchReferenceCheckItem } from '../../../react/utils/batchFindExistingReferences';
import {
    WSAgentActionValidateRequest,
    WSAgentActionValidateResponse,
} from '../agentProtocol';
import { getDeferredToolPreference } from './utils';
import { validateEditNoteAction } from './actions/editNote';
import { validateEditMetadataAction } from './actions/editMetadata';
import { validateOrganizeItemsAction } from './actions/organizeItems';
import { validateCreateNoteAction } from './actions/createNote';


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

        if (request.action_type === 'edit_note') {
            return await validateEditNoteAction(request);
        }

        if (request.action_type === 'create_note') {
            return await validateCreateNoteAction(request);
        }

        // Unsupported action type.
        // Note: confirm_extraction approvals are backend-managed and intentionally
        // not validated through this local deferred-tool preference flow.
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
 * Validate a create_collection action.
 * Checks if the library exists and is editable.
 */
async function validateCreateCollectionAction(
    request: WSAgentActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    const { library_id: rawLibraryId, library_name, name, parent_key, item_ids } = request.action_data as {
        library_id?: number | null;
        library_name?: string | null;
        name: string;
        parent_key?: string | null;
        item_ids?: string[];
    };

    // Resolve target library: use provided ID, resolve name, or default to user's main library
    let library_id: number;

    if (rawLibraryId == null || rawLibraryId === 0) {
        // Not provided or normalized to 0 — try library_name, then default
        if (library_name) {
            const allLibraries = Zotero.Libraries.getAll();
            const matchedLibrary = allLibraries.find(
                (lib) => lib.name.toLowerCase() === library_name.toLowerCase()
            );
            if (!matchedLibrary) {
                const availableNames = allLibraries.map((lib) => lib.name).join(', ');
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: `Library not found: "${library_name}". Omit the library parameter to use the default library. Available libraries: ${availableNames}`,
                    error_code: 'library_not_found',
                    preference: 'always_ask',
                };
            }
            library_id = matchedLibrary.libraryID;
        } else {
            library_id = Zotero.Libraries.userLibraryID;
        }
    } else if (typeof rawLibraryId === 'number' && rawLibraryId > 0) {
        library_id = rawLibraryId;
    } else {
        // Explicitly provided but invalid (negative, NaN, fractional, etc.)
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Invalid library ID: ${rawLibraryId}`,
            error_code: 'library_not_found',
            preference: 'always_ask',
        };
    }

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
    const { library_id: rawLibraryId, library_name, items, collections, tags } = request.action_data as {
        library_id?: number | null;
        library_name?: string | null;
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

    // Resolve target library: use provided ID, resolve name, or default to user's main library
    let targetLibraryId: number;

    if (rawLibraryId == null || rawLibraryId === 0) {
        // Not provided or normalized to 0 — try library_name, then default
        if (library_name) {
            const allLibraries = Zotero.Libraries.getAll();
            const matchedLibrary = allLibraries.find(
                (lib) => lib.name.toLowerCase() === library_name.toLowerCase()
            );
            if (!matchedLibrary) {
                const availableNames = allLibraries.map((lib) => lib.name).join(', ');
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: `Library not found: "${library_name}". Omit the library parameter to use the default library. Available libraries: ${availableNames}`,
                    error_code: 'library_not_found',
                    preference: 'always_ask',
                };
            }
            targetLibraryId = matchedLibrary.libraryID;
        } else {
            targetLibraryId = Zotero.Libraries.userLibraryID;
        }
    } else if (typeof rawLibraryId === 'number' && rawLibraryId > 0) {
        targetLibraryId = rawLibraryId;
    } else {
        // Explicitly provided but invalid (negative, NaN, fractional, etc.)
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Invalid library ID: ${rawLibraryId}`,
            error_code: 'library_not_found',
            preference: 'always_ask',
        };
    }

    // Validate library exists
    const targetLibrary = Zotero.Libraries.get(targetLibraryId);
    if (!targetLibrary) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library not found: ${targetLibraryId}. Omit the library parameter to use the default library.`,
            error_code: 'library_not_found',
            preference: 'always_ask',
        };
    }

    // Validate library is searchable (synced with Beaver)
    if (!searchableLibraryIds.includes(targetLibraryId)) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library "${targetLibrary.name}" is not synced with Beaver.`,
            error_code: 'library_not_searchable',
            preference: 'always_ask',
        };
    }
    
    // Validate library is editable
    if (!targetLibrary.editable) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library "${targetLibrary.name}" is read-only and cannot be modified. Omit the library parameter to use the default library.`,
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

    // Map from source_id to Zotero item_id (format: "library_id-zotero_key")
    const existingItems: Record<string, string> = {};
    try {
        const batchOutput = await batchFindExistingReferences(batchItems, [targetLibraryId]);
        for (const result of batchOutput.results) {
            if (result.item !== null) {
                existingItems[result.id] = `${result.item.library_id}-${result.item.zotero_key}`;
            }
        }

        logger(`validateCreateItemAction: Found ${Object.keys(existingItems).length}/${items.length} items already in target library (${batchOutput.timing.total_ms}ms)`, 1);
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
