/**
 * Utilities for executing and undoing create_collection agent actions.
 * These functions are used by AgentActionView for post-run action handling.
 */

import { AgentAction } from '../agents/agentActions';
import { CreateCollectionResultData } from '../types/agentActions/base';
import { logger } from '../../src/utils/logger';
import { libraryRefForLibraryID, resolveLibraryRef, resolveWriteTargetLibrary } from '../../src/utils/libraryIdentity';

/**
 * Execute a create_collection agent action by creating the collection in Zotero.
 * @param action The agent action to execute
 * @returns Result data including the created collection's key and ID
 */
export async function executeCreateCollectionAction(
    action: AgentAction
): Promise<CreateCollectionResultData> {
    const { library_id: rawLibraryId, library_ref, library_name, name, parent_key, item_ids } = action.proposed_data as {
        library_id?: number | null;
        library_ref?: string | null;
        library_name?: string | null;
        name: string;
        parent_key?: string | null;
        item_ids?: string[];
    };

    const targetLibrary = resolveWriteTargetLibrary({ library_ref, library_id: rawLibraryId, library_name });
    if (!targetLibrary.ok) throw new Error(targetLibrary.message);
    const library_id = targetLibrary.libraryID;

    // Build collection params
    const collectionParams: { name: string; libraryID: number; parentID?: number } = {
        name,
        libraryID: library_id,
    };

    // Set parent if provided
    if (parent_key) {
        const parentCollection = await Zotero.Collections.getByLibraryAndKeyAsync(library_id, parent_key);
        if (parentCollection) {
            collectionParams.parentID = parentCollection.id;
        } else {
            throw new Error(`Parent collection not found: ${parent_key}`);
        }
    }

    // Create the collection
    const collection = new Zotero.Collection(collectionParams);

    // Save the collection
    const collectionID = await collection.saveTx();
    logger(`executeCreateCollectionAction: Created collection "${name}" with ID ${collectionID}`, 1);

    let itemsAdded = 0;

    // Add items to the collection if specified
    if (item_ids && item_ids.length > 0) {
        await Zotero.DB.executeTransaction(async () => {
            const itemIdsToAdd: number[] = [];
            
            for (const itemIdStr of item_ids) {
                const [libId, key] = itemIdStr.split('-');
                const item = await Zotero.Items.getByLibraryAndKeyAsync(parseInt(libId, 10), key);
                if (item && !item.isAttachment() && !item.isNote() && !item.isAnnotation()) {
                    itemIdsToAdd.push(item.id);
                }
            }

            if (itemIdsToAdd.length > 0) {
                await collection.addItems(itemIdsToAdd);
                itemsAdded = itemIdsToAdd.length;
                logger(`executeCreateCollectionAction: Added ${itemsAdded} items to collection`, 1);
            }
        });
    }

    return {
        library_id,
        library_ref: libraryRefForLibraryID(library_id) ?? undefined,
        collection_key: collection.key,
        items_added: itemsAdded,
    };
}

/**
 * Undo a create_collection agent action by deleting the created collection.
 *
 * Refuses when the collection has subcollections. Zotero's
 * `collection.eraseTx()` cascades through all descendant collections (see
 * `Zotero.Collection.prototype._eraseData`), so erasing a collection that
 * later had other collections moved into it would also destroy those and
 * anything under them. Mirrors the existing subcollection guard in
 * `executeManageCollectionsAction` (manageCollectionsActions.ts).
 *
 * @param action The agent action to undo (must have been applied)
 */
export async function undoCreateCollectionAction(
    action: AgentAction
): Promise<void> {
    const resultData = action.result_data as CreateCollectionResultData | undefined;

    if (!resultData?.collection_key || !resultData?.library_id) {
        throw new Error('No result data available for undo - collection was not created');
    }

    // Get the collection
    const libraryID = resolveLibraryRef({ library_ref: resultData.library_ref, library_id: resultData.library_id });
    if (!libraryID) {
        logger(`undoCreateCollectionAction: Library unavailable for ${resultData.library_ref || resultData.library_id}-${resultData.collection_key}`, 1);
        return;
    }

    const collection = await Zotero.Collections.getByLibraryAndKeyAsync(
        libraryID,
        resultData.collection_key
    );

    if (!collection) {
        // Collection may have already been deleted manually
        logger(`undoCreateCollectionAction: Collection ${resultData.library_id}-${resultData.collection_key} not found, may have been deleted`, 1);
        return;
    }

    // Refuse if subcollections were moved in after creation — eraseTx would
    // cascade-delete them. Items are fine (eraseTx detaches, doesn't delete).
    if (collection.hasChildCollections(false)) {
        throw new Error('Collection contains subcollections.');
    }

    // Erase the collection (this will NOT delete items in the collection, just remove them from it)
    await collection.eraseTx();
    logger(`undoCreateCollectionAction: Deleted collection "${collection.name}" (${resultData.library_id}-${resultData.collection_key})`, 1);
}
