/**
 * Utilities for executing and undoing organize_items agent actions.
 * These functions are used by AgentActionView for post-run action handling.
 */

import { AgentAction } from '../agents/agentActions';
import type { OrganizeItemsResultData, TagChanges, CollectionChanges } from '../types/agentActions/base';
import { logger } from '../../src/utils/logger';

/**
 * Execute an organize_items agent action.
 * Adds/removes tags and collection memberships for items.
 * @param action The agent action to execute
 * @returns Result data with changes applied
 */
export async function executeOrganizeItemsAction(
    action: AgentAction
): Promise<OrganizeItemsResultData> {
    const { item_ids, tags, collections } = action.proposed_data as {
        item_ids: string[];
        tags?: TagChanges | null;
        collections?: CollectionChanges | null;
    };

    let itemsModified = 0;
    const failedItems: Record<string, string> = {};
    const tagsAdded: string[] = tags?.add || [];
    const tagsRemoved: string[] = tags?.remove || [];
    const collectionsAdded: string[] = collections?.add || [];
    const collectionsRemoved: string[] = collections?.remove || [];

    // Process each item
    for (const itemId of item_ids) {
        try {
            const parts = itemId.split('-');
            const libraryId = parseInt(parts[0], 10);
            const zoteroKey = parts.slice(1).join('-');

            const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, zoteroKey);
            if (!item) {
                failedItems[itemId] = 'Item not found';
                continue;
            }

            let modified = false;

            // Add tags
            if (tags?.add && tags.add.length > 0) {
                for (const tagName of tags.add) {
                    item.addTag(tagName);
                    modified = true;
                }
            }

            // Remove tags
            if (tags?.remove && tags.remove.length > 0) {
                for (const tagName of tags.remove) {
                    if (item.removeTag(tagName)) {
                        modified = true;
                    }
                }
            }

            // Add to collections
            if (collections?.add && collections.add.length > 0) {
                for (const collKey of collections.add) {
                    const collection = await Zotero.Collections.getByLibraryAndKeyAsync(libraryId, collKey);
                    if (collection) {
                        item.addToCollection(collection.id);
                        modified = true;
                    }
                }
            }

            // Remove from collections
            if (collections?.remove && collections.remove.length > 0) {
                for (const collKey of collections.remove) {
                    const collection = await Zotero.Collections.getByLibraryAndKeyAsync(libraryId, collKey);
                    if (collection) {
                        item.removeFromCollection(collection.id);
                        modified = true;
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
        tags_added: tagsAdded.length > 0 ? tagsAdded : undefined,
        tags_removed: tagsRemoved.length > 0 ? tagsRemoved : undefined,
        collections_added: collectionsAdded.length > 0 ? collectionsAdded : undefined,
        collections_removed: collectionsRemoved.length > 0 ? collectionsRemoved : undefined,
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

    for (const itemId of item_ids) {
        try {
            const parts = itemId.split('-');
            const libraryId = parseInt(parts[0], 10);
            const zoteroKey = parts.slice(1).join('-');

            const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, zoteroKey);
            if (!item) {
                logger(`undoOrganizeItemsAction: Item not found: ${itemId}`, 1);
                continue;
            }

            let modified = false;

            if (current_state && current_state[itemId]) {
                // Precise undo using saved state
                const originalState = current_state[itemId];
                
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
                if (collections?.add) {
                    for (const collKey of collections.add) {
                        // Only remove if it wasn't in the original state
                        if (!originalState.collections.includes(collKey)) {
                            const collection = await Zotero.Collections.getByLibraryAndKeyAsync(libraryId, collKey);
                            if (collection) {
                                item.removeFromCollection(collection.id);
                                modified = true;
                            }
                        }
                    }
                }
                if (collections?.remove) {
                    for (const collKey of collections.remove) {
                        // Only add back if it was in the original state
                        if (originalState.collections.includes(collKey)) {
                            const collection = await Zotero.Collections.getByLibraryAndKeyAsync(libraryId, collKey);
                            if (collection) {
                                item.addToCollection(collection.id);
                                modified = true;
                            }
                        }
                    }
                }
            } else {
                // Simple reverse: remove what was added, add back what was removed
                if (resultData?.tags_added) {
                    for (const tagName of resultData.tags_added) {
                        item.removeTag(tagName);
                        modified = true;
                    }
                }
                if (resultData?.tags_removed) {
                    for (const tagName of resultData.tags_removed) {
                        item.addTag(tagName);
                        modified = true;
                    }
                }
                if (resultData?.collections_added) {
                    for (const collKey of resultData.collections_added) {
                        const collection = await Zotero.Collections.getByLibraryAndKeyAsync(libraryId, collKey);
                        if (collection) {
                            item.removeFromCollection(collection.id);
                            modified = true;
                        }
                    }
                }
                if (resultData?.collections_removed) {
                    for (const collKey of resultData.collections_removed) {
                        const collection = await Zotero.Collections.getByLibraryAndKeyAsync(libraryId, collKey);
                        if (collection) {
                            item.addToCollection(collection.id);
                            modified = true;
                        }
                    }
                }
            }

            if (modified) {
                await item.saveTx();
            }
        } catch (error) {
            logger(`undoOrganizeItemsAction: Failed to undo ${itemId}: ${error}`, 1);
        }
    }

    logger(`undoOrganizeItemsAction: Restored ${item_ids.length} items`, 1);
}
