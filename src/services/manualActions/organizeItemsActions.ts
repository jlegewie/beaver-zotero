import { formatCollectionId } from '../collections/collectionIdentity';
import { assertCollectionLibraryWritable, recheckCollection, recheckCollectionMemberships } from '../collections/collectionMutations';
/**
 * Utilities for executing and undoing organize_items agent actions.
 * These functions are used by AgentActionView for post-run action handling.
 */

import { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { logger } from '@beaver/agent-core/platform/logger';
import type { CollectionChanges, OrganizeItemsResultData, TagChanges } from '@beaver/agent-core/types/agentActions/base';
import { parseItemReference, resolveItemReference } from '../../utils/libraryIdentity';

/**
 * Execute an organize_items agent action.
 * Adds/removes tags and collection memberships for items.
 * @param action The agent action to execute
 * @returns Result data with changes applied
 */
export async function executeOrganizeItemsAction(
    action: AgentAction
): Promise<OrganizeItemsResultData> {
    const { item_ids, tags, collections: requestedCollections } = action.proposed_data as {
        item_ids: string[];
        tags?: TagChanges | null;
        collections?: CollectionChanges | null;
    };
    const collections = requestedCollections ? { ...requestedCollections } : requestedCollections;

    const hasCollections = !!(collections?.add?.length || collections?.remove?.length);
    const libraries = new Set<number>();
    for (const id of new Set(item_ids)) {
        const parsed = parseItemReference(id);
        if (!parsed) continue;
        const resolved = await resolveItemReference(parsed);
        if (resolved.status !== 'found') continue;
        assertCollectionLibraryWritable(resolved.item.libraryID);
        libraries.add(resolved.item.libraryID);
    }
    if (hasCollections && libraries.size > 1) throw new Error('Collection changes require one library.');
    for (const libraryID of libraries) {
        for (const op of ['add', 'remove'] as const) {
            const resolved = recheckCollectionMemberships(collections?.[op] ?? [], libraryID);
            if (collections?.[op]) collections[op] = resolved.map(entry => entry.key);
        }
    }
    const currentState: Record<string, { tags: string[]; collections: string[] }> = {};

    let itemsModified = 0;
    const failedItems: Record<string, string> = {};
    // Track actual changes (not just requested changes) for safe undo
    const actualTagsAdded = new Set<string>();
    const actualTagsRemoved = new Set<string>();
    const actualCollectionsAdded = new Set<string>();
    const actualCollectionsRemoved = new Set<string>();

    // Process each item
    for (const itemId of new Set(item_ids)) {
        try {
            // Accept both portable "<library_ref>-<key>" and legacy numeric ids.
            const parsed = parseItemReference(itemId);
            if (!parsed) {
                failedItems[itemId] = 'Invalid item id';
                continue;
            }
            const resolved = await resolveItemReference(parsed);
            if (resolved.status !== 'found') {
                failedItems[itemId] = 'Item not found';
                continue;
            }
            const item = resolved.item;
            assertCollectionLibraryWritable(item.libraryID);

            let modified = false;

            // Tags apply to any item type; collections only apply to top-level
            // items (annotations/attachments/notes inherit from their parent).
            const isTopLevel = item.isTopLevelItem();

            // Get current state before modifications
            const existingTags = new Set(item.getTags().map((t: { tag: string }) => t.tag));
            const existingCollections = isTopLevel
                ? new Set(item.getCollections().map((collectionId: number) => {
                    const collection = Zotero.Collections.get(collectionId);
                    return collection ? collection.key : null;
                }).filter(Boolean) as string[])
                : new Set<string>();

            currentState[itemId] = { tags: [...existingTags], collections: [...existingCollections] };

            // Add tags (only if not already present)
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

            // Add to collections (only top-level items; only if not already member)
            if (isTopLevel && collections?.add && collections.add.length > 0) {
                for (const collKey of collections.add) {
                    if (!existingCollections.has(collKey)) {
                        const collection = recheckCollection(collKey, item.libraryID).collection;
                        if (collection) {
                            item.addToCollection(collection.id);
                            actualCollectionsAdded.add(collKey);
                            modified = true;
                        }
                    }
                }
            }

            // Remove from collections (only top-level items; only if member)
            if (isTopLevel && collections?.remove && collections.remove.length > 0) {
                for (const collKey of collections.remove) {
                    if (existingCollections.has(collKey)) {
                        const collection = recheckCollection(collKey, item.libraryID).collection;
                        if (collection) {
                            item.removeFromCollection(collection.id);
                            actualCollectionsRemoved.add(collKey);
                            modified = true;
                        }
                    }
                }
            }

            // Save if modified
            if (modified) {
                await item.saveTx();
                itemsModified++;
            }
        } catch (error) {
            failedItems[itemId] = String(error);
        }
    }

    const hasFailures = Object.keys(failedItems).length > 0;

    if (hasFailures && itemsModified === 0) {
        throw new Error(`All items failed: ${Object.values(failedItems).join(', ')}`);
    }

    logger(`executeOrganizeItemsAction: Modified ${itemsModified} items, ${Object.keys(failedItems).length} failures`, 1);

    return {
        items_modified: itemsModified,
        current_state: currentState,
        // Store actual changes (not requested changes) for safe undo
        tags_added: actualTagsAdded.size > 0 ? [...actualTagsAdded] : undefined,
        tags_removed: actualTagsRemoved.size > 0 ? [...actualTagsRemoved] : undefined,
        collection_ids_added: [...libraries][0] != null ? [...actualCollectionsAdded].map(key => formatCollectionId([...libraries][0], key)) : undefined,
        collection_ids_removed: [...libraries][0] != null ? [...actualCollectionsRemoved].map(key => formatCollectionId([...libraries][0], key)) : undefined,
        collections_added: actualCollectionsAdded.size > 0 ? [...actualCollectionsAdded] : undefined,
        collections_removed: actualCollectionsRemoved.size > 0 ? [...actualCollectionsRemoved] : undefined,
        failed_items: hasFailures ? failedItems : undefined,
    };
}

/**
 * Undo an organize_items agent action.
 * Restores items to their original tags and collections using current_state.
 * @param action The agent action to undo (must have been applied)
 */
export async function undoOrganizeItemsAction(
    action: AgentAction
): Promise<void> {
    const { item_ids, tags, collections, current_state } = action.proposed_data as {
        item_ids: string[];
        tags?: TagChanges | null;
        collections?: CollectionChanges | null;
        current_state?: Record<string, { tags: string[]; collections: string[] }>;
    };

    // If we have current_state, use it for precise undo
    // Otherwise, reverse the changes that were applied
    const resultData = action.result_data as OrganizeItemsResultData | undefined;
    const failures: string[] = [];

    for (const itemId of new Set(item_ids)) {
        try {
            // Accept both portable "<library_ref>-<key>" and legacy numeric ids.
            const parsed = parseItemReference(itemId);
            if (!parsed) {
                logger(`undoOrganizeItemsAction: Invalid item id: ${itemId}`, 1);
                continue;
            }
            const resolved = await resolveItemReference(parsed);
            if (resolved.status !== 'found') {
                logger(`undoOrganizeItemsAction: Item not found: ${itemId}`, 1);
                continue;
            }
            const item = resolved.item;
            assertCollectionLibraryWritable(item.libraryID);

            let modified = false;

            if (resultData?.current_state?.[itemId] ?? current_state?.[itemId]) {
                // Precise undo using saved state
                const originalState = (resultData?.current_state?.[itemId] ?? current_state?.[itemId])!;
                
                // Resolve every membership before mutating the cached item.
                const addedCollections = (collections?.add ?? []).map(ref => recheckCollection(ref, item.libraryID));
                const removedCollections = (collections?.remove ?? []).map(ref => recheckCollection(ref, item.libraryID));

                // Restore tags: remove added tags, add back removed tags
                if (tags?.add) {
                    for (const tagName of tags.add) {
                        // Only remove if it wasn't in the original state
                        if (!originalState.tags.includes(tagName)) {
                            item.removeTag(tagName);
                            modified = true;
                        }
                    }
                }
                if (tags?.remove) {
                    for (const tagName of tags.remove) {
                        // Only add back if it was in the original state
                        if (originalState.tags.includes(tagName)) {
                            item.addTag(tagName);
                            modified = true;
                        }
                    }
                }

                // Restore collections
                for (const { key, collection } of addedCollections) {
                    if (!originalState.collections.includes(key)) {
                        item.removeFromCollection(collection.id);
                        modified = true;
                    }
                }
                for (const { key, collection } of removedCollections) {
                    if (originalState.collections.includes(key)) {
                        item.addToCollection(collection.id);
                        modified = true;
                    }
                }
            } else if (resultData) {
                // Fallback: reverse using result_data which contains actual changes made
                // This is safe because result_data now tracks actual changes, not requested changes
                const addedCollections = (resultData.collections_added ?? []).map(ref => recheckCollection(ref, item.libraryID));
                const removedCollections = (resultData.collections_removed ?? []).map(ref => recheckCollection(ref, item.libraryID));
                if (resultData.tags_added) {
                    for (const tagName of resultData.tags_added) {
                        item.removeTag(tagName);
                        modified = true;
                    }
                }
                if (resultData.tags_removed) {
                    for (const tagName of resultData.tags_removed) {
                        item.addTag(tagName);
                        modified = true;
                    }
                }
                for (const { collection } of addedCollections) {
                    item.removeFromCollection(collection.id);
                    modified = true;
                }
                for (const { collection } of removedCollections) {
                    item.addToCollection(collection.id);
                    modified = true;
                }
            } else {
                logger(`undoOrganizeItemsAction: No current_state or result_data for ${itemId}, skipping`, 1);
                continue;
            }

            if (modified) {
                await item.saveTx();
            }
        } catch (error) {
            failures.push(String(error));
            logger(`undoOrganizeItemsAction: Failed to undo ${itemId}: ${error}`, 1);
        }
    }

    logger(`undoOrganizeItemsAction: Restored ${item_ids.length} items`, 1);
    if (failures.length) throw new Error(failures.join('; '));
}
