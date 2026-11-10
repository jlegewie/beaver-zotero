/**
 * Utilities for executing and undoing organize_items agent actions.
 * These functions are used by AgentActionView for post-run action handling.
 */
import { assertLibraryWritable, recheckCollectionForUndo } from '../collections/collectionMutations';
import { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { logger } from '@beaver/agent-core/platform/logger';
import type { CollectionChanges, OrganizeItemsResultData, TagChanges } from '@beaver/agent-core/types/agentActions/base';
import { parseItemReference, resolveItemReference } from '../../utils/libraryIdentity';
import { unboundedExecutionContext } from '../agentDataProvider/actions/actionExecution';
import { applyOrganizeItems } from '../agentDataProvider/actions/organizeItems';

/**
 * Apply a stored organize_items action through the shared executor
 * (`applyOrganizeItems`): one transaction, all or nothing.
 *
 * There is no drift check: memberships are not a baseline, and the executor
 * records each item's tags and collections right before the write, which is
 * what undo restores.
 */
export async function executeOrganizeItemsAction(
    action: AgentAction
): Promise<OrganizeItemsResultData> {
    return applyOrganizeItems(action.proposed_data, unboundedExecutionContext());
}

/** Recorded memberships whose collection still exists; the rest are nothing to undo. */
function resolveForUndo(references: readonly string[] | null | undefined, libraryID: number) {
    return (references ?? [])
        .map(reference => recheckCollectionForUndo(reference, libraryID))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
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
            assertLibraryWritable(item.libraryID, { requirePortable: false });

            let modified = false;

            const originalState = resultData?.current_state?.[itemId] ?? current_state?.[itemId];
            if (originalState) {
                // Precise undo using saved state
                
                // Resolve every membership before mutating the cached item. A
                // collection the user has since erased holds no membership to
                // restore, so it is skipped rather than failing the undo.
                const addedCollections = resolveForUndo(collections?.add, item.libraryID);
                const removedCollections = resolveForUndo(collections?.remove, item.libraryID);

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
                const addedCollections = resolveForUndo(resultData.collections_added, item.libraryID);
                const removedCollections = resolveForUndo(resultData.collections_removed, item.libraryID);
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
    // One cause (an inaccessible library, say) fails every item; report it once.
    if (failures.length) throw new Error([...new Set(failures)].join('; '));
}
