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
        deleted: false,
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
        console.log(`Starting initial sync for library ${libraryID}`);
        
        // 1. Get library info from Zotero
        const libraryName = Zotero.Libraries.getName(libraryID);
        const libraryType = Zotero.Libraries.getType(libraryID);
        
        // 2. Get all items from the library
        console.log('Fetching all items from Zotero...');
        const allItems = await Zotero.Items.getAll(libraryID, false, false, false);
        
        // 3. Filter items based on criteria
        console.log('Filtering items...');
        const itemsToSync = allItems.filter(filterFunction);
        const totalItems = itemsToSync.length;
        
        console.log(`Found ${totalItems} items to sync from library "${libraryName}"`);
        
        if (totalItems === 0) {
            console.log('No items to sync, skipping sync operation');
            return { status: 'completed', message: 'No items to sync' };
        }
        
        // 4. Start the sync operation
        console.log('Initiating sync operation...');
        const syncResponse = await syncService.startInitialSync(
            libraryID,
            libraryName,
            libraryType,
            totalItems
        );
        
        const syncId = syncResponse.sync_id;
        console.log(`Sync operation started with ID: ${syncId}`);
        
        // 5. Process items in batches
        let processedCount = 0;
        
        for (let i = 0; i < itemsToSync.length; i += batchSize) {
            const batch = itemsToSync.slice(i, i + batchSize);
            console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(itemsToSync.length/batchSize)} (${batch.length} items)`);
            
            // Transform Zotero items to our format
            const itemsData = batch.map(extractItemData);
            
            // Send batch to backend
            const batchResult = await syncService.processItemsBatch(syncId, libraryID, itemsData);
            
            processedCount += batchResult.success;
            
            // Update progress
            if (onProgress) {
                onProgress(processedCount, totalItems);
            }
            
            console.log(`Batch processed. Success: ${batchResult.success}/${batchResult.processed} items`);
        }
        
        // 6. Complete the sync operation
        console.log('Completing sync operation...');
        
        // Get the current library version if available
        let libraryVersion;
        try {
            libraryVersion = Zotero.Libraries.getVersion(libraryID);
        } catch (e) {
            console.warn('Could not get library version:', e);
        }
        
        const completeResponse = await syncService.completeSync(syncId, libraryVersion);
        
        console.log(`Initial sync completed successfully for library "${libraryName}"`);
        return completeResponse;
        
    } catch (error) {
        console.error('Error during initial sync:', error);
        throw error;
    }
}