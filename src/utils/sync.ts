import { syncService, ItemData } from '../services/syncService';


/**
 * Interface for item filter function
 */
export type ItemFilterFunction = (item: Zotero.Item) => boolean;

/**
 * Default filter function that accepts all regular items
 * @param item Zotero item
 * @returns true if the item should be synced
 */
export const defaultItemFilter: ItemFilterFunction = (item) => {
    return item.isRegularItem();
};

/**
 * PDF attachment filter function
 * Only sync PDF attachments
 * @param item Zotero item
 * @returns true if the item is a PDF attachment
 */
export const pdfAttachmentFilter: ItemFilterFunction = (item) => {
    return item.isPDFAttachment();
};

/**
 * Extracts relevant data from a Zotero item for syncing
 * @param item Zotero item
 * @returns ItemData object for syncing
 */
function extractItemData(item: Zotero.Item): ItemData {
    // Extract basic metadata
    const itemData: ItemData = {
        zotero_key: item.key,
        library_id: item.libraryID,
        item_type: item.itemType,
        title: item.getField('title'),
        authors: extractPrimaryCreators(item),
        year: extractYear(item),
        abstract: item.getField('abstractNote'),
        // @ts-ignore Beaver exists
        reference: Zotero.Beaver.citationService.formatBibliography(item),
        identifiers: extractIdentifiers(item),
        tags: item.getTags(),
        date_added: item.dateAdded,
        date_modified: item.dateModified,
        version: item.version,
        // @ts-ignore isInTrash exists
        deleted: item.isInTrash(),
        item_json: item.toJSON()
    };
    
    return itemData;
}

/**
 * Extracts primary creators from a Zotero item
 * @param item Zotero item
 * @returns Array of primary creators
 */
function extractPrimaryCreators(item: Zotero.Item): any[] {
    const itemCreators = item.getCreators();
    const primaryCreatorTypeID = Zotero.CreatorTypes.getPrimaryIDForType(item.itemTypeID);
    return itemCreators.filter(creator => creator.creatorTypeID == primaryCreatorTypeID);
}

/**
 * Attempts to extract a year from a Zotero item's date field
 * @param item Zotero item
 * @returns Extracted year or undefined
 */
function extractYear(item: Zotero.Item): number | undefined {
    const date = item.getField('date');
    if (!date) return undefined;
    
    // Try to extract a 4-digit year from the date string
    const yearMatch = date.match(/\b(\d{4})\b/);
    return yearMatch ? parseInt(yearMatch[1]) : undefined;
}

/**
 * Extracts identifiers from a Zotero item
 * @param item Zotero item
 * @returns Object with identifiers
 */
function extractIdentifiers(item: Zotero.Item): Record<string, string> {
    const identifiers: Record<string, string> = {};
    
    const doi = item.getField('DOI');
    if (doi) identifiers.doi = doi;
    
    const isbn = item.getField('ISBN');
    if (isbn) identifiers.isbn = isbn;

    const issn = item.getField('ISSN');
    if (isbn) identifiers.isbn = isbn;
    
    const archiveID = item.getField('archiveID');
    if (archiveID) identifiers.archiveID = archiveID;
    
    const url = item.getField('url');
    if (url) identifiers.url = url;
    
    return identifiers;
}

/**
 * Syncs an array of Zotero items to the backend in batches
 * 
 * @param syncId ID of the current sync operation
 * @param libraryID Zotero library ID
 * @param items Array of Zotero items to sync
 * @param batchSize Size of item batches to process
 * @param onProgress Optional callback for progress updates (processed, total)
 * @returns Total number of successfully processed items
 */
async function syncItemsToBackend(
    syncId: string,
    libraryID: number,
    items: Zotero.Item[],
    batchSize: number = 50,
    onProgress?: (processed: number, total: number) => void
): Promise<number> {
    const totalItems = items.length;
    let processedCount = 0;
    
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        console.log(`[Beaver Sync] Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(items.length/batchSize)} (${batch.length} items)`);
        
        // Transform Zotero items to our format
        const itemsData = batch.map(extractItemData);
        
        // Send batch to backend
        const batchResult = await syncService.processItemsBatch(syncId, libraryID, itemsData);
        
        processedCount += batchResult.success;
        
        // Update progress
        if (onProgress) {
            onProgress(processedCount, totalItems);
        }
        
        console.log(`[Beaver Sync] Batch processed. Success: ${batchResult.success}/${batchResult.processed} items`);
    }
    
    return processedCount;
}

/**
 * Performs an initial sync of items from a Zotero library to the backend
 * 
 * @param libraryID Zotero library ID to sync
 * @param filterFunction Optional function to filter which items to sync
 * @param batchSize Size of item batches to process (default: 50)
 * @param onProgress Optional callback for progress updates (processed, total)
 * @returns Promise resolving to the sync complete response
 */
export async function performInitialSync(
    libraryID: number,
    filterFunction: ItemFilterFunction = defaultItemFilter,
    batchSize: number = 50,
    onProgress?: (processed: number, total: number) => void
): Promise<any> {
    try {
        const libraryName = Zotero.Libraries.getName(libraryID);
        console.log(`[Beaver Sync] Starting initial sync for library ${libraryID} (${libraryName})`);
        
        // 1. Get all items from the library
        const syncDate = Zotero.Date.dateToSQL(new Date(), true);
        const allItems = await Zotero.Items.getAll(libraryID, false, false, false);
        
        // 2. Filter items based on criteria
        const itemsToSync = allItems.filter(filterFunction);
        const totalItems = itemsToSync.length;
        
        console.log(`[Beaver Sync] Found ${totalItems} items to sync from library "${libraryName}"`);
        
        if (totalItems === 0) {
            console.log('[Beaver Sync] No items to sync, skipping sync operation');
            return { status: 'completed', message: 'No items to sync' };
        }
        
        // 3. Start the sync operation
        console.log('[Beaver Sync] Initiating sync operation...');
        const syncResponse = await syncService.startSync(
            libraryID,
            'initial',
            totalItems,
            syncDate
        );
        
        const syncId = syncResponse.sync_id;
        console.log(`[Beaver Sync] Sync operation started with ID: ${syncId}`);
        
        // 4. Process items in batches using the new function
        await syncItemsToBackend(syncId, libraryID, itemsToSync, batchSize, onProgress);
        
        // 5. Complete the sync operation
        console.log('[Beaver Sync] Completing sync operation...');
        const completeResponse = await syncService.completeSync(syncId);
        
        console.log(`[Beaver Sync] Initial sync completed successfully for library "${libraryName}"`);
        return completeResponse;
        
    } catch (error) {
        console.error('[Beaver Sync Error] Error during initial sync:', error);
        throw error;
    }
}

/**
 * Performs a periodic sync of modified items from a Zotero library to the backend
 * 
 * @param libraryID Zotero library ID to sync
 * @param lastSyncDate Date of the last successful sync
 * @param filterFunction Optional function to filter which items to sync
 * @param batchSize Size of item batches to process (default: 50)
 * @param onProgress Optional callback for progress updates (processed, total)
 * @returns Promise resolving to the sync complete response
 */
export async function performPeriodicSync(
    libraryID: number,
    lastSyncDate: string,
    filterFunction: ItemFilterFunction = defaultItemFilter,
    batchSize: number = 20,
    onProgress?: (processed: number, total: number) => void
): Promise<any> {
    try {
        const libraryName = Zotero.Libraries.getName(libraryID);
        console.log(`[Beaver Sync] Starting periodic sync from ${lastSyncDate} for library ${libraryID} (${libraryName})`);
        
        // 1. Get all items modified since last sync
        const modifiedItems = await getModifiedItemsSince(libraryID, lastSyncDate);
        
        // 2. Filter items based on criteria
        const itemsToSync = modifiedItems.filter(filterFunction);
        const totalItems = itemsToSync.length;
        
        console.log(`[Beaver Sync] Found ${totalItems} modified items to sync since ${lastSyncDate} from library "${libraryName}"`);
        
        if (totalItems === 0) {
            console.log('[Beaver Sync] No items to sync, skipping sync operation');
            return { status: 'completed', message: 'No items to sync' };
        }
        
        // 3. Start the sync operation
        const syncDate = Zotero.Date.dateToSQL(new Date(), true);
        console.log('[Beaver Sync] Initiating sync operation...');
        const syncResponse = await syncService.startSync(
            libraryID,
            'verification',
            totalItems,
            syncDate
        );
        
        const syncId = syncResponse.sync_id;
        console.log(`[Beaver Sync] Sync operation started with ID: ${syncId}`);
        
        // 4. Process items in batches
        await syncItemsToBackend(syncId, libraryID, itemsToSync, batchSize, onProgress);
        
        // 5. Complete the sync operation
        console.log('[Beaver Sync] Completing sync operation...');
        const completeResponse = await syncService.completeSync(syncId);
        
        console.log(`[Beaver Sync] Periodic sync completed successfully for library "${libraryName}"`);
        return completeResponse;
        
    } catch (error) {
        console.error('[Beaver Sync Error] Error during periodic sync:', error);
        throw error;
    }
}


/**
 * Performs initial or periodic sync for all libraries
 * @param filterFunction Optional function to filter which items to sync
 * @param batchSize Size of item batches to process (default: 50)
 * @param onProgress Optional callback for progress updates (processed, total)
 * @returns Promise resolving when all libraries have been processed
 */
export async function syncZoteroDatabase(
    filterFunction: ItemFilterFunction = defaultItemFilter,
    batchSize: number = 50,
    onProgress?: (processed: number, total: number) => void
): Promise<void> {
    const libraries = Zotero.Libraries.getAll();

    for (const library of libraries) {
        const libraryID = library.id;
        const libraryName = library.name;
        
        try {
            console.log(`[Beaver Sync] Syncing library ${libraryID} (${libraryName})`);
            
            // Get the last sync date for this library
            const response = await syncService.getLastSyncDate(libraryID);
            const lastSyncDate = response.last_sync_date;
            
            // Perform initial sync if no previous sync date is found, otherwise perform periodic sync
            if (!lastSyncDate) {
                await performInitialSync(libraryID, filterFunction, batchSize, onProgress);
            } else {
                await performPeriodicSync(libraryID, lastSyncDate, filterFunction, batchSize, onProgress);
            }
            
        } catch (error) {
            console.error(`[Beaver Sync Error] Error syncing library ${libraryID} (${libraryName}):`, error);
            // Continue with next library even if one fails
        }
    }
    
    console.log('[Beaver Sync] Sync completed for all libraries');
}

/**
 * Gets items that have been modified since a specific date
 * @param libraryID Zotero library ID
 * @param lastSyncDate Date to check modifications since
 * @returns Promise resolving to array of modified Zotero items
 */
async function getModifiedItemsSince(libraryID: number, lastSyncDate: string): Promise<Zotero.Item[]> {
    const sql = "SELECT itemID FROM items WHERE libraryID=? AND dateModified > ?";
    const ids = await Zotero.DB.columnQueryAsync(sql, [libraryID, lastSyncDate]) as number[];
    return await Zotero.Items.getAsync(ids);
}