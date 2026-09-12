import { logger } from '@beaver/agent-core/platform/logger';
import { isAttachmentOnServer } from './webAPI';
import { safeFileExists, safeIsInTrash } from './zoteroUtils';
const isSupportedItem = (item: Zotero.Item) => item.isRegularItem() || item.isPDFAttachment();
export const syncingItemFilter = (item: Zotero.Item | false, collectionIds?: number[]) => {
    if (!item) return false;
    if (!isSupportedItem(item)) return false;
    const trashState = safeIsInTrash(item);
    if (trashState === null) {
        logger(
            `syncingItemFilter: Item missing isInTrash, skipping. id=${item?.id ?? "unknown"} key=${item?.key ?? "unknown"} library=${item?.libraryID ?? "unknown"} type=${item?.itemType ?? "unknown"}`,
            2
        );
        return false;
    }
    if (trashState) return false;
    if (collectionIds) {
        const itemCollections = new Set(item.getCollections());
        return collectionIds.some(id => itemCollections.has(id));
    }
    return true;
};

/**
 * Comprehensive filter function for syncing items based on item type, trash status and file availability
 * 
 * This filter checks for item type, trash status and file availability.
 * It servers as a comprehensive filter for what actually gets synced.
 * 
 * @param item Zotero item
 * @returns Promise resolving to true if the item should be synced
 */
export const syncingItemFilterAsync = async (item: Zotero.Item | false, collectionIds?: number[]): Promise<boolean> => {
    if (!item) return false;
    if (!syncingItemFilter(item, collectionIds)) return false;
    if (item.isRegularItem()) return true;
    if (item.isAttachment()) {
        // Item is available locally or on server
        return isAttachmentOnServer(item) || await safeFileExists(item);
    }
    return false;
};



export async function wasItemAddedBeforeLastSync(item: Zotero.Item, syncWithZotero: boolean, userID: string): Promise<boolean> {
    let syncLog = null;
    if (syncWithZotero) {
        syncLog = await Zotero.Beaver.db.getSyncLogWithHighestVersion(userID, item.libraryID);
    } else {
        syncLog = await Zotero.Beaver.db.getSyncLogWithMostRecentDate(userID, item.libraryID);
    }

    if (!syncLog) {
        return false;
    }

    const lastSyncDate = syncLog.library_date_modified;
    const itemDateAdded = item.dateAdded;
    const lastSyncDateSQL = Zotero.Date.isISODate(lastSyncDate) 
        ? Zotero.Date.isoToSQL(lastSyncDate) 
        : lastSyncDate;
    
    // Item was added before the last sync
    return itemDateAdded <= lastSyncDateSQL;
}
