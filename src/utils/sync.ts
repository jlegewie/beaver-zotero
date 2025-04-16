import { syncService, ItemData, AttachmentData, FileData, ItemDataHashedFields, AttachmentDataHashedFields } from '../services/syncService';
import { SyncStatus } from 'react/atoms/ui';
import { fileUploader } from '../services/FileUploader';
import { calculateObjectHash } from './hash';


/**
 * Interface for item filter function
 */
export type ItemFilterFunction = (item: Zotero.Item) => boolean;

/**
 * Filter function for syncing items
 * @param item Zotero item
 * @returns true if the item should be synced
 */
export const syncingItemFilter: ItemFilterFunction = (item: Zotero.Item) => {
    return item.libraryID === 1 && (item.isRegularItem() || item.isPDFAttachment() || item.isImageAttachment());
};

/**
 * Extracts relevant data from a Zotero item for syncing, including a metadata hash.
 * @param item Zotero item
 * @returns Promise resolving to ItemData object for syncing
 */
async function extractItemData(item: Zotero.Item): Promise<ItemData> {
    // 1. Extract fields intended for hashing
    const hashedFields: ItemDataHashedFields = {
        zotero_key: item.key,
        library_id: item.libraryID,
        item_type: item.itemType,
        title: item.getField('title'),
        authors: extractPrimaryCreators(item),
        year: extractYear(item),
        publication: item.getField('publicationTitle'),
        abstract: item.getField('abstractNote'),
        // @ts-ignore Beaver exists
        reference: Zotero.Beaver?.citationService?.formatBibliography(item) ?? '',
        identifiers: extractIdentifiers(item),
        tags: item.getTags(),
        // @ts-ignore - Add proper types later
        deleted: typeof item.isInTrash === 'function' ? item.isInTrash() : (item.deleted ?? false),
    };

    // 2. Calculate hash from the extracted hashed fields
    const metadataHash = await calculateObjectHash(hashedFields);

    // 3. Construct final ItemData object
    const itemData: ItemData = {
        ...hashedFields,
        // Add non-hashed fields
        date_added: new Date(item.dateAdded + 'Z').toISOString(), // Convert UTC SQL datetime format to ISO string
        date_modified: new Date(item.dateModified + 'Z').toISOString(), // Convert UTC SQL datetime format to ISO string
        // Add the calculated hash
        item_metadata_hash: metadataHash,
    };

    return itemData;
}

/**
 * Extracts file metadata from a Zotero attachment item.
 * @param item Zotero attachment item
 * @returns Promise resolving to FileData object or null.
 */
async function extractFileData(item: Zotero.Item): Promise<FileData | null> {
    if (!item.isAttachment() || !(await item.fileExists())) return null;

    try {
        const fileName = item.attachmentFilename;
        const hash = await item.attachmentHash; // File content hash
        const size = await Zotero.Attachments.getTotalFileSize(item);
        const mimeType = item.attachmentContentType || 'application/octet-stream';

        return {
            name: fileName || '',
            hash: hash || '', // File content hash
            size: size || 0,
            mime_type: mimeType || ''
        };
    } catch (error: any) {
         Zotero.debug(`Beaver Sync: Error extracting file data for ${item.key}: ${error.message}`, 1);
         Zotero.logError(error);
         return null; // Return null if extraction fails
    }
}

/**
 * Extracts relevant data from a Zotero attachment item for syncing, including a metadata hash.
 * Keeps the 'file' property nested in the final output.
 * @param item Zotero item
 * @returns Promise resolving to AttachmentData object for syncing
 */
async function extractAttachmentData(item: Zotero.Item): Promise<AttachmentData> {
    // 1. Extract File Data (can be null)
    const fileData: FileData | null = await extractFileData(item);

    // 2. Determine 'is_primary' status
    let is_primary = null;
    if (item.parentItem) {
        is_primary = false;
        try {
            const bestAttachment = await item.parentItem.getBestAttachment();
            is_primary = !!bestAttachment && bestAttachment.key === item.key;
        } catch (error) {
            Zotero.debug(`Beaver Sync: Error getting best attachment for parent of ${item.key}`, 2);
        }
    }

    // 3. Prepare the object containing only fields for hashing
    const hashedFields: AttachmentDataHashedFields = {
        library_id: item.libraryID,
        zotero_key: item.key,
        parent_key: item.parentKey || null,
        is_primary: is_primary,
        // @ts-ignore - Add runtime check or proper types later
        deleted: typeof item.isInTrash === 'function' ? item.isInTrash() : (item.deleted ?? false),
        title: item.getField('title'),
        // Include relevant file fields (or nulls if fileData is null)
        file_content_hash: fileData?.hash ?? null,
        file_size: fileData?.size ?? null,
        file_mime_type: fileData?.mime_type ?? null,
        file_name: fileData?.name ?? null,
    };

    // 4. Calculate hash from the prepared hashed fields object
    const metadataHash = await calculateObjectHash(hashedFields);

    // 5. Construct final AttachmentData object
    const attachmentData: AttachmentData = {
        // Include base fields (redundant with hashedFields but clearer)
        library_id: hashedFields.library_id,
        zotero_key: hashedFields.zotero_key,
        parent_key: hashedFields.parent_key,
        is_primary: hashedFields.is_primary,
        deleted: hashedFields.deleted,
        title: hashedFields.title,
        // Add non-hashed fields
        date_added: new Date(item.dateAdded + 'Z').toISOString(),
        date_modified: new Date(item.dateModified + 'Z').toISOString(),
        // Include the nested file data object
        file: fileData,
        // Add the calculated hash
        attachment_metadata_hash: metadataHash,
    };

    return attachmentData;
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
    
    // Set initial progress
    if (onProgress) onProgress(0, totalItems);
    onStatusChange?.('in_progress');
    
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        Zotero.debug(`Beaver Sync: Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(items.length/batchSize)} (${batch.length} items)`, 4);
        
        // Transform Zotero items to our format
        const itemsData = await Promise.all(batch.filter(item => item.isRegularItem()).map(extractItemData));
        const attachmentsData = await Promise.all(batch.filter(item => item.isAttachment()).map(extractAttachmentData));
        attachmentCount += attachmentsData.length;

        // sync options
        const createLog = i === 0;
        const closeLog = i + batchSize >= items.length;

        try {
            // Send batch to backend
            let attempts = 0;
            const maxAttempts = 3;
            let batchResult = null;
            
            while (attempts < maxAttempts) {
                try {
                    batchResult = await syncService.processItemsBatch(libraryID, itemsData, attachmentsData, syncType, createLog, closeLog, syncId);
                    break; // Success, exit retry loop
                } catch (retryError) {
                    attempts++;
                    if (attempts >= maxAttempts) {
                        throw retryError; // Rethrow if max attempts reached
                    }
                    
                    // Wait before retrying (exponential backoff)
                    const delay = 1000 * Math.pow(2, attempts - 1); // 1s, 2s, 4s
                    Zotero.debug(`Beaver Sync: Batch processing attempt ${attempts}/${maxAttempts} failed, retrying in ${delay}ms...`, 2);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
    
            // Process batch result
            if (!batchResult) {
                throw new Error("Failed to process batch after multiple attempts");
            }
            
            syncId = batchResult.sync_id;
            if (batchResult.sync_status === 'failed') {
                onStatusChange?.('failed');
                const error = new Error(`Beaver Sync: Batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(items.length/batchSize)} failed. Failed keys: ${batchResult.failed_keys}`);
                Zotero.logError(error);
                break;
            }
            
            // Update processed count with actual success count
            const newProcessed = processedCount + batchResult.success;
            
            // Only report progress if the processed count actually increased
            // This prevents the progress from temporarily resetting
            if (newProcessed > processedCount) {
                processedCount = newProcessed;
                if (onProgress) {
                    onProgress(processedCount, totalItems);
                }
            }
            
            // If this is the last batch and successful
            if (closeLog && batchResult.sync_status === 'completed') {
                onStatusChange?.('completed');
                // Report 100% completion at the end for consistency
                if (onProgress) {
                    onProgress(totalItems, totalItems);
                }
            }
        } catch (error: any) {
            Zotero.debug(`Beaver Sync: Error processing batch: ${error.message}`, 1);
            Zotero.logError(error);
            onStatusChange?.('failed');
            break;
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
    filterFunction: ItemFilterFunction = syncingItemFilter,
    onStatusChange?: (status: SyncStatus) => void,
    onProgress?: (processed: number, total: number) => void,
    batchSize: number = 50
): Promise<any> {
    try {
        const libraryName = Zotero.Libraries.getName(libraryID);
        Zotero.debug(`Beaver Sync: Starting initial sync for library ${libraryID} (${libraryName})`, 2);
        
        // 1. Get all items from the library
        const syncDate = Zotero.Date.dateToSQL(new Date(), true);
        const allItems = await Zotero.Items.getAll(libraryID, false, false, false);
        
        // 2. Filter items based on criteria
        const itemsToSync = allItems.filter(filterFunction);
        const totalItems = itemsToSync.length;
        
        Zotero.debug(`Beaver Sync: Found ${totalItems} items to sync from library "${libraryName}"`, 3);
        
        if (totalItems === 0) {
            Zotero.debug('Beaver Sync: No items to sync, skipping sync operation', 3);
            return { status: 'completed', message: 'No items to sync' };
        }
        
        // 3. Process items in batches using the new function
        await syncItemsToBackend(libraryID, itemsToSync, 'initial', onStatusChange, onProgress, batchSize);
        
    } catch (error: any) {
        Zotero.debug('Beaver Sync Error: Error during initial sync: ' + error.message, 1);
        Zotero.logError(error);
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
    filterFunction: ItemFilterFunction = syncingItemFilter,
    onStatusChange?: (status: SyncStatus) => void,
    onProgress?: (processed: number, total: number) => void,
    batchSize: number = 20
) {
    try {
        const libraryName = Zotero.Libraries.getName(libraryID);
        Zotero.debug(`Beaver Sync: Starting periodic sync from ${lastSyncDate} for library ${libraryID} (${libraryName})`, 2);
        
        // 1. Get all items modified since last sync
        const modifiedItems = await getModifiedItemsSince(libraryID, lastSyncDate);
        
        // 2. Filter items based on criteria
        const itemsToSync = modifiedItems.filter(filterFunction);
        const totalItems = itemsToSync.length;
        
        Zotero.debug(`Beaver Sync: Found ${totalItems} modified items to sync since ${lastSyncDate} from library "${libraryName}"`, 3);
        
        if (totalItems === 0) {
            onStatusChange?.('completed');
            Zotero.debug('Beaver Sync: No items to sync, skipping sync operation', 3);
            return { status: 'completed', message: 'No items to sync' };
        }
        
        // 3. Process items in batches
        await syncItemsToBackend(libraryID, itemsToSync, 'verification', onStatusChange, onProgress, batchSize);
        
    } catch (error: any) {
        Zotero.debug('Beaver Sync Error: Error during periodic sync: ' + error.message, 1);
        Zotero.logError(error);
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
    filterFunction: ItemFilterFunction = syncingItemFilter,
    batchSize: number = 50,
    onStatusChange?: (status: SyncStatus) => void,
    onProgress?: (processed: number, total: number) => void
): Promise<void> {
    const libraries = Zotero.Libraries.getAll();

    for (const library of libraries) {
        const libraryID = library.id;
        const libraryName = library.name;
        
        try {
            Zotero.debug(`Beaver Sync: Syncing library ${libraryID} (${libraryName})`, 3);
            
            // Get the last sync date for this library
            const response = await syncService.getLastSyncDate(libraryID);
            const lastSyncDate = response.last_sync_date;
            
            // Perform initial sync if no previous sync date is found, otherwise perform periodic sync
            if (!lastSyncDate) {
                await performInitialSync(libraryID, filterFunction, onStatusChange, onProgress, batchSize);
            } else {
                await performPeriodicSync(libraryID, lastSyncDate, filterFunction, onStatusChange, onProgress, batchSize);
            }
            
        } catch (error: any) {
            Zotero.debug(`Beaver Sync Error: Error syncing library ${libraryID} (${libraryName}): ${error.message}`, 1);
            Zotero.logError(error);
            // Continue with next library even if one fails
        }
    }
    
    Zotero.debug('Beaver Sync: Sync completed for all libraries', 2);
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