import { WSAgentActionValidateRequest, WSAgentActionValidateResponse, WSAgentActionExecuteRequest, WSAgentActionExecuteResponse } from '../../agentProtocol';
import { store } from '../../../../react/store';
import { searchableLibraryIdsAtom } from '../../../../react/atoms/profile';
import { getDeferredToolPreference } from '../utils';
import { TimeoutContext, checkAborted } from '../timeout';
import { TimeoutError } from '../timeout';
import { logger } from '../../../utils/logger';


/**
 * Restore in-memory tags and collections on items after a transaction rollback.
 * The DB transaction rolls back automatically, but in-memory item objects still
 * carry the modifications — this restores them to prevent leaking into future saves.
 */
function restoreItemSnapshots(
    snapshots: Map<string, { item: any; tags: Array<{ tag: string; type?: number }>; collections: number[] }>,
): void {
    for (const [, snap] of snapshots) {
        try {
            snap.item.setTags(snap.tags);
            snap.item.setCollections(snap.collections);
        } catch (_) {
            // Best-effort restoration
        }
    }
}


/**
 * Validate an organize_items action.
 * Checks if items exist and are in editable libraries.
 * Returns current state of tags/collections for each item (for undo).
 */
export async function validateOrganizeItemsAction(
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
 * Execute an organize_items action.
 * Adds/removes tags and collection memberships for the specified items.
 * 
 * All modifications are batched in a single database transaction for performance.
 * This is an all-or-nothing operation: if any item fails to save, the entire
 * transaction rolls back. Items that don't exist are skipped (not an error).
 */
export async function executeOrganizeItemsAction(
    request: WSAgentActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const { item_ids, tags, collections } = request.action_data as {
        item_ids: string[];
        tags?: { add?: string[]; remove?: string[] } | null;
        collections?: { add?: string[]; remove?: string[] } | null;
    };

    let itemsModified = 0;
    const skippedItems: string[] = [];
    // Track actual changes (not just requested changes) for safe undo
    const actualTagsAdded = new Set<string>();
    const actualTagsRemoved = new Set<string>();
    const actualCollectionsAdded = new Set<string>();
    const actualCollectionsRemoved = new Set<string>();

    // Snapshot in-memory state for rollback after transaction failure.
    // The DB transaction rolls back automatically, but in-memory item objects
    // still carry the modifications — we must restore them explicitly.
    const itemSnapshots = new Map<string, {
        item: any;
        tags: Array<{ tag: string; type?: number }>;
        collections: number[];
    }>();

    try {
        // Checkpoint: abort before starting the transaction
        checkAborted(ctx, 'organize_items:before_transaction');

        // Batch all modifications in a single transaction for performance.
        // If any save fails (including TimeoutError), the entire transaction rolls back.
        await Zotero.DB.executeTransaction(async () => {
            for (const itemId of item_ids) {
                const parts = itemId.split('-');
                const libraryId = parseInt(parts[0], 10);
                const zoteroKey = parts.slice(1).join('-');

                const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, zoteroKey);
                if (!item) {
                    // Item not found - skip but don't fail the transaction
                    skippedItems.push(itemId);
                    continue;
                }

                // Skip annotations — they don't support tags or collections
                if (item.isAnnotation()) {
                    skippedItems.push(itemId);
                    continue;
                }

                const isTopLevel = item.isTopLevelItem();
                let modified = false;

                // Snapshot in-memory state before modifications for rollback
                const originalTags = item.getTags();
                const originalCollections = isTopLevel ? item.getCollections() : [];
                itemSnapshots.set(itemId, { item, tags: originalTags, collections: originalCollections });

                // Get current state for change detection
                const existingTags = new Set(originalTags.map((t: { tag: string }) => t.tag));
                const existingCollections = isTopLevel
                    ? new Set(originalCollections.map((collectionId: number) => {
                        const collection = Zotero.Collections.get(collectionId);
                        return collection ? collection.key : null;
                    }).filter(Boolean) as string[])
                    : new Set<string>();

                // Add tags (only if not already present)
                // Tags work on regular items, attachments, and notes
                if (tags?.add && tags.add.length > 0) {
                    for (const tagName of tags.add) {
                        if (!existingTags.has(tagName)) {
                            item.addTag(tagName);
                            actualTagsAdded.add(tagName);
                            modified = true;
                        }
                    }
                }

                // Remove tags (only if present)
                if (tags?.remove && tags.remove.length > 0) {
                    for (const tagName of tags.remove) {
                        if (existingTags.has(tagName) && item.removeTag(tagName)) {
                            actualTagsRemoved.add(tagName);
                            modified = true;
                        }
                    }
                }

                // Add to collections (only for top-level items)
                if (isTopLevel && collections?.add && collections.add.length > 0) {
                    for (const collKey of collections.add) {
                        if (!existingCollections.has(collKey)) {
                            const collection = await Zotero.Collections.getByLibraryAndKeyAsync(libraryId, collKey);
                            if (collection) {
                                item.addToCollection(collection.id);
                                actualCollectionsAdded.add(collKey);
                                modified = true;
                            }
                        }
                    }
                }

                // Remove from collections (only for top-level items)
                if (isTopLevel && collections?.remove && collections.remove.length > 0) {
                    for (const collKey of collections.remove) {
                        if (existingCollections.has(collKey)) {
                            const collection = await Zotero.Collections.getByLibraryAndKeyAsync(libraryId, collKey);
                            if (collection) {
                                item.removeFromCollection(collection.id);
                                actualCollectionsRemoved.add(collKey);
                                modified = true;
                            }
                        }
                    }
                }

                // Checkpoint: abort before each item save — throws inside
                // executeTransaction triggers full rollback
                if (modified) {
                    checkAborted(ctx, 'organize_items:before_item_save');
                    await item.save();
                    itemsModified++;
                }
            }
        });
    } catch (error) {
        // Restore in-memory state for all snapshotted items.
        // The DB transaction rolled back, but in-memory item objects still
        // carry the modifications — restore them to prevent leaking into future saves.
        restoreItemSnapshots(itemSnapshots);

        // Re-throw TimeoutError so it propagates to the main handler
        if (error instanceof TimeoutError) throw error;
        // Transaction failed and rolled back - no items were modified
        logger(`executeOrganizeItemsAction: Transaction failed: ${error}`, 1);
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: `Failed to organize items: ${error}`,
            error_code: 'transaction_failed',
        };
    }

    logger(`executeOrganizeItemsAction: Modified ${itemsModified} items, skipped ${skippedItems.length}`, 1);

    return {
        type: 'agent_action_execute_response',
        request_id: request.request_id,
        success: true,
        result_data: {
            items_modified: itemsModified,
            // Store actual changes (not requested changes) for safe undo
            tags_added: actualTagsAdded.size > 0 ? [...actualTagsAdded] : undefined,
            tags_removed: actualTagsRemoved.size > 0 ? [...actualTagsRemoved] : undefined,
            collections_added: actualCollectionsAdded.size > 0 ? [...actualCollectionsAdded] : undefined,
            collections_removed: actualCollectionsRemoved.size > 0 ? [...actualCollectionsRemoved] : undefined,
            skipped_items: skippedItems.length > 0 ? skippedItems : undefined,
        },
    };
}
