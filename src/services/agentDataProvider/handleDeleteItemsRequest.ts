import { logger } from '../../utils/logger';


/**
 * Request to delete (trash) items in Zotero.
 * Used for test cleanup.
 */
interface DeleteItemsRequest {
    item_ids: string[];  // Format: "libraryID-key"
}

interface DeleteItemsResponse {
    success: boolean;
    deleted: number;
    failed: string[];
}


/**
 * Handle delete-items request.
 * Moves items to Zotero's trash. Primarily used for test cleanup.
 *
 * Each item is trashed individually so that failures on one item
 * don't prevent others from being cleaned up.
 */
export async function handleDeleteItemsRequest(
    request: DeleteItemsRequest
): Promise<DeleteItemsResponse> {
    const { item_ids } = request;

    if (!item_ids || item_ids.length === 0) {
        return { success: true, deleted: 0, failed: [] };
    }

    logger(`handleDeleteItemsRequest: Trashing ${item_ids.length} items`, 1);

    const failed: string[] = [];
    let deleted = 0;

    for (const itemId of item_ids) {
        try {
            const parts = itemId.split('-');
            const libraryId = parseInt(parts[0], 10);
            const key = parts.slice(1).join('-');

            const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, key);
            if (item) {
                item.deleted = true;
                await item.saveTx();
                deleted++;
            } else {
                failed.push(`${itemId}: not found`);
            }
        } catch (error) {
            failed.push(`${itemId}: ${error}`);
        }
    }

    logger(`handleDeleteItemsRequest: Trashed ${deleted} items, ${failed.length} failed`, 1);

    return {
        success: failed.length === 0,
        deleted,
        failed,
    };
}
