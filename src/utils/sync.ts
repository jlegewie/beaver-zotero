import { syncService, SyncDataResponse } from '../services/syncService';
import { fileUploader } from '../services/FileUploader';
import { calculateObjectHash } from './hash';
import { logger } from './logger';
import { userIdAtom } from "../../react/atoms/auth";
import { store } from "../../react/index";
import { syncStatusAtom, LibrarySyncStatus, SyncStatus } from '../../react/atoms/sync';
import { ZoteroCreator, ItemDataHashedFields, ItemData, BibliographicIdentifier, ZoteroCollection, AttachmentDataHashedFields, DeleteData, AttachmentDataWithMimeType } from '../../react/types/zotero';
import { getMimeType, isLibrarySynced, getClientDateModified, getClientDateModifiedAsISOString, getClientDateModifiedBatch } from './zoteroUtils';
import { v4 as uuidv4 } from 'uuid';
import { addPopupMessageAtom } from '../../react/utils/popupMessageUtils';
import { syncWithZoteroAtom } from '../../react/atoms/profile';

/**
 * Interface for item filter function
 */
export type ItemFilterFunction = (item: Zotero.Item, collectionId?: number) => boolean;

/**
 * Filter function for syncing items
 * @param item Zotero item
 * @returns true if the item should be synced
 */
export const syncingItemFilter: ItemFilterFunction = (item: Zotero.Item, collectionId?: number) => {
    return (item.isRegularItem() || item.isPDFAttachment() || item.isImageAttachment()) &&
        !item.isInTrash()
        // (collectionId ? item.inCollection(collectionId) : true);
};


export async function extractDeleteData(item: Zotero.Item): Promise<DeleteData> {
    return {
        library_id: item.libraryID,
        zotero_key: item.key,
        zotero_version: item.version,
        zotero_synced: item.synced,
        date_modified: await getClientDateModified(item)
    };
}

/**
 * Extracts relevant data from a Zotero item for syncing, including a metadata hash.
 * @param item Zotero item
 * @returns Promise resolving to ItemData object for syncing
 */
async function extractItemData(item: Zotero.Item, clientDateModified: string | undefined): Promise<ItemData> {

    // ------- 1. Get full item data -------
    // @ts-ignore - Returns of item.toJSON are not typed correctly
    const { abstractNote, creators, collections, tags, version, ...fullItemData } = item.toJSON();

    // ------- 2. Extract fields for hashing -------
    const hashedFields: ItemDataHashedFields = {
        zotero_key: item.key,
        library_id: item.libraryID,
        item_type: item.itemType,
        title: item.getField('title'),
        creators: extractCreators(item),
        date: item.getField('date'),
        year: extractYear(item),
        publication_title: item.getField('publicationTitle'),
        abstract: item.getField('abstractNote'),
        url: item.getField('url'),
        identifiers: extractIdentifiers(item),

        item_json: fullItemData,

        language: item.getField('language'),
        formatted_citation: Zotero.Beaver.citationService.formatBibliography(item) ?? '',
        deleted: item.isInTrash(),
        tags: item.getTags().length > 0 ? item.getTags() : null,
        collections: extractCollections(item),
        citation_key: await getCiteKey(item),
    };

    // ------- 3. Calculate hash from the extracted hashed fields -------
    const metadataHash = await calculateObjectHash(hashedFields);

    // ------- 4. Construct final ItemData object -------
    const itemData: ItemData = {
        ...hashedFields,
        // Add non-hashed fields
        // Replace with Zotero.Date.sqlToISO8601(...)??
        date_added: new Date(item.dateAdded + 'Z').toISOString(), // Convert UTC SQL datetime format to ISO string
        date_modified: clientDateModified || await getClientDateModifiedAsISOString(item),
        // Add the calculated hash
        zotero_version: item.version,
        zotero_synced: item.synced,
        item_metadata_hash: metadataHash,
    };

    return itemData;
}


export interface FileData {
    // filename: string;
    file_hash: string;
    size: number;
    mime_type: string;
    // content?: string;
    storage_path?: string;
}

/**
 * Extracts file metadata from a Zotero attachment item.
 * @param item Zotero attachment item
 * @returns Promise resolving to FileData object or null.
 */
async function extractFileData(item: Zotero.Item): Promise<FileData | null> {
    if (!item.isAttachment() || !(await item.fileExists())) return null;

    try {
        // const fileName = item.attachmentFilename;
        const file_hash = await item.attachmentHash; // File content hash
        const size = await Zotero.Attachments.getTotalFileSize(item);
        const mimeType = item.attachmentContentType || 'application/octet-stream';

        return {
            // filename: fileName,
            file_hash: file_hash,
            size: size,
            mime_type: mimeType
        };
    } catch (error: any) {
        logger(`Beaver Sync: Error extracting file data for ${item.key}: ${error.message}`, 1);
        Zotero.logError(error);
        return null; // Return null if extraction fails
    }
}

/**
 * Extracts relevant data from a Zotero attachment item for syncing, including a metadata hash.
 * Keeps the 'file' property nested in the final output.
 * @param item Zotero item
 * @param options Optional parameters
 * @param options.lightweight If true, skips file-system operations (file existence check and content hashing)
 * @returns Promise resolving to AttachmentData object for syncing
 */
async function extractAttachmentData(item: Zotero.Item, clientDateModified: string | undefined, options?: { lightweight?: boolean }): Promise<AttachmentDataWithMimeType | null> {

    // 1. File: Confirm that the item is an attachment and that the file exists
    if (!item.isAttachment() || !(await item.fileExists())) return null;
    const file_hash = options?.lightweight ? '' : await item.attachmentHash;

    // 2. Metadata: Prepare the object containing only fields for hashing
    const hashedFields: AttachmentDataHashedFields = {
        library_id: item.libraryID,
        zotero_key: item.key,
        parent_key: item.parentKey || null,
        attachment_url: item.getField('url'),
        link_mode: item.attachmentLinkMode,
        tags: item.getTags().length > 0 ? item.getTags() : null,
        collections: extractCollections(item),
        deleted: item.isInTrash(),
        title: item.getField('title'),
        filename: item.attachmentFilename,
    };

    // 3. Metadata Hash: Calculate hash from the prepared hashed fields object
    const metadataHash = await calculateObjectHash(hashedFields);

    // 4. AttachmentData: Construct final AttachmentData object
    const attachmentData: AttachmentDataWithMimeType = {
        ...hashedFields,
        // Add non-hashed fields
        file_hash: file_hash,
        mime_type: await getMimeType(item),
        date_added: new Date(item.dateAdded + 'Z').toISOString(),
        date_modified: clientDateModified || await getClientDateModifiedAsISOString(item),
        // Add the calculated hash
        attachment_metadata_hash: metadataHash,
        zotero_version: item.version,
        zotero_synced: item.synced,
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
    return itemCreators
        .filter(creator => creator.creatorTypeID == primaryCreatorTypeID)
        .map(creator => ({
            ...creator,
            type: Zotero.CreatorTypes.getName(creator.creatorTypeID),
        }));
}

/**
 * Extracts creators from a Zotero item
 * @param item Zotero item
 * @returns Array of creators
 */
function extractCreators(item: Zotero.Item): ZoteroCreator[] | null {
    const itemCreators = item.getCreators();
    const primaryCreatorTypeID = Zotero.CreatorTypes.getPrimaryIDForType(item.itemTypeID);

    const creators = itemCreators.map((creator, index) => ({
        first_name: creator.firstName || null,
        last_name: creator.lastName || null,
        field_mode: creator.fieldMode,
        creator_type_id: creator.creatorTypeID,
        creator_type: Zotero.CreatorTypes.getName(creator.creatorTypeID),
        is_primary: creator.creatorTypeID === primaryCreatorTypeID
    } as ZoteroCreator));

    return creators.length > 0 ? creators : null;
}


function extractCollections(item: Zotero.Item): ZoteroCollection[] | null {
    const collections = item.getCollections().
        map(collection_id => {
            const collection = Zotero.Collections.get(collection_id).toJSON();
            return {
                collection_id,
                key: collection.key,
                version: collection.version,
                name: collection.name,
                parent_collection: collection.parentCollection || null,
                relations: collection.relations,
            } as ZoteroCollection;
        })

    return collections.length > 0 ? collections : null;
}


/**
 * Attempts to extract a year from a Zotero item's date field
 * @param item Zotero item
 * @returns Extracted year or undefined
 */
export function extractYear(item: Zotero.Item): number | undefined {
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
function extractIdentifiers(item: Zotero.Item): BibliographicIdentifier | null {
    const identifiers: BibliographicIdentifier = {};
    
    const doi = item.getField('DOI');
    if (doi) identifiers.doi = doi;
    
    const isbn = item.getField('ISBN');
    if (isbn) identifiers.isbn = isbn;

    const issn = item.getField('ISSN');
    if (issn) identifiers.issn = issn;

    const pmid = item.getField('PMID');
    if (pmid) identifiers.pmid = pmid; 

    const pmcid = item.getField('PMCID');
    if (pmcid) identifiers.pmcid = pmcid; 

    const arXivID = item.getField('arXiv ID') || item.getField('arXivID');
    if (arXivID) identifiers.arXivID = arXivID; 
    
    const archiveID = item.getField('archiveID');
    if (archiveID) identifiers.archiveID = archiveID;
    
    return Object.keys(identifiers).length > 0 ? identifiers : null;
}

/**
 * Get the BibTeX cite-key for a Zotero.Item, if available.
 * Tries Better BibTeX, then Zotero beta field citationKey, then Extra.
 *
 * @param {Zotero.Item} item
 * @return {string|null}
 */
async function getCiteKey(item: Zotero.Item): Promise<string | null> {
    // 1. Ensure we actually have an item
    if (!item) return null;

    // 2. If Better BibTeX is present, use its KeyManager API
    if (typeof Zotero !== 'undefined'
        && Zotero.BetterBibTeX
        && Zotero.BetterBibTeX.KeyManager
        && typeof Zotero.BetterBibTeX.KeyManager.get === 'function'
    ) {
        try {
            const keydata = Zotero.BetterBibTeX.KeyManager.get(item.id);
            
            // Handle retry case (when KeyManager isn't ready)
            if (keydata && keydata.retry) {
                // KeyManager not ready, fall through to other methods
            } else if (keydata && keydata.citationKey) {
                return keydata.citationKey;
            }
        }
        catch (e) {
            // Something went wrong in BBT; fall back
            logger('getCiteKey: BetterBibTeX KeyManager failed');
        }
    }

    // 3. Use citationKey field (Zotero beta)
    try {
        const citationKey = item.getField('citationKey');
        if (citationKey) return citationKey;
    } catch (e) {
        // citationKey field might not exist in older Zotero versions
    }

    // 4. Fallback: look for a pinned key in Extra field
    try {
        const extra = item.getField('extra') || '';
        const m = extra.match(/^\s*Citation Key:\s*([^\s]+)/m);
        return m ? m[1] : null;
    } catch (e) {
        logger('getCiteKey: Failed to get extra field');
        return null;
    }
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

interface SyncItem {
    action: 'upsert' | 'delete';
    item: Zotero.Item;
}

/**
 * Syncs an array of Zotero items to the backend in batches
 * 
 * @param syncSessionId Sync session ID
 * @param libraryID Zotero library ID
 * @param items Array of SyncItem objects to sync (upsert or delete)
 * @param syncType Type of sync operation. (optional)
 * @param onStatusChange Optional callback for status updates (in_progress, completed, failed)
 * @param onProgress Optional callback for progress updates (processed, total)
 * @param batchSize Size of item batches to process (default: 50)
 * @returns Total number of successfully processed items
 */
export async function syncItemsToBackend(
    syncSessionId: string,
    libraryID: number,
    items: SyncItem[],
    syncType: 'initial' | 'incremental' | 'consistency' | 'verification',
    syncMethod: 'version' | 'date_modified',
    onStatusChange?: (libraryID: number, status: SyncStatus) => void,
    onProgress?: (libraryID: number, processed: number, total: number) => void,
    batchSize: number = 200,
) {
    const userId = store.get(userIdAtom);
    if (!userId) {
        logger('Beaver Sync:   No user found', 1);
        return;
    }

    const totalItems = items.length;
    let processedCount = 0;
    let syncFailed = false;
    const syncCompleted = false;
    onStatusChange?.(libraryID, 'in_progress');
    
    if (totalItems === 0) {
        logger(`Beaver Sync '${syncSessionId}':   No items to process`, 3);
        onStatusChange?.(libraryID, 'completed');
        if (onProgress) onProgress(libraryID, 0, 0);
        return;
    }
    
    logger(`Beaver Sync '${syncSessionId}':   Processing ${totalItems} items in batches of ${batchSize}`, 3);

    // Get clientDateModified for all items
    const clientDateModifiedMap = await getClientDateModifiedBatch(items.map(item => item.item));
    // Error handling and logging for batch operation
    const missingEntries = items.filter(item => !clientDateModifiedMap.has(item.item.id));
    if (missingEntries.length > 0) {
        logger(`Beaver Sync '${syncSessionId}': Warning: ${missingEntries.length} items missing clientDateModified, using fallback`, 2);
    }
    
    // 1. Sort items
    items.sort((a, b) => {
        // Primary sort: version
        if (a.item.version !== b.item.version) {
            return a.item.version - b.item.version;
        }
        
        // Secondary sort: clientDateModified (convert ISO strings to timestamps)
        const dateAStr = clientDateModifiedMap.get(a.item.id);
        const dateBStr = clientDateModifiedMap.get(b.item.id);
        const dateA = dateAStr ? new Date(dateAStr).getTime() : 0;
        const dateB = dateBStr ? new Date(dateBStr).getTime() : 0;
        return dateA - dateB;
    });

    // 2. Create batches respecting clientDateModifiedMap boundaries
    const batches = createBatches(
        items, 
        batchSize, 
        (item) => clientDateModifiedMap.get(item.item.id) || item.item.dateModified
    );

    // 3. Process each batch
    for (let i = 0; i < batches.length; i++) {
        const batchItems = batches[i];

        // Log batch info for debugging
        const batchDateRange = {
            first: clientDateModifiedMap.get(batchItems[0].item.id),
            last: clientDateModifiedMap.get(batchItems[batchItems.length - 1].item.id),
            versions: [batchItems[0].item.version, batchItems[batchItems.length - 1].item.version]
        };

        logger(`Beaver Sync '${syncSessionId}':   Batch ${i + 1}/${batches.length}: ` +
               `${batchItems.length} items, ` +
               `dates: ${batchDateRange.first} to ${batchDateRange.last}, ` +
               `versions: ${batchDateRange.versions[0]} to ${batchDateRange.versions[1]}`);
        
        try {
            // ------- Transform items in this batch -------
            const regularItems = batchItems.filter(item => item.action === 'upsert' && item.item.isRegularItem()).map(item => item.item);
            const attachmentItems = batchItems.filter(item => item.action === 'upsert' && item.item.isAttachment()).map(item => item.item);
            const itemsToDelete = await Promise.all(batchItems.filter(item => item.action === 'delete').map(item => extractDeleteData(item.item)));
            
            const [batchItemsData, batchAttachmentsData] = await Promise.all([
                Promise.all(regularItems.map((item) => extractItemData(item, clientDateModifiedMap.get(item.id)))).then(data => 
                    data.filter((item) => item !== null) as ItemData[]
                ),
                Promise.all(attachmentItems.map((item) => extractAttachmentData(item, clientDateModifiedMap.get(item.id)))).then(data => 
                    data.filter((att) => att !== null) as AttachmentDataWithMimeType[]
                )
            ]);
            
            const totalItems = batchItemsData.length + batchAttachmentsData.length + itemsToDelete.length;
            if (totalItems === 0) {
                logger(`Beaver Sync '${syncSessionId}':     No items to send to backend`, 4);
                continue;
            }

            // ------- Send to backend only if items need syncing -------
            let attempts = 0;
            const maxAttempts = 2;
            let batchResult = null;
            
            while (attempts < maxAttempts) {
                try {
                    logger(`Beaver Sync '${syncSessionId}':     Sending batch to backend (${totalItems} items, attempt ${attempts + 1}/${maxAttempts})`, 4);
                    batchResult = await syncService.processItemsBatch(
                        syncSessionId,
                        syncType,
                        syncMethod,
                        libraryID,
                        batchItemsData,
                        batchAttachmentsData,
                        itemsToDelete
                    );
                    break; // Success, exit retry loop
                } catch (retryError) {
                    attempts++;
                    if (attempts >= maxAttempts) {
                        throw retryError; // Rethrow if max attempts reached
                    }
                    
                    // Wait before retrying (exponential backoff)
                    const delay = 1000 * Math.pow(2, attempts - 1); // 1s, 2s, 4s
                    logger(`Beaver Sync '${syncSessionId}':     Batch processing attempt ${attempts}/${maxAttempts} failed, retrying in ${delay}ms...`, 2);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
    
            // Process batch result (should never happen)
            if (!batchResult || batchResult.sync_status === 'failed') {
                throw new Error("Failed to process batch after multiple attempts");
            }
            
            // start file uploader if there are attachments to upload
            const countUploads = batchResult.attachments.filter(attachment => attachment.upload_status === 'pending' && attachment.file_hash).length;
            if (countUploads > 0) {                                
                logger(`Beaver Sync '${syncSessionId}':     ${countUploads} attachments need to be uploaded, starting file uploader`, 2);
                await fileUploader.start(syncType === 'initial' ? "initial" : "background");
            }

            // Update progress for this batch
            processedCount += batchItems.length;
            if (onProgress) onProgress(libraryID, processedCount, totalItems);
            
        } catch (error: any) {
            logger(`Beaver Sync '${syncSessionId}':     Error processing batch: ${error.message}`, 1);
            Zotero.logError(error);
            syncFailed = true;
            onStatusChange?.(libraryID, 'failed');
            break;
        }
    }
    if (!syncFailed) {
        logger(`Beaver Sync '${syncSessionId}':   All ${totalItems} items requiring sync were processed; marking as complete.`, 3);
        onStatusChange?.(libraryID, 'completed');
        if (onProgress) onProgress(libraryID, totalItems, totalItems);
    }
}

/**
 * Deletes items from Zotero library
 * @param userId User ID
 * @param libraryID Zotero library ID
 * @param zoteroKeys Zotero keys of items to delete
 */
export const deleteItems = async (userId: string, libraryID: number, zoteroKeys: string[]) => {
    logger(`Beaver Sync: Deleting ${zoteroKeys.length} items from library ${libraryID}`, 3);

    // Delete items from backend
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

/**
 * Performs sync for all libraries
 * @param filterFunction Optional function to filter which items to sync
 * @param batchSize Size of item batches to process (default: 50)
 * @returns Promise resolving when all libraries have been processed
 */
export async function syncZoteroDatabase(
    libraryIds: number[],
    filterFunction: ItemFilterFunction = syncingItemFilter,
    batchSize: number = 50,
    syncType?: 'initial' | 'incremental' | 'consistency' | 'verification'
): Promise<void> {
    const syncSessionId = uuidv4();

    // Get libraries
    const libraries = Zotero.Libraries.getAll();
    const librariesToSync = libraries.filter((library) => libraryIds.includes(library.id));

    // Initialize sync status for all libraries
    for (const libraryID of libraryIds) {
        updateSyncStatus(libraryID, { status: 'in_progress', libraryName: Zotero.Libraries.getName(libraryID) });
    }

    // Get user ID
    const userId = store.get(userIdAtom);
    if (!userId) {
        throw new Error('No user found');
    }

    // On progress callback
    const onProgress = (libraryID: number, processed: number, total: number) => {
        const status = processed >= total ? 'completed' : 'in_progress';
        updateSyncStatus(libraryID, { syncedCount: processed, status });
    };

    // On status change callback for this library
    const onStatusChange = (libraryID: number, status: SyncStatus) => {
        updateSyncStatus(libraryID, { status });
    };

    // Determine sync method
    const syncWithZotero = store.get(syncWithZoteroAtom);
    const syncMethod = syncWithZotero ? 'version' : 'date_modified';

    // Validate sync method for all libraries
    if (syncWithZotero && (!Zotero.Sync.Runner.enabled || !Zotero.Users.getCurrentUserID())) {
        logger(`Beaver Sync '${syncSessionId}': Zotero sync is not enabled. Failing sync...`, 2);
        store.set(addPopupMessageAtom, {
            type: 'warning',
            title: 'Unable to Complete Sync with Beaver',
            text: `Zotero sync is disabled. Please enable Zotero sync in Zotero preferences or sign into your Zotero account.`,
            expire: true
        });
        libraryIds.forEach(libraryID => onStatusChange(libraryID, 'failed'));
        return;
    }
    
    // Sync each library
    for (const library of librariesToSync) {
        const libraryID = library.id;
        const libraryName = library.name;

        try {
            logger(`Beaver Sync '${syncSessionId}': Syncing library ${libraryID} (${libraryName})`, 2);

            // ----- 1. Validate sync method for this library -----
            const isSyncedWithZotero = isLibrarySynced(libraryID);
            if (syncWithZotero && !isSyncedWithZotero) {
                logger(`Beaver Sync '${syncSessionId}':   Library ${libraryID} (${libraryName}) is not synced with Zotero. Failing sync...`, 2);
                onStatusChange(libraryID, 'failed');
                store.set(addPopupMessageAtom, {
                    type: 'warning',
                    title: 'Unable to Complete Sync with Beaver',
                    text: `The library ${libraryName} is not synced with Zotero so Beaver cannot sync it.`,
                    expire: true
                });
                continue;
            }
            
            // ----- 2. Get backend sync status -----
            logger(`Beaver Sync '${syncSessionId}': (1) Get backend sync status (syncMethod: ${syncMethod})`, 3);
            const syncState = await syncService.getSyncState(libraryID, syncMethod);

            const isInitialSync = syncState === null;
            const lastSyncDate = syncState ? Zotero.Date.isoToSQL(syncState.last_sync_date_modified) : null;
            const lastSyncVersion = syncState ? syncState.last_sync_version : null;
            
            // TODO: Transition from local to zotero sync library
            // if (syncState && syncState.last_sync_method === 'date_modified' && syncMethod === 'version') { }
            // if (syncState && syncState.last_sync_method === 'version' && syncMethod === 'date_modified') { }

            logger(`Beaver Sync '${syncSessionId}':   Last sync date: ${lastSyncDate}, last sync version: ${lastSyncVersion}`, 3);

            if(!isInitialSync && syncMethod == 'version' && lastSyncVersion == library.libraryVersion) {
                logger(`Beaver Sync '${syncSessionId}':   Library version up to date (${lastSyncVersion})`, 3);
                updateSyncStatus(libraryID, { status: 'completed' });
                continue;
            }
        
            // ----- 3. Items to sync and delete -----
            logger(`Beaver Sync '${syncSessionId}': (2) Get items to sync and delete`, 3);
            
            let items: Zotero.Item[] = [];
            if (isInitialSync) {
                items = await Zotero.Items.getAll(libraryID, false, false, false);
            } else if (lastSyncVersion !== null && syncMethod === 'version') {
                items = await getItemsSinceVersion(libraryID, lastSyncVersion);
            } else if (lastSyncDate !== null && syncMethod === 'date_modified') {
                items = await getModifiedItems(libraryID, lastSyncDate);
            } else {
                onStatusChange(libraryID, 'failed');
                throw new Error(`Beaver Sync '${syncSessionId}': Invalid sync state: ${syncState}`);
            }

            // Get items to upsert: Included by filter function
            const itemsToUpsert = items
                .filter(filterFunction)
                .map(item => ({
                    action: 'upsert',
                    item
                } as SyncItem));
            
            // Get items to delete: Excluded by filter function
            const itemsToDelete = items
                .filter((_) => !isInitialSync) // Only delete items if not initial sync
                .filter((item) => item.isRegularItem() || item.isPDFAttachment())
                .filter((item) => !filterFunction(item))
                .map(item => ({
                    action: 'delete',
                    item
                } as SyncItem));
            
            // Update library-specific progress and status
            const itemCount = itemsToUpsert.length + itemsToDelete.length;
            const libraryInitialStatus = {
                libraryID,
                libraryName,
                itemCount,
                syncedCount: 0,
                status: 'in_progress'
            } as LibrarySyncStatus;

            logger(`Beaver Sync '${syncSessionId}':   ${itemsToUpsert.length} items to upsert, ${itemsToDelete.length} items to delete`, 3);

            if (itemCount === 0) {
                logger(`Beaver Sync '${syncSessionId}':   Sync complete`, 3);
                updateSyncStatus(libraryID, { ...libraryInitialStatus, status: 'completed' });
                continue;
            }
            updateSyncStatus(libraryID, libraryInitialStatus);

            
            
            // ----- 4. Sync items with backend -----
            logger(`Beaver Sync '${syncSessionId}': (3) Sync items with backend`, 3);
            if(!syncType) syncType = isInitialSync ? 'initial' : 'verification';
            const itemsToSync = [...itemsToUpsert, ...itemsToDelete];
            await syncItemsToBackend(syncSessionId, libraryID, itemsToSync, syncType, syncMethod, onStatusChange, onProgress, batchSize);

            onStatusChange(libraryID, 'completed');
            
        } catch (error: any) {
            logger(`Beaver Sync '${syncSessionId}': Error syncing library ${libraryID} (${libraryName}): ${error.message}`, 1);
            Zotero.logError(error);
            updateSyncStatus(libraryID, { status: 'failed' });
            // Continue with next library even if one fails
        }
    }
        
    logger(`Beaver Sync ${syncSessionId}: Sync completed for all libraries`, 2);
}

/**
 * Gets items that have been modified since a specific date
 * @param libraryID Zotero library ID
 * @param sinceDate Date to check modifications since
 * @param untilDate Date to check modifications until (optional)
 * @returns Promise resolving to array of modified Zotero items
 */
async function getModifiedItems(libraryID: number, sinceDate: string, untilDate?: string): Promise<Zotero.Item[]> {
    // Updated item ids
    let sql = "SELECT itemID FROM items WHERE libraryID=? AND clientDateModified > ?";
    const params: any[] = [libraryID, sinceDate];
    if (untilDate) {
        sql += " AND clientDateModified <= ?";
        params.push(untilDate);
    }
    const ids = await Zotero.DB.columnQueryAsync(sql, params) as number[];
    return await Zotero.Items.getAsync(ids);

    // Deleted item ids
    // let sqlDeleted = "SELECT di.itemID FROM deletedItems di WHERE di.dateDeleted > ?";
    // const paramsDeleted: any[] = [sinceDate];
    // if (untilDate) {
    //     sqlDeleted += " AND di.dateModified <= ?";
    //     paramsDeleted.push(untilDate);
    // }
    // const idsDeleted = await Zotero.DB.columnQueryAsync(sqlDeleted, paramsDeleted) as number[];
    
    // Return items
    // const uniqueIds = [...new Set([...ids, ...idsDeleted])];
    // const items = await Zotero.Items.getAsync(uniqueIds);
    // return items.filter(item => item.libraryID === libraryID);
}

/**
 * Gets items based on version number
 * @param libraryID Zotero library ID
 * @param sinceVersion Zotero version number to check modifications since
 * @param toVersion Zotero version number to check modifications until (optional)
 * @returns Promise resolving to array of Zotero items
 */
async function getItemsSinceVersion(libraryID: number, sinceVersion: number, toVersion?: number): Promise<Zotero.Item[]> {
    let sql = "SELECT itemID FROM items WHERE libraryID=? AND version > ?";
    const params: any[] = [libraryID, sinceVersion];
    if (toVersion) {
        sql += " AND version <= ?";
        params.push(toVersion);
    }
    const ids = await Zotero.DB.columnQueryAsync(sql, params) as number[];
    return await Zotero.Items.getAsync(ids);
}

/**
 * Get IDs of items that were deleted (moved to the trash) after the given
 * library version.
 */
async function getDeletedItemIDsSinceVersion(
    libraryID: number,
    lastSyncLibraryVersion: number
): Promise<number[]> {
    const sql = `
    SELECT i.itemID
    FROM items i
    JOIN deletedItems d USING (itemID)  -- only items that are in the trash
    WHERE i.libraryID = ?
        AND i.version  > ?              -- deleted after last sync
    `;
    return Zotero.DB.columnQueryAsync(sql, [libraryID, lastSyncLibraryVersion]) as Promise<number[]>;
}

/**
 * Get items that were deleted (moved to the trash) after the given
 * library version.
 */
async function getDeletedItemsSinceVersion(
    libraryID: number,
    lastSyncLibraryVersion: number
): Promise<Zotero.Item[]> {
    const ids = await getDeletedItemIDsSinceVersion(libraryID, lastSyncLibraryVersion);
    return Zotero.Items.getAsync(ids);
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
    const itemsToSync = allItems.filter(filterFunction);
    return itemsToSync;
}

/**
 * Discrepancy information for consistency checks
 */
interface ItemDiscrepancy {
    zotero_key: string;
    backend_hash: string;
    local_hash: string;
    backend_version: number;
    local_version: number;
    backend_date_modified: string;
    local_date_modified: string;
    should_update: boolean;
    reason: string;
}

interface AttachmentDiscrepancy {
    zotero_key: string;
    backend_hash: string;
    local_hash: string;
    backend_version: number;
    local_version: number;
    backend_date_modified: string;
    local_date_modified: string;
    should_update: boolean;
    reason: string;
}

interface ConsistencyCheckResult {
    library_id: number;
    total_items_checked: number;
    total_attachments_checked: number;
    item_discrepancies: ItemDiscrepancy[];
    attachment_discrepancies: AttachmentDiscrepancy[];
    items_updated: number;
    attachments_updated: number;
}

/**
 * Performs a consistency check by comparing local and backend metadata hashes
 * @param libraryID Zotero library ID to check
 * @param pageSize Number of items per page for pagination (default: 500)
 * @param sendUpdates Whether to send updates to backend for discrepancies (default: true)
 * @returns Promise resolving to consistency check results
 */
export async function performConsistencyCheck(
    libraryID: number,
    pageSize: number = 500,
    sendUpdates: boolean = true
): Promise<ConsistencyCheckResult> {
    const consistencyId = uuidv4();
    const libraryName = Zotero.Libraries.getName(libraryID);
    
    logger(`Beaver Consistency Check '${consistencyId}': Starting consistency check for library ${libraryID} (${libraryName})`, 2);

    const userId = store.get(userIdAtom);
    if (!userId) {
        logger(`Beaver Consistency Check '${consistencyId}': No user ID found, cannot perform consistency check.`, 1);
        throw new Error('User not authenticated for consistency check');
    }

    const result: ConsistencyCheckResult = {
        library_id: libraryID,
        total_items_checked: 0,
        total_attachments_checked: 0,
        item_discrepancies: [],
        attachment_discrepancies: [],
        items_updated: 0,
        attachments_updated: 0
    };

    let page = 0;
    let hasMore = true;

    // Process all pages from backend
    while (hasMore) {
        try {
            logger(`Beaver Consistency Check '${consistencyId}': Processing page ${page + 1}`, 3);
            
            // Get backend data for this page
            const backendData: SyncDataResponse = await syncService.getSyncData(
                libraryID,
                null, // Get all data, not since a specific version
                null, // Get all data, not until a specific version
                page,
                pageSize
            );

            const { items_state: backendItems, attachments_state: backendAttachments } = backendData;
            
            logger(`Beaver Consistency Check '${consistencyId}': Page ${page + 1}: ${backendItems.length} items, ${backendAttachments.length} attachments`, 4);

            result.total_items_checked += backendItems.length;
            result.total_attachments_checked += backendAttachments.length;

            // Process items concurrently
            const itemProcessingPromises = backendItems.map(async (backendItem) => {
                try {
                    const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, backendItem.zotero_key);
                    if (!zoteroItem) {
                        return { deleteKey: backendItem.zotero_key };
                    }

                    const localItemData = await extractItemData(zoteroItem, undefined);
                    if (backendItem.metadata_hash !== localItemData.item_metadata_hash) {
                        const shouldUpdate = shouldUpdateBackend(
                            backendItem.zotero_version,
                            backendItem.date_modified,
                            zoteroItem.version,
                            await getClientDateModified(zoteroItem)
                        );
                        return {
                            discrepancy: {
                                zotero_key: backendItem.zotero_key,
                                backend_hash: backendItem.metadata_hash,
                                local_hash: localItemData.item_metadata_hash,
                                backend_version: backendItem.zotero_version,
                                local_version: zoteroItem.version,
                                backend_date_modified: backendItem.date_modified,
                                local_date_modified: await getClientDateModified(zoteroItem),
                                should_update: shouldUpdate,
                                reason: shouldUpdate ? 'local version is newer or equal with newer date' : 'backend version is newer',
                            },
                        };
                    }
                } catch (error: any) {
                    logger(`Beaver Consistency Check '${consistencyId}': Error processing item ${backendItem.zotero_key}: ${error.message}`, 1);
                    Zotero.logError(error);
                }
                return null;
            });

            // Process attachments concurrently
            const attachmentProcessingPromises = backendAttachments.map(async (backendAttachment) => {
                try {
                    const zoteroAttachment = Zotero.Items.getByLibraryAndKey(libraryID, backendAttachment.zotero_key);
                    if (!zoteroAttachment) {
                        return { deleteKey: backendAttachment.zotero_key };
                    }

                    const localAttachmentData = await extractAttachmentData(zoteroAttachment, undefined, { lightweight: true });
                    if (localAttachmentData && backendAttachment.metadata_hash !== localAttachmentData.attachment_metadata_hash) {
                        const shouldUpdate = shouldUpdateBackend(
                            backendAttachment.zotero_version,
                            backendAttachment.date_modified,
                            zoteroAttachment.version,
                            await getClientDateModified(zoteroAttachment)
                        );
                        return {
                            discrepancy: {
                                zotero_key: backendAttachment.zotero_key,
                                backend_hash: backendAttachment.metadata_hash,
                                local_hash: localAttachmentData.attachment_metadata_hash,
                                backend_version: backendAttachment.zotero_version,
                                local_version: zoteroAttachment.version,
                                backend_date_modified: backendAttachment.date_modified,
                                local_date_modified: await getClientDateModified(zoteroAttachment),
                                should_update: shouldUpdate,
                                reason: shouldUpdate ? 'local version is newer or equal with newer date' : 'backend version is newer',
                            },
                        };
                    }
                } catch (error: any) {
                    logger(`Beaver Consistency Check '${consistencyId}': Error processing attachment ${backendAttachment.zotero_key}: ${error.message}`, 1);
                    Zotero.logError(error);
                }
                return null;
            });

            const [itemResults, attachmentResults] = await Promise.all([
                Promise.all(itemProcessingPromises),
                Promise.all(attachmentProcessingPromises),
            ]);

            // Collate results
            const itemsToDelete = itemResults.map(r => r?.deleteKey).filter((k): k is string => !!k);
            result.item_discrepancies.push(...itemResults.map(r => r?.discrepancy).filter((d): d is ItemDiscrepancy => !!d));
            
            const attachmentsToDelete = attachmentResults.map(r => r?.deleteKey).filter((k): k is string => !!k);
            result.attachment_discrepancies.push(...attachmentResults.map(r => r?.discrepancy).filter((d): d is AttachmentDiscrepancy => !!d));

            // Log discrepancies
            result.item_discrepancies.forEach(d => logger(`Beaver Consistency Check '${consistencyId}': Item discrepancy found for ${d.zotero_key}: ${d.reason}`, 2));
            result.attachment_discrepancies.forEach(d => logger(`Beaver Consistency Check '${consistencyId}': Attachment discrepancy found for ${d.zotero_key}: ${d.reason}`, 2));

            // Delete items from backend that don't exist locally
            const allKeysToDelete = [...itemsToDelete, ...attachmentsToDelete];
            if (allKeysToDelete.length > 0) {
                logger(`Beaver Consistency Check '${consistencyId}': ${allKeysToDelete.length} items not found locally, deleting from backend.`, 3);
                try {
                    await deleteItems(userId, libraryID, allKeysToDelete);
                } catch (error: any) {
                    logger(`Beaver Consistency Check '${consistencyId}': Failed to delete items from backend: ${error.message}`, 1);
                    Zotero.logError(error);
                }
            }

            // Send updates to backend if requested and discrepancies found
            if (sendUpdates && (result.item_discrepancies.length > 0 || result.attachment_discrepancies.length > 0)) {
                logger(`Beaver Consistency Check '${consistencyId}': Sending updates to backend for discrepancies`, 3);
                
                try {
                    const itemsToUpdate = result.item_discrepancies
                        .filter(d => d.should_update)
                        .map(d => d.zotero_key);
                    
                    const attachmentsToUpdate = result.attachment_discrepancies
                        .filter(d => d.should_update)
                        .map(d => d.zotero_key);

                    if (itemsToUpdate.length > 0 || attachmentsToUpdate.length > 0) {
                        // Get the actual items to send
                        const itemsToSync: SyncItem[] = [];
                        
                        // Add regular items
                        for (const key of itemsToUpdate) {
                            const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
                            if (item && item.isRegularItem()) {
                                itemsToSync.push({ action: 'upsert', item });
                            }
                        }
                        
                        // Add attachments
                        for (const key of attachmentsToUpdate) {
                            const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
                            if (item && item.isAttachment()) {
                                itemsToSync.push({ action: 'upsert', item });
                            }
                        }

                        const syncWithZotero = store.get(syncWithZoteroAtom);
                        const syncMethod = syncWithZotero ? 'version' : 'date_modified';

                        // Add items to delete
                        // TODO: Add items to delete

                        if (itemsToSync.length > 0) {
                            await syncItemsToBackend(
                                consistencyId,
                                libraryID,
                                itemsToSync,
                                'consistency',
                                syncMethod
                            );
                            
                            result.items_updated = itemsToUpdate.length;
                            result.attachments_updated = attachmentsToUpdate.length;
                        }
                    }
                } catch (error: any) {
                    logger(`Beaver Consistency Check '${consistencyId}': Error sending updates: ${error.message}`, 1);
                    Zotero.logError(error);
                }
            }

            // Log summary
            logger(`Beaver Consistency Check '${consistencyId}': Completed`, 2);
            logger(`Beaver Consistency Check '${consistencyId}': Checked ${result.total_items_checked} items, ${result.total_attachments_checked} attachments`, 3);
            logger(`Beaver Consistency Check '${consistencyId}': Found ${result.item_discrepancies.length} item discrepancies, ${result.attachment_discrepancies.length} attachment discrepancies`, 3);
            if (sendUpdates) {
                logger(`Beaver Consistency Check '${consistencyId}': Updated ${result.items_updated} items, ${result.attachments_updated} attachments`, 3);
            }

            hasMore = backendData.has_more;
            page++;
            
        } catch (error: any) {
            logger(`Beaver Consistency Check '${consistencyId}': Error processing page ${page + 1}: ${error.message}`, 1);
            Zotero.logError(error);
            break;
        }
    }

    return result;
}

/**
 * Determines whether the backend should be updated based on version and date comparison
 * @param backendVersion Backend version number
 * @param backendDate Backend date modified (ISO string)
 * @param localVersion Local version number
 * @param localDate Local date modified (SQL datetime string)
 * @returns true if backend should be updated
 */
function shouldUpdateBackend(
    backendVersion: number,
    backendDate: string,
    localVersion: number,
    localDate: string
): boolean {
    // Local version is newer
    if (localVersion > backendVersion) {
        return true;
    }
    
    // Same version, check date
    if (localVersion === backendVersion) {
        const backendTime = new Date(backendDate).getTime();
        const localTime = new Date(localDate + 'Z').getTime(); // Add Z for UTC
        return localTime >= backendTime;
    }
    
    // Backend version is newer
    return false;
}

