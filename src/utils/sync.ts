import { syncService, ItemData, AttachmentData, FileData } from '../services/syncService';
import { SyncStatus } from 'react/atoms/ui';
import { fileUploader } from '../services/FileUploader';


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

export const itemFilter: ItemFilterFunction = (item) => {
    return item.isRegularItem() || item.isPDFAttachment() || item.isImageAttachment();
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
        date_added: new Date(item.dateAdded + 'Z').toISOString(), // Convert UTC SQL datetime format to ISO string
        date_modified: new Date(item.dateModified + 'Z').toISOString(), // Convert UTC SQL datetime format to ISO string
        version: item.version,
        // @ts-ignore isInTrash exists
        deleted: item.isInTrash(),
        // item_json: item.toJSON()
    };
    
    return itemData;
}

/**
 * Extracts relevant data from a Zotero item for syncing
 * @param item Zotero item
 * @returns ItemData object for syncing
 */
async function extractAttachmentData(item: Zotero.Item): Promise<AttachmentData> {

    // Is primary attachment
    let is_primary = null;
    if (item.parentItem) {
        is_primary = false;
        const bestAttachment = await item.parentItem.getBestAttachment();
        if (bestAttachment) {
            is_primary = bestAttachment.key === item.key;
        }
    }

    // Extract basic metadata
    const itemData: AttachmentData = {
        // attachments table fields
        library_id: item.libraryID,
        zotero_key: item.key,
        parent_key: item.parentKey || null,
        is_primary: is_primary,
        // @ts-ignore isInTrash exists
        deleted: item.isInTrash() as boolean,
        title: item.getField('title'),
        date_added: new Date(item.dateAdded + 'Z').toISOString(), // Convert UTC SQL datetime format to ISO string
        date_modified: new Date(item.dateModified + 'Z').toISOString(), // Convert UTC SQL datetime format to ISO string
        // item_json: item.toJSON(),
        // file table fields
        file: await extractFileData(item)
    };
    
    return itemData;
}

/**
 * Extracts file metadata from a Zotero attachment item
 * @param item Zotero attachment item
 * @returns Promise with file metadata
 */
async function extractFileData(item: Zotero.Item): Promise<FileData | null> {
    // if (!item.isFileAttachment()) return {}
    if (!item.isAttachment()) return null;
    if (!(await item.fileExists())) return null;

    // File metadata
    const fileName = item.attachmentFilename;
    const hash = await item.attachmentHash;
    const size = await Zotero.Attachments.getTotalFileSize(item);
    const mimeType = item.attachmentContentType || 'application/octet-stream';

    // Fulltext indexed
    // @ts-ignore FullText exists
    const fulltextIndexed = Zotero.FullText.canIndex(item) && await Zotero.FullText.isFullyIndexed(item);
    let fulltextLastModified = null;
    if(fulltextIndexed) {
        // @ts-ignore Zotero.FullText exists
        const cacheFile = Zotero.FullText.getItemCacheFile(item);
        const fileInfo = await IOUtils.stat(cacheFile.path);
        fulltextLastModified = fileInfo.lastModified;
    }

    // Return file data
    return {
        name: fileName || '',
        hash: hash || '',
        size: size || 0,
        mime_type: mimeType || '',
        fulltext_indexed: fulltextIndexed,
        fulltext_last_modified: fulltextLastModified
    } as FileData;
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
 * @param libraryID Zotero library ID
 * @param items Array of Zotero items to sync
 * @param syncType Type of sync operation. (optional)
 * @param onStatusChange Optional callback for status updates (in_progress, completed, failed)
 * @param onProgress Optional callback for progress updates (processed, total)
 * @param batchSize Size of item batches to process (default: 50)
 * @returns Total number of successfully processed items
 */
export async function syncItemsToBackend(
    libraryID: number,
    items: Zotero.Item[],
    syncType: string,
    onStatusChange?: (status: SyncStatus) => void,
    onProgress?: (processed: number, total: number) => void,
    batchSize: number = 200
) {
    const totalItems = items.length;
    let attachmentCount = 0;
    let syncId = undefined;
    let processedCount = 0;
    
    onStatusChange?.('in_progress');
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        console.log(`[Beaver Sync] Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(items.length/batchSize)} (${batch.length} items)`);
        
        // Transform Zotero items to our format
        const itemsData = batch.filter(item => item.isRegularItem()).map(extractItemData);
        const attachmentsData = await Promise.all(batch.filter(item => item.isAttachment()).map(extractAttachmentData));
        attachmentCount += attachmentsData.length;

        // sync options
        const createLog = i === 0;
        const closeLog = i + batchSize >= items.length;

        // Send batch to backend
        const batchResult = await syncService.processItemsBatch(libraryID, itemsData, attachmentsData, syncType, createLog, closeLog, syncId);

        // Process batch result
        syncId = batchResult.sync_id;
        if (batchResult.sync_status === 'failed') {
            onStatusChange?.('failed');
            console.error(`[Beaver Sync] Batch failed. Failed keys: ${batchResult.failed_keys}`);
            break;
        }
        if (batchResult.sync_status === 'completed') onStatusChange?.('completed');

        // Progress update
        processedCount += batchResult.success;
        if (onProgress) {
            onProgress(processedCount, totalItems);
        }   
    }
    // Start file uploader if there are attachments to upload
    if (attachmentCount > 0) {
        fileUploader.start();
    }
}

/**
 * Performs an initial sync of items from a Zotero library to the backend
 * 
 * @param libraryID Zotero library ID to sync
 * @param filterFunction Optional function to filter which items to sync
 * @param onStatusChange Optional callback for status updates (in_progress, completed, failed)
 * @param onProgress Optional callback for progress updates (processed, total)
 * @param batchSize Size of item batches to process (default: 50)
 * @returns Promise resolving to the sync complete response
 */
export async function performInitialSync(
    libraryID: number,
    filterFunction: ItemFilterFunction = itemFilter,
    onStatusChange?: (status: SyncStatus) => void,
    onProgress?: (processed: number, total: number) => void,
    batchSize: number = 50
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
        
        // 3. Process items in batches using the new function
        await syncItemsToBackend(libraryID, itemsToSync, 'initial', onStatusChange, onProgress, batchSize);
        
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
 * @param onStatusChange Optional callback for status updates (in_progress, completed, failed)
 * @param onProgress Optional callback for progress updates (processed, total)
 * @param batchSize Size of item batches to process (default: 50)
 * @returns Promise resolving to the sync complete response
 */
export async function performPeriodicSync(
    libraryID: number,
    lastSyncDate: string,
    filterFunction: ItemFilterFunction = itemFilter,
    onStatusChange?: (status: SyncStatus) => void,
    onProgress?: (processed: number, total: number) => void,
    batchSize: number = 20
) {
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
            onStatusChange?.('completed');
            console.log('[Beaver Sync] No items to sync, skipping sync operation');
            return { status: 'completed', message: 'No items to sync' };
        }
        
        // 3. Process items in batches
        await syncItemsToBackend(libraryID, itemsToSync, 'verification', onStatusChange, onProgress, batchSize);
        
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
    filterFunction: ItemFilterFunction = itemFilter,
    batchSize: number = 50,
    onStatusChange?: (status: SyncStatus) => void,
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
                await performInitialSync(libraryID, filterFunction, onStatusChange, onProgress, batchSize);
            } else {
                await performPeriodicSync(libraryID, lastSyncDate, filterFunction, onStatusChange, onProgress, batchSize);
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