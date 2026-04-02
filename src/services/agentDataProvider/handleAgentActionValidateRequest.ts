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

        // Tags: allowed on regular items, attachments, and notes (mainly excludes annotations)
        if (hasTagChanges && !item.isRegularItem() && !item.isAttachment() && !item.isNote()) {
            const itemType = Zotero.ItemTypes.getName(item.itemTypeID);
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: `Item '${itemId}' is an ${itemType}. Tags can only be added to or removed from regular items, attachments, and notes. Use the parent attachment or top-level item instead.`,
                error_code: 'item_type_not_supported',
                preference: 'always_ask',
            };
        }

        // Collection: allowed on regular items, attachments, and notes (mainly excludes annotations)
        if (hasCollectionChanges && !item.isRegularItem() && !item.isAttachment() && !item.isNote()) {
            const itemType = Zotero.ItemTypes.getName(item.itemTypeID);
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: `Item '${itemId}' is an ${itemType}. Collections can only be added to or removed from top-level regular items, attachments or notes. Use the parent item instead.`,
                error_code: 'item_type_not_supported',
                preference: 'always_ask',
            };
        }

        // Collection changes: only allowed on top-level items
        if (hasCollectionChanges && !item.isTopLevelItem()) {
            const itemType = Zotero.ItemTypes.getName(item.itemTypeID);
            const parentKey = item.parentKey;
            const parentId = `${libraryId}-${parentKey}`;
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: `Item '${itemId}' is a child ${itemType} and cannot be added to or removed from collections directly. Only top-level items can be added or removed from collections. Use the parent item '${parentId}' instead.`,
                error_code: 'item_not_top_level',
                preference: 'always_ask',
            };
        }

        // Collect current state for undo
        const itemTags: string[] = item.getTags().map((t: { tag: string }) => t.tag);
        const itemCollections: string[] = item.isTopLevelItem()
            ? item.getCollections().map((collectionId: number) => {
                const collection = Zotero.Collections.get(collectionId);
                return collection ? collection.key : null;
            }).filter(Boolean) as string[]
            : [];

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
