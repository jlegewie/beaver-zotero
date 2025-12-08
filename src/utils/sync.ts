import { syncService, DeleteLibraryTask } from '../services/syncService';
import { fileUploader } from '../services/FileUploader';
import { logger } from './logger';
import { userIdAtom } from "../../react/atoms/auth";
import { store } from "../../react/store";
import { syncStatusAtom, LibrarySyncStatus, SyncStatus, SyncType } from '../../react/atoms/sync';
import { ItemData, DeleteData, AttachmentDataWithMimeType, ZoteroItemReference, ZoteroCollection } from '../../react/types/zotero';
import { isLibrarySynced, getClientDateModifiedAsISOString, getZoteroUserIdentifier, getCollectionClientDateModifiedAsISOString } from './zoteroUtils';
import { v4 as uuidv4 } from 'uuid';
import { addPopupMessageAtom } from '../../react/utils/popupMessageUtils';
import { syncWithZoteroAtom } from '../../react/atoms/profile';
import { SyncMethod } from '../../react/atoms/sync';
import { SyncLogsRecord } from '../services/database';
import { isAttachmentOnServer, getFileHashes } from './webAPI';
import { getServerOnlyAttachmentCount } from './libraries';
import { skippedItemsManager } from '../services/skippedItemsManager';
import { serializeCollection, serializeItem, serializeAttachment, NEEDS_HASH } from './zoteroSerializers';
import { safeIsInTrash } from './zoteroUtils';


const MAX_SERVER_FILES = 100;


/**
 * Checks if a library is valid for sync
 * @param library Zotero library
 * @param useZoteroSync Whether to use Zotero sync
 * @returns True if the library is valid for sync
 */
export const isLibraryValidForSync = (
    library: Zotero.Library | { isGroup: boolean, libraryID: number } | undefined | null | false,
    useZoteroSync: boolean
): boolean => {
    if (!library) return false;
    return !library.isGroup || (library.isGroup && useZoteroSync && isLibrarySynced(library.libraryID));
};

/**
 * Checks if a library is valid for sync with a server check
 * @param library Zotero library
 * @param useZoteroSync Whether to use Zotero sync
 * @param maxServerFiles Maximum number of server files allowed
 * @returns True if the library is valid for sync with a server check
 */
export const isLibraryValidForSyncWithServerCheck = async (
    library: Zotero.Library | { isGroup: boolean, libraryID: number } | undefined | null | false,
    useZoteroSync: boolean,
    maxServerFiles: number = MAX_SERVER_FILES
): Promise<boolean> => {
    // Basic validation first
    if (!isLibraryValidForSync(library, useZoteroSync)) {
        return false;
    }
    
    // Additional server-only attachment check
    if (library && 'libraryID' in library) {
        const serverOnlyCount = await getServerOnlyAttachmentCount(library.libraryID);
        if (serverOnlyCount > maxServerFiles) {
            return false;
        }
    }
    
    return true;
};

/**
 * Interface for item filter function
 */
export type ItemFilterFunction = (item: Zotero.Item | false, collectionIds?: number[]) => boolean;

/**
 * Filter function for supported items
 * @param item Zotero item
 * @returns true if the item is supported
 */
export const isSupportedItem = (item: Zotero.Item | false) => {
    if (!item) return false;
    if (item.isRegularItem()) return true;
    // if (item.isPDFAttachment() || item.isImageAttachment()) return true;
    if (item.isPDFAttachment()) return true;
    return false;
};

/**
 * Filter function for syncing items based on item type and trash status
 * 
 * This filter only checks for item type and trash status.
 * It servers as a fast, first pass filter.
 * 
 * @param item Zotero item
 * @returns true if the item should be synced
 */
export const syncingItemFilter: ItemFilterFunction = (item: Zotero.Item | false, collectionIds?: number[]) => {
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
        return isAttachmentOnServer(item) || await item.fileExists();
    }
    return false;
};


export async function extractDeleteData(item: Zotero.Item): Promise<DeleteData> {
    return {
        library_id: item.libraryID,
        zotero_key: item.key,
        zotero_version: item.version,
        zotero_synced: item.synced,
        date_modified: await getClientDateModifiedAsISOString(item)
    };
}

/**
 * Extracts delete data from a Zotero collection
 * @param collection Zotero collection
 * @returns Promise resolving to DeleteData object
 */
export async function extractCollectionDeleteData(collection: Zotero.Collection): Promise<DeleteData> {
    return {
        library_id: collection.libraryID,
        zotero_key: collection.key,
        zotero_version: collection.version,
        zotero_synced: collection.synced,
        date_modified: await getCollectionClientDateModifiedAsISOString(collection.id)
    };
}

function createBatches<T>(
    items: T[], 
    batchSize: number, 
    getDateModified: (item: T) => string
): T[][] {
    if (items.length === 0) return [];
    
    const batches: T[][] = [];
    let currentBatch: T[] = [];
    let currentBatchDate: string | null = null;
    
    for (const item of items) {
        const itemDate = getDateModified(item);
        
        // If batch is empty, start new batch
        if (currentBatch.length === 0) {
            currentBatch.push(item);
            currentBatchDate = itemDate;
            continue;
        }
        
        // If same date as current batch, add to current batch (even if over size)
        if (itemDate === currentBatchDate) {
            currentBatch.push(item);
            continue;
        }
        
        // Different date - check if we need to start new batch
        if (currentBatch.length >= batchSize) {
            // Current batch is full, start new one
            batches.push(currentBatch);
            currentBatch = [item];
            currentBatchDate = itemDate;
        } else {
            // Current batch has room, add item
            currentBatch.push(item);
            currentBatchDate = itemDate;
        }
    }
    
    // Add final batch if not empty
    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }
    
    return batches;
}

export interface SyncItem {
    action: 'upsert' | 'delete';
    item: Zotero.Item;
}

export interface SyncCollection {
    action: 'upsert' | 'delete';
    collection: Zotero.Collection;
}

/**
 * Lightweight metadata for sorting and batching items without loading full item data.
 * This allows efficient processing of large libraries.
 */
export interface ItemSyncMetadata {
    itemId: number;
    version: number;
    clientDateModified: string;
}

/**
 * Lightweight metadata for sorting and batching collections.
 */
export interface CollectionSyncMetadata {
    collectionId: number;
    version: number;
    clientDateModified: string;
    deleted: boolean;
}

/**
 * Syncs items and collections to the backend using per-batch loading.
 * Items are loaded, filtered, and serialized per batch to avoid memory issues with large libraries.
 * 
 * @param syncSessionId Sync session ID
 * @param libraryID Zotero library ID
 * @param itemMetadata Lightweight metadata for items (IDs, versions, dates)
 * @param collectionMetadata Lightweight metadata for collections
 * @param isInitialSync Whether this is an initial sync (affects delete behavior)
 * @param syncType Type of sync operation
 * @param syncMethod Sync method ('version' or 'date_modified')
 * @param filterFunction Function to filter items for upsert vs delete
 * @param onStatusChange Optional callback for status updates
 * @param onProgress Optional callback for progress updates
 * @param batchSize Size of item batches to process (default: 100)
 */
export async function syncItemsToBackend(
    syncSessionId: string,
    libraryID: number,
    itemMetadata: ItemSyncMetadata[],
    collectionMetadata: CollectionSyncMetadata[],
    isInitialSync: boolean,
    syncType: SyncType,
    syncMethod: SyncMethod,
    filterFunction: ItemFilterFunction,
    onStatusChange?: (libraryID: number, status: SyncStatus, errorMessage?: string) => void,
    onProgress?: (libraryID: number, processed: number, totalForLibrary: number) => void,
    batchSize: number = 100,
) {
    const userId = store.get(userIdAtom);
    if (!userId) {
        logger('Beaver Sync:   No user found', 1);
        return;
    }

    const totalItemsForLibrary = itemMetadata.length + collectionMetadata.length;
    let processedCount = 0;
    let syncFailed = false;
    let lastError: any = null;
    onStatusChange?.(libraryID, 'in_progress');
    
    if (totalItemsForLibrary === 0) {
        logger(`Beaver Sync '${syncSessionId}':   No items or collections to process`, 3);
        onStatusChange?.(libraryID, 'completed');
        if (onProgress) onProgress(libraryID, 0, 0);
        return;
    }
    
    logger(`Beaver Sync '${syncSessionId}':   Processing ${itemMetadata.length} items and ${collectionMetadata.length} collections in batches of ${batchSize}`, 3);

    // 1. Sort item metadata by version, then by clientDateModified
    itemMetadata.sort((a, b) => {
        if (a.version !== b.version) {
            return a.version - b.version;
        }
        return new Date(a.clientDateModified).getTime() - new Date(b.clientDateModified).getTime();
    });

    // 2. Sort collection metadata by version, then by clientDateModified
    collectionMetadata.sort((a, b) => {
        if (a.version !== b.version) {
            return a.version - b.version;
        }
        return new Date(a.clientDateModified).getTime() - new Date(b.clientDateModified).getTime();
    });

    // 3. Create batches of item metadata respecting date boundaries
    const itemBatches = createBatches(
        itemMetadata,
        batchSize,
        (meta) => meta.clientDateModified
    );
    
    // Ensure at least one batch exists if we have collections to process
    if (itemBatches.length === 0 && collectionMetadata.length > 0) {
        itemBatches.push([]);
    }

    // Track skipped items
    const skippedItems: ZoteroItemReference[] = [];
    
    // Track which collections have been processed
    let collectionIndex = 0;

    // 4. Process each batch
    for (let i = 0; i < itemBatches.length; i++) {
        const batchMeta = itemBatches[i];

        // Determine the max version and date for this batch
        const batchMaxVersion = batchMeta.length > 0 
            ? Math.max(...batchMeta.map(m => m.version))
            : Infinity;
        const batchMaxDate = batchMeta.length > 0
            ? batchMeta[batchMeta.length - 1].clientDateModified
            : new Date(8640000000000000).toISOString(); // Max date
        const batchMaxDateTimestamp = new Date(batchMaxDate).getTime();

        // Log batch info for debugging
        const batchDateRange = {
            first: batchMeta.length > 0 ? batchMeta[0].clientDateModified : undefined,
            last: batchMaxDate,
            versions: batchMeta.length > 0 ? [batchMeta[0].version, batchMaxVersion] : [0, Infinity]
        };
        
        try {
            // ------- Load items for this batch -------
            const batchItemIds = batchMeta.map(m => m.itemId);
            const batchItems: Zotero.Item[] = [];
            
            if (batchItemIds.length > 0) {
                // Load items in chunks to avoid massive SQL queries
                const chunkSize = 500;
                for (let j = 0; j < batchItemIds.length; j += chunkSize) {
                    const chunk = batchItemIds.slice(j, j + chunkSize);
                    const chunkItems = await Zotero.Items.getAsync(chunk);
                    batchItems.push(...chunkItems);
                }
                
                // Load all needed data types in bulk
                if (batchItems.length > 0) {
                    await Zotero.Items.loadDataTypes(batchItems, ["primaryData", "creators", "itemData", "childItems", "tags", "collections", "relations"]);
                    
                    // Load parent items for attachments (needed for isInTrash() to check parent trash status)
                    const parentIds = [...new Set(
                        batchItems
                            .filter(item => item.parentID)
                            .map(item => item.parentID as number)
                    )];
                    if (parentIds.length > 0) {
                        const parentItems = await Zotero.Items.getAsync(parentIds);
                        if (parentItems.length > 0) {
                            await Zotero.Items.loadDataTypes(parentItems, ["primaryData"]);
                        }
                    }
                }
            }

            // ------- Apply filter to split into upsert/delete -------
            const itemsToUpsert = batchItems.filter(item => filterFunction(item));
            const itemsToDelete = isInitialSync ? [] : batchItems
                .filter(item => isSupportedItem(item) && !filterFunction(item));
            
            // Separate regular items and attachments
            const regularItems = itemsToUpsert.filter(item => item.isRegularItem());
            const attachmentItems = itemsToUpsert.filter(item => item.isAttachment());

            // Build clientDateModified map for this batch
            const clientDateModifiedMap = new Map<number, string>();
            for (const meta of batchMeta) {
                clientDateModifiedMap.set(meta.itemId, meta.clientDateModified);
            }

            // Extract delete data
            const itemDeleteData = await Promise.all(
                itemsToDelete.map(item => extractDeleteData(item))
            );
            
            // ------- Extract collection data for this batch -------
            // On the last batch, include ALL remaining collections to ensure the sync cursor
            // advances to cover both items and collections (collections also advance the cursor)
            const isLastBatch = i === itemBatches.length - 1;
            const batchCollectionsMeta: CollectionSyncMetadata[] = [];
            
            while (collectionIndex < collectionMetadata.length) {
                const collMeta = collectionMetadata[collectionIndex];
                
                // On the last batch, include all remaining collections regardless of version/date
                // This ensures collections with higher version/date than all items are synced
                const shouldInclude = isLastBatch || (syncMethod === 'version' 
                    ? collMeta.version <= batchMaxVersion
                    : new Date(collMeta.clientDateModified).getTime() <= batchMaxDateTimestamp);
                
                if (shouldInclude) {
                    batchCollectionsMeta.push(collMeta);
                    collectionIndex++;
                } else {
                    break;
                }
            }
            
            // Load and serialize collections
            const collectionsToUpsert: Zotero.Collection[] = [];
            const collectionsToDeleteData: DeleteData[] = [];
            
            for (const collMeta of batchCollectionsMeta) {
                const collection = Zotero.Collections.get(collMeta.collectionId);
                if (!collection) continue;
                
                if (collMeta.deleted && !isInitialSync) {
                    collectionsToDeleteData.push(await extractCollectionDeleteData(collection));
                } else if (!collMeta.deleted) {
                    collectionsToUpsert.push(collection);
                }
            }
            
            // Serialize collections
            const collectionDateMap = new Map<number, string>();
            for (const meta of batchCollectionsMeta) {
                collectionDateMap.set(meta.collectionId, meta.clientDateModified);
            }
            
            const batchCollectionsData: ZoteroCollection[] = await Promise.all(
                collectionsToUpsert.map(c => serializeCollection(c, collectionDateMap.get(c.id)))
            );

            logger(`Beaver Sync '${syncSessionId}':   Batch ${i + 1}/${itemBatches.length}: ` +
                   `${batchMeta.length} items loaded (${itemsToUpsert.length} upserts, ${itemsToDelete.length} deletions), ` +
                   `${batchCollectionsData.length} collections (${collectionsToDeleteData.length} deletions), ` +
                   `dates: ${batchDateRange.first} to ${batchDateRange.last}, ` +
                   `versions: ${batchDateRange.versions[0]} to ${batchDateRange.versions[1]}`);
            
            // ------- Serialize items and attachments -------
            const [batchItemsData, tempBatchAttachmentsData] = await Promise.all([
                Promise.all(
                    regularItems.map(item => serializeItem(item, clientDateModifiedMap.get(item.id)))
                ).then(data => data.filter(item => item !== null) as ItemData[]),
                Promise.all(
                    attachmentItems.map(item => serializeAttachment(item, clientDateModifiedMap.get(item.id)))
                ).then(data => data.filter(att => att !== null) as AttachmentDataWithMimeType[])
            ]);
            let batchAttachmentsData = tempBatchAttachmentsData;

            // ------- Fetch file hashes for attachments that need them -------
            const attachmentsNeedingHashes = batchAttachmentsData.filter(att => att.file_hash === NEEDS_HASH);
            const attachmentsWithHashes = batchAttachmentsData.filter(att => att.file_hash !== NEEDS_HASH);

            if (attachmentsNeedingHashes.length > 0) {
                const updatedAttachments = await fetchRemoteFileHashes(attachmentsNeedingHashes, syncSessionId);

                const successfullyUpdated = updatedAttachments.filter(att => att.file_hash !== NEEDS_HASH);
                const itemsWithMissingHash = updatedAttachments.filter(att => att.file_hash === NEEDS_HASH);
                
                if (itemsWithMissingHash.length > 0) {
                    logger(`Beaver Sync '${syncSessionId}':     Failed to fetch file hashes for ${itemsWithMissingHash.length} attachments`, 1);
                    const itemReferences = itemsWithMissingHash.map(att => ({
                        zotero_key: att.zotero_key,
                        library_id: att.library_id,
                    } as ZoteroItemReference));
                    skippedItemsManager.batchUpsert(itemReferences, 'Failed to fetch file hashes from server');
                    skippedItems.push(...itemReferences);
                }

                batchAttachmentsData = [...attachmentsWithHashes, ...successfullyUpdated];
            }

            // Combine all deletions
            const allDeletions = [...itemDeleteData, ...collectionsToDeleteData];

            // Count total items
            const totalItems = batchItemsData.length + batchAttachmentsData.length + allDeletions.length + batchCollectionsData.length;
            if (totalItems === 0) {
                logger(`Beaver Sync '${syncSessionId}':     No items to send to backend`, 4);
                processedCount += batchMeta.length;
                if (onProgress) onProgress(libraryID, processedCount, totalItemsForLibrary);
                continue;
            }

            // ------- Send to backend -------
            const { userID: zoteroUserId, localUserKey } = getZoteroUserIdentifier();

            let attempts = 0;
            const maxAttempts = 2;
            let batchResult = null;
            
            while (attempts < maxAttempts) {
                try {
                    logger(`Beaver Sync '${syncSessionId}':     Sending batch to backend (${batchItemsData.length} items, ${batchAttachmentsData.length} attachments, ${batchCollectionsData.length} collections, ${allDeletions.length} deletions, attempt ${attempts + 1}/${maxAttempts})`, 4);

                    batchResult = await syncService.processItemsBatch(
                        syncSessionId,
                        zoteroUserId,
                        localUserKey,
                        syncType,
                        syncMethod,
                        libraryID,
                        batchItemsData,
                        batchAttachmentsData,
                        batchCollectionsData,
                        allDeletions
                    );

                    await Zotero.Beaver.db.insertSyncLog({
                        session_id: syncSessionId,
                        sync_type: syncType,
                        method: syncMethod,
                        zotero_local_id: localUserKey,
                        zotero_user_id: zoteroUserId ?? null,
                        library_id: libraryID,
                        total_upserts: batchResult.total_upserts ?? 0,
                        total_deletions: batchResult.total_deletions ?? 0,
                        library_version: batchResult.library_version,
                        library_date_modified: batchResult.library_date_modified,
                        user_id: userId,
                    } as SyncLogsRecord);

                    logger(`Beaver Sync '${syncSessionId}':     Batch result: ${JSON.stringify(batchResult)}`, 4);
                    break;
                } catch (retryError) {
                    attempts++;
                    if (attempts >= maxAttempts) {
                        throw retryError;
                    }
                    const delay = 1000 * Math.pow(2, attempts - 1);
                    logger(`Beaver Sync '${syncSessionId}':     Batch processing attempt ${attempts}/${maxAttempts} failed, retrying in ${delay}ms...`, 2);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
    
            if (!batchResult) {
                throw new Error("Failed to process batch after multiple attempts");
            }
            
            if (batchResult.pending_uploads > 0) {                                
                logger(`Beaver Sync '${syncSessionId}':     ${batchResult.pending_uploads} attachments need to be uploaded, starting file uploader`, 2);
                await fileUploader.start(syncType === 'initial' ? "initial" : "background");
            }

            processedCount += batchMeta.length;
            if (onProgress) onProgress(libraryID, processedCount, totalItemsForLibrary);
            
        } catch (error: any) {
            const errorMessage = error?.message ? String(error.message) : 'Sync failed';
            logger(`Beaver Sync '${syncSessionId}':     Error processing batch: ${errorMessage}`, 1);
            Zotero.logError(error);
            syncFailed = true;
            lastError = error instanceof Error ? error : new Error(errorMessage);
            onStatusChange?.(libraryID, 'failed', errorMessage);
            break;
        }
    }

    // Check for skipped items
    if (skippedItems.length > 0) {
        logger(`Beaver Sync '${syncSessionId}':     ${skippedItems.length} items were skipped`, 1);
        if (skippedItems.length / totalItemsForLibrary > 0.05) {
            throw new Error("Too many items were skipped during sync");
        }
    }
    // Complete sync
    if (!syncFailed) {
        logger(`Beaver Sync '${syncSessionId}':   All ${totalItemsForLibrary} items requiring sync were processed; marking as complete.`, 3);
        onStatusChange?.(libraryID, 'completed');
        if (onProgress) onProgress(libraryID, totalItemsForLibrary, totalItemsForLibrary);
    } else {
        throw lastError instanceof Error ? lastError : new Error('Sync failed');
    }
}

/**
 * Deletes items and/or collections from Zotero library
 * @param userId User ID
 * @param libraryID Zotero library ID
 * @param zoteroKeys Zotero keys of items and/or collections to delete
 */
export const deleteItems = async (userId: string, libraryID: number, zoteroKeys: string[]) => {
    logger(`Beaver Sync: Deleting ${zoteroKeys.length} items/collections from library ${libraryID}`, 3);

    // Delete items/collections from backend
    const response = await syncService.deleteItems(libraryID, zoteroKeys);
}

/**
 * Updates the initial sync status for a library
 * @param libraryID Zotero library ID
 * @param updates Partial LibrarySyncStatus object containing only the fields to update
 */
const updateSyncStatus = (libraryID: number, updates: Partial<LibrarySyncStatus>) => {
    store.set(syncStatusAtom, (current: Record<number, LibrarySyncStatus>) => ({
        ...current,
        [libraryID]: {
            ...(current[libraryID] || {}),
            ...updates,
            libraryID
        }
    }));
};


interface SyncZoteroDatabaseOptions {
    filterFunction?: ItemFilterFunction;
    batchSize?: number;
    syncType?: SyncType;
    resetSyncStatus?: boolean;
}

/**
 * Performs sync for all libraries
 * 
 * syncZoteroDatabase()
 *  ├─ 1. Get local sync log. Skip sync if sync log is up to date.
 *  ├─ 2. Get backend sync state
 *  ├─ 3. getItemMetadataForSync()
 *  │     (lightweight DB query, returns {itemId, version, date}[])
 *  ├─ 4. getCollectionMetadataForSync()
 *  └─ 5. syncItemsToBackend(metadata)
 *     ├─ Sort metadata by version/date
 *     ├─ Create batches from metadata
 *     └─ For each batch:
 *       ├─ Load full item data with all data types (including parents and children)
 *       ├─ Apply filterFunction -> split into upsert/delete
 *       ├─ Serialize items and attachments
 *       └─ Send to backend
 * 
 * @param libraryIds IDs of libraries to sync
 * @param options Optional options for the sync:
 *   @param options.filterFunction Optional function to filter which items to sync (default: syncingItemFilter)
 *   @param options.batchSize Optional size of item batches to process (default: 50)
 *   @param options.syncType Optional type of sync to perform (default: 'incremental')
 *   @param options.resetSyncStatus Optional whether to reset the sync status for all libraries (default: false)
 * @returns Promise resolving when all libraries have been processed
 */
export async function syncZoteroDatabase(
    libraryIds: number[],
    options: SyncZoteroDatabaseOptions = {}
): Promise<void> {
    const syncSessionId = uuidv4();

    const {
        filterFunction = syncingItemFilter,
        batchSize = 50,
        syncType,
        resetSyncStatus = false
    } = options;

    // Get libraries
    const syncWithZotero = store.get(syncWithZoteroAtom);
    const libraries = Zotero.Libraries.getAll();
    const librariesToSyncCandidates = libraries.filter((library) => libraryIds.includes(library.libraryID));

    // Filter libraries to sync candidates to only include libraries that are valid for sync
    const librariesToSync = librariesToSyncCandidates.filter((library) =>
        // TODO: Use !isLibraryValidForSync to validate libraries and show warning if any libraries are not valid for sync (addPopupMessageAtom)
        // libraryIds.includes(library.libraryID) && isLibraryValidForSync(library, syncWithZotero)
        libraryIds.includes(library.libraryID) && (!library.isGroup || (library.isGroup && syncWithZotero))
    );
    if (librariesToSync.length !== librariesToSyncCandidates.length) {
        logger(`Beaver Sync '${syncSessionId}':   ${librariesToSyncCandidates.length - librariesToSync.length} libraries were excluded from sync because they are not valid for sync`, 2);
    }
    if (librariesToSync.length === 0) {
        logger(`Beaver Sync '${syncSessionId}':   No libraries were found to sync`, 2);
        return;
    }

    logger(`Beaver Sync '${syncSessionId}': Syncing ${librariesToSync.length} libraries with IDs: ${libraryIds.join(', ')}`, 2);

    // Reset sync status for all libraries
    if (resetSyncStatus) {
        store.set(syncStatusAtom, {});        
    }

    // Initialize sync status for all libraries
    for (const library of librariesToSync) {
        updateSyncStatus(library.libraryID, {
            status: 'in_progress',
            libraryName: library.name,
            ...(syncType ? { syncType } : {})
        });
    }

    // Get user ID
    const userId = store.get(userIdAtom);
    if (!userId) {
        throw new Error('No user found');
    }

    // On progress callback
    const onProgress = (libraryID: number, processed: number, totalForLibrary: number) => {
        const status = processed >= totalForLibrary ? 'completed' : 'in_progress';
        updateSyncStatus(libraryID, { syncedCount: processed, status });
    };

    // On status change callback for this library
    const onStatusChange = (libraryID: number, status: SyncStatus, errorMessage?: string) => {
        const updates: Partial<LibrarySyncStatus> = { status };
        if (status === 'failed') {
            updates.error = errorMessage || 'Sync failed. Try again.';
        } else {
            updates.error = undefined;
        }
        updateSyncStatus(libraryID, updates);
    };

    // Determine sync method
    const syncMethod = syncWithZotero ? 'version' : 'date_modified';

    // Validate sync method for all libraries
    if (syncWithZotero && (!Zotero.Sync.Runner.enabled || !Zotero.Users.getCurrentUserID())) {
        logger(`Beaver Sync '${syncSessionId}': Zotero sync is not enabled. Failing sync...`, 2);
        store.set(addPopupMessageAtom, {
            type: 'warning',
            title: 'Unable to Complete Sync with Beaver',
            text: `Zotero sync is disabled. Please enable Zotero sync in Zotero preferences or sign into your Zotero account.`,
            expire: true,
            duration: 10000
        });
        libraryIds.forEach(libraryID => onStatusChange(libraryID, 'failed'));
        return;
    }
    
    // Sync each library
    for (const library of librariesToSync) {
        const libraryID = library.libraryID;
        const libraryName = library.name;

        try {
            logger(`Beaver Sync '${syncSessionId}': Syncing library ${libraryID} (${libraryName})`, 2);

            // ----- 1. Validate sync method for this library -----
            const isSyncedWithZotero = isLibrarySynced(libraryID);
            if (syncWithZotero && !isSyncedWithZotero) {
                logger(`Beaver Sync '${syncSessionId}':   Library ${libraryID} (${libraryName}) is not synced with Zotero. Failing sync...`, 2);
                updateSyncStatus(libraryID, {
                    status: 'failed',
                    syncType: syncType ?? 'incremental',
                    error: `The library '${libraryName}' is not synced with Zotero. Enable it in Zotero preferences or remove it from Beaver.`
                });
                store.set(addPopupMessageAtom, {
                    type: 'warning',
                    title: 'Unable to Complete Sync with Beaver',
                    text: `The library '${libraryName}' is not synced with Zotero so Beaver cannot sync it. Remove the library from Beaver or add the library to Zotero sync.`,
                    expire: true,
                    showSettingsButton: true
                });
                continue;
            }

            // ----- 2. Check local sync logs to confirm whether the library is up to date -----
            let syncLog: SyncLogsRecord | null = null;
            if (syncMethod === 'version') {
                syncLog = await Zotero.Beaver.db.getSyncLogWithHighestVersion(userId, libraryID);
            } else if (syncMethod === 'date_modified') {
                syncLog = await Zotero.Beaver.db.getSyncLogWithMostRecentDate(userId, libraryID);
            }

            // Store metadata from local sync log check for potential reuse
            let cachedItemMeta: ItemSyncMetadata[] | null = null;
            let cachedCollMeta: CollectionSyncMetadata[] | null = null;

            // Use local sync log to confirm whether the library is up to date
            if (syncLog) {
                cachedItemMeta = await getItemMetadataForSync(
                    libraryID,
                    false,
                    syncMethod,
                    syncLog.library_date_modified,
                    syncLog.library_version
                );
                cachedCollMeta = await getCollectionMetadataForSync(
                    libraryID,
                    false,
                    syncMethod,
                    syncLog.library_date_modified,
                    syncLog.library_version
                );

                if (cachedItemMeta.length === 0 && cachedCollMeta.length === 0) {
                    logger(`Beaver Sync '${syncSessionId}':   Library ${libraryID} (${libraryName}) is up to date based on local sync log. (${syncMethod}: ${syncLog.library_date_modified}, ${syncLog.library_version})`, 3);
                    updateSyncStatus(libraryID, { status: 'completed' });
                    continue;
                }
            }
            
            // ----- 2. Get backend sync status -----
            logger(`Beaver Sync '${syncSessionId}': (1) Get backend sync status (syncMethod: ${syncMethod})`, 3);
            const syncState = await syncService.getSyncState(libraryID, syncMethod);

            const isInitialSync = syncState === null;
            const lastSyncDate = syncState
                ? (Zotero.Date.isISODate(syncState.last_sync_date_modified)
                    ? Zotero.Date.isoToSQL(syncState.last_sync_date_modified)
                    : syncState.last_sync_date_modified)
                : null;
            const lastSyncVersion = syncState ? syncState.last_sync_version : null;
            const syncLogDate = syncLog
                ? (Zotero.Date.isISODate(syncLog.library_date_modified)
                    ? Zotero.Date.isoToSQL(syncLog.library_date_modified)
                    : syncLog.library_date_modified)
                : null;
            
            const derivedSyncType = isInitialSync ? 'initial' : (syncType ?? 'incremental');
            // TODO: Transition from local to zotero sync library
            // if (syncState && syncState.last_sync_method === 'date_modified' && syncMethod === 'version') { }
            // if (syncState && syncState.last_sync_method === 'version' && syncMethod === 'date_modified') { }

            // Mark library as in-progress
            updateSyncStatus(libraryID, { status: 'in_progress', libraryName, syncType: derivedSyncType });

            logger(`Beaver Sync '${syncSessionId}':   Last sync date: ${lastSyncDate}, last sync version: ${lastSyncVersion}`, 3);

            if(!isInitialSync && syncMethod == 'version' && lastSyncVersion == library.libraryVersion) {
                logger(`Beaver Sync '${syncSessionId}':   Library version up to date (${lastSyncVersion})`, 3);
                updateSyncStatus(libraryID, { status: 'completed' });
                continue;
            }
        
            // ----- 3. Get item and collection metadata -----
            logger(`Beaver Sync '${syncSessionId}': (2) Get item and collection metadata`, 3);
            
            // Reuse cached metadata from local sync log check if local sync log matches backend sync state
            const canReuseCachedMetadata = syncLog && syncState && !isInitialSync &&
                syncLog.library_version === lastSyncVersion &&
                syncLogDate === lastSyncDate;

            let itemMetadata: ItemSyncMetadata[];
            let collectionMetadata: CollectionSyncMetadata[];

            if (canReuseCachedMetadata && cachedItemMeta && cachedCollMeta) {
                logger(`Beaver Sync '${syncSessionId}':   Reusing cached metadata (local sync log matches backend)`, 4);
                itemMetadata = cachedItemMeta;
                collectionMetadata = cachedCollMeta;
            } else {
                itemMetadata = await getItemMetadataForSync(
                    libraryID,
                    isInitialSync,
                    syncMethod,
                    lastSyncDate,
                    lastSyncVersion
                );
                collectionMetadata = await getCollectionMetadataForSync(
                    libraryID,
                    isInitialSync,
                    syncMethod,
                    lastSyncDate,
                    lastSyncVersion
                );
            }
            
            // Update library-specific progress and status
            const itemCount = itemMetadata.length + collectionMetadata.length;
            const libraryInitialStatus = {
                libraryID,
                libraryName,
                itemCount,
                syncedCount: 0,
                status: 'in_progress',
                syncType: derivedSyncType
            } as LibrarySyncStatus;

            logger(`Beaver Sync '${syncSessionId}':   ${itemMetadata.length} items and ${collectionMetadata.length} collections to process`, 3);

            if (itemCount === 0) {
                logger(`Beaver Sync '${syncSessionId}':   Sync complete`, 3);
                
                // Write sync log to record we've confirmed backend state
                const { userID: zoteroUserId, localUserKey } = getZoteroUserIdentifier();
                await Zotero.Beaver.db.insertSyncLog({
                    session_id: syncSessionId,
                    sync_type: derivedSyncType,
                    method: syncMethod,
                    zotero_local_id: localUserKey,
                    zotero_user_id: zoteroUserId ?? null,
                    library_id: libraryID,
                    total_upserts: 0,
                    total_deletions: 0,
                    library_version: lastSyncVersion ?? library.libraryVersion,
                    library_date_modified: lastSyncDate ?? new Date().toISOString(),
                    user_id: userId,
                } as SyncLogsRecord);
                
                updateSyncStatus(libraryID, { ...libraryInitialStatus, status: 'completed' });
                continue;
            }
            updateSyncStatus(libraryID, libraryInitialStatus);

            // ----- 4. Sync items with backend -----
            logger(`Beaver Sync '${syncSessionId}': (3) Sync items with backend`, 3);
            await syncItemsToBackend(
                syncSessionId,
                libraryID,
                itemMetadata,
                collectionMetadata,
                isInitialSync,
                derivedSyncType,
                syncMethod,
                filterFunction,
                onStatusChange,
                onProgress,
                batchSize
            );

            onStatusChange(libraryID, 'completed');
            
        } catch (error: any) {
            const errorMessage = error?.message ? String(error.message) : 'Sync failed';
            logger(`Beaver Sync '${syncSessionId}': Error syncing library ${libraryID} (${libraryName}): ${errorMessage}`, 1);
            Zotero.logError(error);
            updateSyncStatus(libraryID, { status: 'failed', error: errorMessage });
            // Continue with next library even if one fails
        }
    }
        
    logger(`Beaver Sync ${syncSessionId}: Sync completed for all libraries`, 2);
}

/**
 * Syncs all collections for specified libraries to the backend.
 * This is a one-time operation typically run after an upgrade.
 * Only syncs collections up to the last sync state to avoid advancing the sync cursor.
 * 
 * @param libraryIds IDs of libraries to sync collections for
 * @returns Promise resolving when all collections have been synced
 */
export async function syncCollectionsOnly(libraryIds: number[]): Promise<void> {
    const syncSessionId = uuidv4();
    
    logger(`Beaver Collection Sync '${syncSessionId}': Syncing collections for ${libraryIds.length} libraries: ${libraryIds.join(', ')}`, 2);

    const userId = store.get(userIdAtom);
    if (!userId) {
        throw new Error('No user found');
    }

    // Get libraries
    const libraries = Zotero.Libraries.getAll();
    const librariesToSync = libraries.filter((library) => libraryIds.includes(library.libraryID));

    // Determine sync method
    const syncWithZotero = store.get(syncWithZoteroAtom);
    const syncMethod = syncWithZotero ? 'version' : 'date_modified';

    // Get user identifier for backend
    const { userID: zoteroUserId, localUserKey } = getZoteroUserIdentifier();

    // Sync each library's collections
    for (const library of librariesToSync) {
        const libraryID = library.libraryID;
        const libraryName = library.name;

        try {
            logger(`Beaver Collection Sync '${syncSessionId}':   Processing library ${libraryID} (${libraryName})`, 3);

            // Get the last sync state from backend to ensure we don't advance the sync cursor
            const syncState = await syncService.getSyncState(libraryID, syncMethod);
            
            if (!syncState) {
                logger(`Beaver Collection Sync '${syncSessionId}':   No sync state found for library ${libraryID}. Skipping collection sync.`, 2);
                continue;
            }

            const lastSyncDate = syncState
                ? (Zotero.Date.isISODate(syncState.last_sync_date_modified)
                    ? Zotero.Date.isoToSQL(syncState.last_sync_date_modified)
                    : syncState.last_sync_date_modified)
                : null;
            const lastSyncVersion = syncState ? syncState.last_sync_version : null;

            logger(`Beaver Collection Sync '${syncSessionId}':   Last sync: version=${lastSyncVersion}, date=${lastSyncDate}`, 3);

            // Get all collections up to the last sync state
            let collections: Zotero.Collection[];
            if (syncMethod === 'version' && lastSyncVersion !== null) {
                collections = await getCollectionsSinceVersion(libraryID, -1, lastSyncVersion);
            } else if (syncMethod === 'date_modified' && lastSyncDate !== null) {
                collections = await getModifiedCollections(libraryID, '1970-01-01 00:00:00', lastSyncDate);
            } else {
                logger(`Beaver Collection Sync '${syncSessionId}':   Invalid sync state for library ${libraryID}`, 1);
                continue;
            }

            // Filter out deleted collections
            collections = collections.filter(collection => !collection.deleted);
            
            if (collections.length === 0) {
                logger(`Beaver Collection Sync '${syncSessionId}':   No collections found in library ${libraryID} up to sync state`, 3);
                continue;
            }

            logger(`Beaver Collection Sync '${syncSessionId}':   Found ${collections.length} collections to sync (up to ${syncMethod === 'version' ? `version ${lastSyncVersion}` : `date ${lastSyncDate}`})`, 3);

            // Get clientDateModified for all collections
            const collectionDateMap = new Map<number, string>();
            for (const collection of collections) {
                try {
                    const dateModified = await getCollectionClientDateModifiedAsISOString(collection.id);
                    collectionDateMap.set(collection.id, dateModified);
                } catch (e) {
                    logger(`Beaver Collection Sync '${syncSessionId}':   Warning: Could not get clientDateModified for collection ${collection.id}`, 2);
                    collectionDateMap.set(collection.id, new Date().toISOString());
                }
            }

            // Sort collections by version and date
            collections.sort((a, b) => {
                // Primary sort: version
                if (a.version !== b.version) {
                    return a.version - b.version;
                }
                
                // Secondary sort: clientDateModified
                const dateAStr = collectionDateMap.get(a.id);
                const dateBStr = collectionDateMap.get(b.id);
                const dateA = dateAStr ? new Date(dateAStr).getTime() : 0;
                const dateB = dateBStr ? new Date(dateBStr).getTime() : 0;
                return dateA - dateB;
            });

            // Extract collection data
            const collectionsData: ZoteroCollection[] = await Promise.all(
                collections.map(c => serializeCollection(c, collectionDateMap.get(c.id)))
            );

            logger(`Beaver Collection Sync '${syncSessionId}':   Sending ${collectionsData.length} collections to backend`, 3);

            // Send to backend
            // Note: The backend will receive collections with the lastSyncVersion/lastSyncDate as the max
            // This ensures we don't advance the sync cursor beyond where items were synced
            const batchResult = await syncService.processItemsBatch(
                syncSessionId,
                zoteroUserId,
                localUserKey,
                'consistency', // syncType for one-time maintenance operations
                syncMethod,
                libraryID,
                [], // no items
                [], // no attachments
                collectionsData,
                [] // no deletions
            );

            // Verify the sync state wasn't advanced beyond the last sync
            if (syncMethod === 'version' && batchResult.library_version > lastSyncVersion!) {
                logger(`Beaver Collection Sync '${syncSessionId}':   Warning: Backend advanced version from ${lastSyncVersion} to ${batchResult.library_version}`, 2);
            } else if (syncMethod === 'date_modified') {
                const resultDate = new Date(batchResult.library_date_modified);
                const expectedDate = new Date(lastSyncDate!);
                if (resultDate > expectedDate) {
                    logger(`Beaver Collection Sync '${syncSessionId}':   Warning: Backend advanced date from ${lastSyncDate} to ${batchResult.library_date_modified}`, 2);
                }
            }

            // Insert sync log into local database
            await Zotero.Beaver.db.insertSyncLog({
                session_id: syncSessionId,
                sync_type: 'consistency',
                method: syncMethod,
                zotero_local_id: localUserKey,
                zotero_user_id: zoteroUserId ?? null,
                library_id: libraryID,
                total_upserts: batchResult.total_upserts ?? 0,
                total_deletions: batchResult.total_deletions ?? 0,
                library_version: batchResult.library_version,
                library_date_modified: batchResult.library_date_modified,
                user_id: userId,
            });

            logger(`Beaver Collection Sync '${syncSessionId}':   Successfully synced collections for library ${libraryID}`, 3);

        } catch (error: any) {
            const errorMessage = error?.message ? String(error.message) : 'Collection sync failed';
            logger(`Beaver Collection Sync '${syncSessionId}':   Error syncing collections for library ${libraryID} (${libraryName}): ${errorMessage}`, 1);
            Zotero.logError(error);
            throw error; // Re-throw to stop the process
        }
    }

    // After all collections are synced, sync collection mappings
    logger(`Beaver Collection Sync '${syncSessionId}': All collections synced, now syncing collection mappings`, 2);
    
    try {
        const mappingResult = await syncService.syncCollectionMappings();
        logger(`Beaver Collection Sync '${syncSessionId}': Collection mappings synced. Created ${mappingResult.item_mappings_created} item mappings and ${mappingResult.attachment_mappings_created} attachment mappings`, 2);
    } catch (error: any) {
        const errorMessage = error?.message ? String(error.message) : 'Collection mapping sync failed';
        logger(`Beaver Collection Sync '${syncSessionId}': Error syncing collection mappings: ${errorMessage}`, 1);
        Zotero.logError(error);
        throw error;
    }

    logger(`Beaver Collection Sync '${syncSessionId}': Collection sync completed successfully`, 2);
}

/**
 * Deletes all data for a specific library from the backend when a user removes it from sync.
 * This includes all items, attachments, and sync logs associated with the library.
 *
 * @param libraryIds The IDs of the Zotero libraries to delete.
 */
export async function scheduleLibraryDeletion(libraryIds: number[]): Promise<DeleteLibraryTask[]> {
    const syncSessionId = uuidv4();
    logger(`Beaver Sync '${syncSessionId}': Deleting all data for libraries '${libraryIds.join(', ')}' from backend.`, 2);

    const userId = store.get(userIdAtom);
    if (!userId) {
        logger(`Beaver Sync '${syncSessionId}': No user found. Aborting deletion for libraries '${libraryIds.join(', ')}'.`, 1);
        store.set(addPopupMessageAtom, {
            type: 'error',
            title: 'Deletion Failed',
            text: `Could not delete libraries '${libraryIds.join(', ')}' because no user is logged in.`,
            expire: true,
        });
        return [];
    }

    try {
        // 1. Delete all library data from backend
        const tasks = await syncService.scheduleLibraryDeletion(libraryIds);
        logger(`Beaver Sync '${syncSessionId}': Successfully scheduled deletion of libraries data from backend'.`, 3);

        // 2. Delete local sync logs for the library
        await Zotero.Beaver.db.deleteSyncLogsForLibraryIds(userId, libraryIds);
        logger(`Beaver Sync '${syncSessionId}': Successfully deleted local sync logs for libraries '${libraryIds.join(', ')}'.`, 3);

        // Return tasks to caller
        return tasks;

    } catch (error: any) {
        logger(`Beaver Sync '${syncSessionId}': Failed to delete data for libraries '${libraryIds.join(', ')}': ${error.message}`, 1);
        Zotero.logError(error);
        return [];
    }
}


/**
 * Gets collections that have been modified since a specific date
 * @param libraryID Zotero library ID
 * @param sinceDate Date to check modifications since
 * @param untilDate Date to check modifications until (optional)
 * @returns Promise resolving to array of modified Zotero collections
 */
async function getModifiedCollections(libraryID: number, sinceDate: string, untilDate?: string): Promise<Zotero.Collection[]> {
    // Updated collection ids
    let sql = "SELECT collectionID FROM collections WHERE libraryID=? AND clientDateModified > ?";
    const params: any[] = [libraryID, sinceDate];
    if (untilDate) {
        sql += " AND clientDateModified <= ?";
        params.push(untilDate);
    }
    const ids = await Zotero.DB.columnQueryAsync(sql, params) as number[];
    return await Zotero.Collections.getAsync(ids);
}



/**
 * Gets collections based on version number
 * @param libraryID Zotero library ID
 * @param sinceVersion Zotero version number to check modifications since
 * @param toVersion Zotero version number to check modifications until (optional)
 * @returns Promise resolving to array of Zotero collections
 */
async function getCollectionsSinceVersion(libraryID: number, sinceVersion: number, toVersion?: number): Promise<Zotero.Collection[]> {
    let sql = "SELECT collectionID FROM collections WHERE libraryID=? AND version > ?";
    const params: any[] = [libraryID, sinceVersion];
    if (toVersion) {
        sql += " AND version <= ?";
        params.push(toVersion);
    }
    const ids = await Zotero.DB.columnQueryAsync(sql, params) as number[];
    return await Zotero.Collections.getAsync(ids);
}

/**
 * Gets all library items to sync
 * @param libraryID Zotero library ID
 * @param filterFunction Optional function to filter which items to sync
 * @returns Promise resolving to array of modified Zotero items
 */
export async function getAllItemsToSync(
    libraryID: number,
    filterFunction: ItemFilterFunction = syncingItemFilter
): Promise<Zotero.Item[]> {
    const allItems = await Zotero.Items.getAll(libraryID, false, false, false);
    const itemsToSync = allItems.filter(item => filterFunction(item));
    return itemsToSync;
}


/**
 * Retrieves all non-note and non-annotation item IDs from a library.
 *
 * @param {number} libraryID The ID of the Zotero library.
 * @returns {Promise<number[]>} A promise that resolves to an array of item IDs.
 */
async function getRegularAndAttachmentIDs(libraryID: number, includeDeleted = false): Promise<number[]> {
    const noteItemTypeID = Zotero.ItemTypes.getID('note');
    const annotationItemTypeID = Zotero.ItemTypes.getID('annotation');
    
    const params = [libraryID, noteItemTypeID, annotationItemTypeID];
    let sql = `SELECT A.itemID FROM items A WHERE A.libraryID = ? AND A.itemTypeID NOT IN (?, ?)`;
    
    if (!includeDeleted) {
        sql += " AND A.itemID NOT IN (SELECT itemID FROM deletedItems)";
    }
    
    return await Zotero.DB.columnQueryAsync(sql, params);
};

/** Result of immediate upsert operation */
export interface ImmediateUpsertResult {
    synced_items: number;
    synced_attachments: number;
    synced_collections: number;
    pending_uploads: number;
}

/**
 * Ensures a single Zotero item is synced to the backend immediately.
 * This is a convenience wrapper around ensureItemsSynced for single items.
 * 
 * Use this after creating/modifying items that need to be immediately available
 * for AI queries (e.g., items added via external reference import).
 * 
 * @param libraryId Library ID of the item
 * @param zoteroKey Zotero key of the item
 * @returns Promise resolving to the upsert result
 */
export async function ensureItemSynced(
    libraryId: number,
    zoteroKey: string
): Promise<ImmediateUpsertResult> {
    return ensureItemsSynced(libraryId, [zoteroKey]);
}

/**
 * Ensures multiple Zotero items are synced to the backend immediately.
 * Serializes the items and their attachments, then sends them to a special
 * endpoint that does NOT advance the sync cursor.
 * 
 * This is more efficient than calling ensureItemSynced multiple times
 * because it batches all items into a single API call.
 * 
 * Use cases:
 * - After user adds items via AI agent
 * - After user imports items from external search
 * - Any time items need to be immediately available for follow-up queries
 * 
 * @param libraryId Library ID of the items
 * @param zoteroKeys Array of Zotero keys to sync
 * @returns Promise resolving to the upsert result
 */
export async function ensureItemsSynced(
    libraryId: number,
    zoteroKeys: string[]
): Promise<ImmediateUpsertResult> {
    const { serializeItemWithAttachments } = await import('./zoteroSerializers');
    
    if (zoteroKeys.length === 0) {
        return { synced_items: 0, synced_attachments: 0, synced_collections: 0, pending_uploads: 0 };
    }
    
    logger(`ensureItemsSynced: Syncing ${zoteroKeys.length} items in library ${libraryId}`, 3);
    
    try {
        // Serialize all items and their attachments in parallel
        const serializationResults = await Promise.all(
            zoteroKeys.map(key => serializeItemWithAttachments(libraryId, key))
        );
        
        // Combine all items and attachments
        const items = serializationResults
            .map(r => r.item_data)
            .filter((item): item is ItemData => item !== undefined);
        const attachments = serializationResults
            .flatMap(r => r.attachment_data || []);
        
        if (items.length === 0 && attachments.length === 0) {
            logger(`ensureItemsSynced: No data to sync for ${zoteroKeys.length} items`, 2);
            return { synced_items: 0, synced_attachments: 0, synced_collections: 0, pending_uploads: 0 };
        }
        
        logger(`ensureItemsSynced: Sending ${items.length} items and ${attachments.length} attachments`, 3);
        
        // Call the immediate upsert endpoint (doesn't advance sync cursor)
        const result = await syncService.upsertItemsImmediate(libraryId, items, attachments);
        
        logger(`ensureItemsSynced: Synced ${result.synced_items} items and ${result.synced_attachments} attachments`, 3);
        
        // Start file uploader if there are pending uploads
        if (result.pending_uploads > 0) {
            logger(`ensureItemsSynced: ${result.pending_uploads} files pending upload, starting file uploader`, 3);
            await fileUploader.start('background');
        }
        
        return result;
    } catch (error: any) {
        // Log but don't throw - the items were still created in Zotero
        logger(`ensureItemsSynced: Failed to sync items: ${error.message}`, 1);
        Zotero.logError(error);
        return { synced_items: 0, synced_attachments: 0, synced_collections: 0, pending_uploads: 0 };
    }
}

/**
 * Gets lightweight item metadata for sorting and batching.
 * Excludes notes and annotations at DB level.
 * Includes trashed items so they can be routed to deletion.
 * 
 * @param libraryID Zotero library ID
 * @param isInitialSync Whether this is an initial sync
 * @param syncMethod The sync method ('version' or 'date_modified')
 * @param sinceDate Date to filter by (for date_modified method)
 * @param sinceVersion Version to filter by (for version method)
 * @returns Promise resolving to array of ItemSyncMetadata
 */
async function getItemMetadataForSync(
    libraryID: number,
    isInitialSync: boolean,
    syncMethod: SyncMethod,
    sinceDate: string | null,
    sinceVersion: number | null
): Promise<ItemSyncMetadata[]> {
    const noteItemTypeID = Zotero.ItemTypes.getID('note');
    const annotationItemTypeID = Zotero.ItemTypes.getID('annotation');
    
    let sql: string;
    let params: any[];
    
    if (isInitialSync) {
        // Initial sync: get all items except notes/annotations, exclude trashed
        sql = `
            SELECT itemID, version, clientDateModified 
            FROM items 
            WHERE libraryID = ? 
              AND itemTypeID NOT IN (?, ?)
              AND itemID NOT IN (SELECT itemID FROM deletedItems)
        `;
        params = [libraryID, noteItemTypeID, annotationItemTypeID];
    } else if (syncMethod === 'version' && sinceVersion !== null) {
        // Version-based incremental: include trashed items for deletion detection
        sql = `
            SELECT itemID, version, clientDateModified 
            FROM items 
            WHERE libraryID = ? 
              AND itemTypeID NOT IN (?, ?)
              AND version > ?
        `;
        params = [libraryID, noteItemTypeID, annotationItemTypeID, sinceVersion];
    } else if (syncMethod === 'date_modified' && sinceDate !== null) {
        // Date-based incremental: include trashed items for deletion detection
        const sqlDate = Zotero.Date.isISODate(sinceDate) ? Zotero.Date.isoToSQL(sinceDate) : sinceDate;
        sql = `
            SELECT itemID, version, clientDateModified 
            FROM items 
            WHERE libraryID = ? 
              AND itemTypeID NOT IN (?, ?)
              AND clientDateModified > ?
        `;
        params = [libraryID, noteItemTypeID, annotationItemTypeID, sqlDate];
    } else {
        throw new Error(`Invalid sync state: ${syncMethod} ${sinceDate} ${sinceVersion}`);
    }
    
    // Use onRow callback with Zotero.DB.queryAsync
    const results: ItemSyncMetadata[] = [];
    await Zotero.DB.queryAsync(sql, params, {
        onRow: (row: any) => {
            const itemId = row.getResultByIndex(0);
            const rawDate = row.getResultByIndex(2);
            let clientDateModified: string;
            try {
                clientDateModified = Zotero.Date.sqlToISO8601(rawDate);
            } catch (e) {
                logger(`getItemMetadataForSync: Invalid clientDateModified '${rawDate}' for item ${itemId}, using current timestamp`, 2);
                clientDateModified = new Date().toISOString();
            }
            results.push({
                itemId,
                version: row.getResultByIndex(1),
                clientDateModified
            });
        }
    });
    
    return results;
}

/**
 * Gets lightweight collection metadata for sorting and batching.
 * 
 * @param libraryID Zotero library ID
 * @param isInitialSync Whether this is an initial sync
 * @param syncMethod The sync method ('version' or 'date_modified')
 * @param sinceDate Date to filter by (for date_modified method)
 * @param sinceVersion Version to filter by (for version method)
 * @returns Promise resolving to array of CollectionSyncMetadata
 */
async function getCollectionMetadataForSync(
    libraryID: number,
    isInitialSync: boolean,
    syncMethod: SyncMethod,
    sinceDate: string | null,
    sinceVersion: number | null
): Promise<CollectionSyncMetadata[]> {
    let sql: string;
    let params: any[];
    
    if (isInitialSync) {
        // Initial sync: get all non-deleted collections
        sql = `
            SELECT collectionID, version, clientDateModified
            FROM collections 
            WHERE libraryID = ?
        `;
        params = [libraryID];
    } else if (syncMethod === 'version' && sinceVersion !== null) {
        sql = `
            SELECT collectionID, version, clientDateModified
            FROM collections 
            WHERE libraryID = ? AND version > ?
        `;
        params = [libraryID, sinceVersion];
    } else if (syncMethod === 'date_modified' && sinceDate !== null) {
        const sqlDate = Zotero.Date.isISODate(sinceDate) ? Zotero.Date.isoToSQL(sinceDate) : sinceDate;
        sql = `
            SELECT collectionID, version, clientDateModified
            FROM collections 
            WHERE libraryID = ? AND clientDateModified > ?
        `;
        params = [libraryID, sqlDate];
    } else {
        throw new Error(`Invalid sync state for collections: ${syncMethod} ${sinceDate} ${sinceVersion}`);
    }
    
    // Use onRow callback to avoid Proxy issues with Zotero.DB.queryAsync
    // Also load collections to check deleted status (needed for routing to delete)
    const results: CollectionSyncMetadata[] = [];
    await Zotero.DB.queryAsync(sql, params, {
        onRow: (row: any) => {
            const collectionId = row.getResultByIndex(0);
            const rawDate = row.getResultByIndex(2);
            const collection = Zotero.Collections.get(collectionId);
            let clientDateModified: string;
            try {
                clientDateModified = Zotero.Date.sqlToISO8601(rawDate);
            } catch (e) {
                logger(`getCollectionMetadataForSync: Invalid clientDateModified '${rawDate}' for collection ${collectionId}, using current timestamp`, 2);
                clientDateModified = new Date().toISOString();
            }
            results.push({
                collectionId,
                version: row.getResultByIndex(1),
                clientDateModified,
                deleted: collection?.deleted ?? false
            });
        }
    });
    
    return results;
}

/**
 * Fetches file hashes from the server for attachments that need them
 * @param attachmentsNeedingHashes Array of attachment data that need file hashes
 * @param syncSessionId Session ID for logging
 * @returns Promise resolving to new array of attachment data with updated file hashes
 */
async function fetchRemoteFileHashes(
    attachmentsNeedingHashes: AttachmentDataWithMimeType[],
    syncSessionId: string
): Promise<AttachmentDataWithMimeType[]> {
    if (attachmentsNeedingHashes.length === 0) {
        return [];
    }

    logger(`Beaver Sync '${syncSessionId}':     Fetching file hashes for ${attachmentsNeedingHashes.length} attachments from server`, 4);
    
    try {
        // Fetch items that need hashes
        const itemPromises = attachmentsNeedingHashes.map(att => 
            Zotero.Items.getByLibraryAndKeyAsync(att.library_id, att.zotero_key).catch(error => {
                logger(`Beaver Sync '${syncSessionId}':     Failed to fetch item ${att.zotero_key}: ${error.message}`, 2);
                return null;
            })
        );
        
        const items = (await Promise.all(itemPromises)).filter(item => item !== null) as Zotero.Item[];
        
        if (items.length > 0) {
            // Get file hashes from server
            const fileHashes = await getFileHashes(items);
            
            // Create a map for efficient lookup
            const hashMap = new Map(fileHashes.map(hash => [hash.key, hash.md5]));
            
            // Create new array with updated file hashes
            let updatedCount = 0;
            const updatedAttachments = attachmentsNeedingHashes.map(att => {
                // return att;
                const md5 = hashMap.get(att.zotero_key);
                if (md5) {
                    updatedCount++;
                    return { ...att, file_hash: md5 };
                }
                return att; // Keep original if no hash found
            });
            
            logger(`Beaver Sync '${syncSessionId}':     Successfully fetched ${updatedCount} file hashes from server`, 4);
            return updatedAttachments;
        }
    } catch (error: any) {
        logger(`Beaver Sync '${syncSessionId}':     Error fetching file hashes: ${error.message}`, 2);
    }

    // Return original array if no updates were made
    return attachmentsNeedingHashes;
}
