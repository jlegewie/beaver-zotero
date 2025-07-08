import { syncService, ItemSyncState } from '../services/syncService';
import { SyncStatus } from '../../react/atoms/ui';
import { fileUploader } from '../services/FileUploader';
import { calculateObjectHash } from './hash';
import { logger } from './logger';
import { userIdAtom } from "../../react/atoms/auth";
import { store } from "../../react/index";
import { initialSyncStatusAtom, LibrarySyncStatus } from '../../react/atoms/sync';
import { ZoteroCreator, ItemDataHashedFields, ItemData, BibliographicIdentifier, ZoteroCollection, AttachmentDataHashedFields, AttachmentData, ZoteroLibrary } from '../../react/types/zotero';
import { SyncState } from '../services/database';

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
    return (item.isRegularItem() || item.isPDFAttachment() || item.isImageAttachment()) && !item.isInTrash() && (collectionId ? item.inCollection(collectionId) : true);
};

/**
 * Extracts relevant data from a Zotero item for syncing, including a metadata hash.
 * @param item Zotero item
 * @returns Promise resolving to ItemData object for syncing
 */
async function extractItemData(item: Zotero.Item): Promise<ItemData> {

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
        date_added: new Date(item.dateAdded + 'Z').toISOString(), // Convert UTC SQL datetime format to ISO string
        date_modified: new Date(item.dateModified + 'Z').toISOString(), // Convert UTC SQL datetime format to ISO string
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
async function extractAttachmentData(item: Zotero.Item, options?: { lightweight?: boolean }): Promise<AttachmentData | null> {

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
        deleted: item.isInTrash(),
        title: item.getField('title'),
        filename: item.attachmentFilename,
    };

    // 3. Metadata Hash: Calculate hash from the prepared hashed fields object
    const metadataHash = await calculateObjectHash(hashedFields);

    // 4. AttachmentData: Construct final AttachmentData object
    const attachmentData: AttachmentData = {
        ...hashedFields,
        // Add non-hashed fields
        file_hash: file_hash,
        date_added: new Date(item.dateAdded + 'Z').toISOString(),
        date_modified: new Date(item.dateModified + 'Z').toISOString(),
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

/**
 * Determines if an item needs to be synced to the backend
 * @param item ItemData or AttachmentData
 * @param currentHash Current hash of the item
 * @param syncState SyncState of the item
 * @returns True if the item needs to be synced, false otherwise
 */
function needsSync(currentVersion: number, currentHash: string, syncState: SyncState | undefined): boolean {
    // Sync if we've never seen this item (doesn't exist in backend)
    if (!syncState) return true;
    
    // Always sync items if the version is higher
    if (currentVersion > syncState.zotero_version) {
        return true;
    }
    
    // If version is the same, use hash comparison to determine if it needs to be synced
    // This covers two cases:
    // 1. The user has no zotero account. zotero_version is always 0 (and item.synced is always false)
    // 2. The item has changed but not yet synced with Zotero (version only updates after zotero sync is complete)
    //    (We will sync item again in a later sync session)
    if (currentVersion === syncState.zotero_version && currentHash !== syncState.metadata_hash) {
        return true;
    }
    
    return false;
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
 * @param useLocalHashFilter If true, filter items by local database hash (default: false)
 * @returns Total number of successfully processed items
 */
export async function syncItemsToBackend(
    libraryID: number,
    items: Zotero.Item[],
    syncType: 'initial' | 'incremental' | 'consistency' | 'verification',
    onStatusChange?: (status: SyncStatus) => void,
    onProgress?: (processed: number, total: number) => void,
    batchSize: number = 200,
    // TODO: THIS SHOULD BE REMOVED FOR NEW SYNC PROCESS (update local DB first, sync second)
    useLocalHashFilter: boolean = true
) {
    const userId = store.get(userIdAtom);
    if (!userId) {
        logger('Beaver Sync: No user found', 1);
        return;
    }
    
    const totalItems = items.length;
    onStatusChange?.('in_progress');
    
    if (totalItems === 0) {
        logger(`Beaver Sync: No items to process`, 3);
        onStatusChange?.('completed');
        if (onProgress) onProgress(0, 0);
        return;
    }

    logger(`Beaver Sync: Processing ${totalItems} items in batches of ${batchSize}`, 3);
    
    let syncId = undefined;
    let overallProcessedCount = 0;
    let syncCompleted = false;
    let syncFailed = false;
    let totalItemsSentToBackend = 0;
    
    for (let i = 0; i < items.length; i += batchSize) {
        const batchItems = items.slice(i, i + batchSize);
        
        logger(`Beaver Sync: Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(items.length/batchSize)} (${batchItems.length} items)`, 4);
        
        try {
            // ------- Transform items in this batch -------
            const regularItems = batchItems.filter(item => item.isRegularItem());
            const attachmentItems = batchItems.filter(item => item.isAttachment());
            
            const [batchItemsData, batchAttachmentsData] = await Promise.all([
                Promise.all(regularItems.map(extractItemData)).then(data => 
                    data.filter((item) => item !== null) as ItemData[]
                ),
                Promise.all(attachmentItems.map((item) => extractAttachmentData(item))).then(data => 
                    data.filter((att) => att !== null) as AttachmentData[]
                )
            ]);
            
            // ------- Filter items that need syncing in this batch -------
            let itemsNeedingSync: ItemData[] = [];
            let attachmentsNeedingSync: AttachmentData[] = [];
            
            if (useLocalHashFilter) {
                // ------- Get database records for this batch -------
                const [batchItemsSyncState, batchAttachmentsSyncState] = await Promise.all([
                    batchItemsData.length > 0
                        ? Zotero.Beaver.db.getItemSyncState(userId, libraryID, batchItemsData.map(item => item.zotero_key))
                        : Promise.resolve([]),
                    batchAttachmentsData.length > 0
                        ? Zotero.Beaver.db.getAttachmentSyncState(userId, libraryID, batchAttachmentsData.map(att => att.zotero_key))
                        : Promise.resolve([])
                ]);
                
                // ------- Filter items that need syncing in this batch -------
                const itemsSyncStateMap = new Map(batchItemsSyncState.map(item => [item.zotero_key, item]));
                const attachmentsSyncStateMap = new Map(batchAttachmentsSyncState.map(att => [att.zotero_key, att]));

                itemsNeedingSync = batchItemsData.filter((item) => {
                    const syncState = itemsSyncStateMap.get(item.zotero_key);
                    return needsSync(item.zotero_version, item.item_metadata_hash, syncState);
                });
            
                attachmentsNeedingSync = batchAttachmentsData.filter((att) => {
                    const syncState = attachmentsSyncStateMap.get(att.zotero_key);
                    return needsSync(att.zotero_version, att.attachment_metadata_hash, syncState);
                });

            } else {
                itemsNeedingSync = batchItemsData;
                attachmentsNeedingSync = batchAttachmentsData;
            }

            const batchNeedingSync = itemsNeedingSync.length + attachmentsNeedingSync.length;
            const batchFiltered = (batchItemsData.length - itemsNeedingSync.length) + 
                                  (batchAttachmentsData.length - attachmentsNeedingSync.length);
            
            logger(`Beaver Sync: Batch ${Math.floor(i/batchSize) + 1}: ${batchNeedingSync} items need syncing, ${batchFiltered} filtered out (no changes)`, 4);
            
            // ------- Send to backend only if items need syncing -------
            if (batchNeedingSync > 0) {
                const createLog = !syncId;
                const closeLog = i + batchSize >= items.length; // Close if this is the last batch
                
                let attempts = 0;
                const maxAttempts = 1;
                let batchResult = null;
                
                while (attempts < maxAttempts) {
                    try {
                        logger(`Beaver Sync: Sending batch to backend (${itemsNeedingSync.length} items, ${attachmentsNeedingSync.length} attachments, attempt ${attempts + 1}/${maxAttempts})`, 4);
                        batchResult = await syncService.processItemsBatch(
                            libraryID,
                            itemsNeedingSync,
                            attachmentsNeedingSync,
                            syncType,
                            createLog,
                            closeLog,
                            syncId
                        );
                        break; // Success, exit retry loop
                    } catch (retryError) {
                        attempts++;
                        if (attempts >= maxAttempts) {
                            throw retryError; // Rethrow if max attempts reached
                        }
                        
                        // Wait before retrying (exponential backoff)
                        const delay = 1000 * Math.pow(2, attempts - 1); // 1s, 2s, 4s
                        logger(`Beaver Sync: Batch processing attempt ${attempts}/${maxAttempts} failed, retrying in ${delay}ms...`, 2);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
        
                // Process batch result (should never happen)
                if (!batchResult || batchResult.sync_status === 'failed') {
                    throw new Error("Failed to process batch after multiple attempts");
                }
                
                // Set sync ID from batch result
                syncId = batchResult.sync_id;
                
                // Update database items
                if (batchResult.items.length > 0) {
                    logger(`Beaver Sync: Updating local database items`, 2);
                    const items = batchResult.items.map(item => ({
                        library_id: item.library_id,
                        zotero_key: item.zotero_key,
                        item_metadata_hash: item.metadata_hash,
                        zotero_version: item.zotero_version,
                        zotero_synced: item.zotero_synced,
                    }));
                    await Zotero.Beaver.db.upsertItemsBatch(userId, items);
                }

                // Update database attachments and add items to upload queue
                if (batchResult.attachments.length > 0) {
                    // Update database attachments
                    logger(`Beaver Sync: Updating local database attachments`, 2);
                    const attachmentsForDB = batchResult.attachments.map(attachment => ({
                        library_id: attachment.library_id,
                        zotero_key: attachment.zotero_key,
                        attachment_metadata_hash: attachment.metadata_hash,
                        zotero_version: attachment.zotero_version,
                        zotero_synced: attachment.zotero_synced,
                        file_hash: attachment.file_hash,
                        upload_status: attachment.upload_status || 'pending',
                    }));
                    await Zotero.Beaver.db.upsertAttachmentsBatch(userId, attachmentsForDB);

                    // Add items to upload queue
                    const uploadQueueItems = batchResult.attachments
                        .filter(attachment => {
                            return attachment.upload_status === 'pending' && attachment.file_hash;
                        })
                        .map(attachment => ({
                            file_hash: attachment.file_hash!,
                            library_id: attachment.library_id,
                            zotero_key: attachment.zotero_key,
                        }));
                    
                    if (uploadQueueItems.length > 0) {
                        // Deduplicate uploadQueueItems by file_hash, keeping the first occurrence
                        const uniqueUploadQueueItemsMap = new Map();
                        uploadQueueItems.forEach(item => {
                            if (!uniqueUploadQueueItemsMap.has(item.file_hash)) {
                                uniqueUploadQueueItemsMap.set(item.file_hash, item);
                            }
                        });
                        const uniqueUploadQueueItems = Array.from(uniqueUploadQueueItemsMap.values());

                        logger(`Beaver Sync: Adding/updating ${uniqueUploadQueueItems.length} items in upload queue (after deduplication)`, 2);
                        await Zotero.Beaver.db.upsertQueueItemsBatch(userId, uniqueUploadQueueItems);

                        // Start file uploader if there are attachments to upload (or newly added to queue)
                        logger(`Beaver Sync: Starting file uploader`, 2);
                        await fileUploader.start(syncType === 'initial' ? "initial" : "background");
                    }
                }

                totalItemsSentToBackend += batchNeedingSync;
                
                // Track if sync was completed in this batch
                if (closeLog && batchResult.sync_status === 'completed') {
                    syncCompleted = true;
                    onStatusChange?.('completed');
                }
            }
            
            // Update progress for this batch
            overallProcessedCount += batchItems.length;
            if (onProgress) {
                onProgress(overallProcessedCount, totalItems);
            }
            
        } catch (error: any) {
            logger(`Beaver Sync: Error processing batch: ${error.message}`, 1);
            Zotero.logError(error);
            syncFailed = true;
            onStatusChange?.('failed');
            break;
        }
    }
    
    // Handle completion logic
    if (totalItemsSentToBackend === 0 && !syncFailed) {
        // No items needed syncing
        logger(`Beaver Sync: All items up to date, marking as completed`, 3);
        onStatusChange?.('completed');
        if (onProgress) onProgress(totalItems, totalItems);
    } else if (syncId && !syncCompleted && !syncFailed) {
        // Complete sync if we have a syncId but didn't complete yet
        try {
            logger(`Beaver Sync: Completing sync ${syncId} after processing all batches`, 3);
            await syncService.completeSync(syncId);
            onStatusChange?.('completed');
            if (onProgress) {
                onProgress(totalItems, totalItems);
            }
        } catch (error: any) {
            logger(`Beaver Sync: Error completing sync: ${error.message}`, 1);
            onStatusChange?.('failed');
        }
    } else if (!syncId && !syncFailed && overallProcessedCount === totalItems && totalItems > 0 && totalItemsSentToBackend > 0) {
        // All items processed successfully but no backend sync session was established
        logger(`Beaver Sync: All ${totalItemsSentToBackend} items requiring sync were processed; no backend sync session established or required for this set, and no errors occurred. Marking as complete.`, 3);
        onStatusChange?.('completed');
        if (onProgress) {
            onProgress(totalItems, totalItems);
        }
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

    // Update local database
    const allKeys = [...response.items.map(a => a.zotero_key), ...response.attachments.map(a => a.zotero_key)];
    if(allKeys.length > 0) await Zotero.Beaver.db.deleteByLibraryAndKeys(userId, libraryID, allKeys);
}

/**
 * Updates the initial sync status for a library
 * @param libraryID Zotero library ID
 * @param updates Partial LibrarySyncStatus object containing only the fields to update
 */
const updateInitialSyncStatus = (libraryID: number, updates: Partial<LibrarySyncStatus>) => {
    store.set(initialSyncStatusAtom, (current) => ({
        ...current,
        [libraryID]: {
            ...(current[libraryID] || {}),
            ...updates,
            libraryID
        }
    }));
};

/*
 * Ensures that the library sync status is completed
 * @param libraryID Zotero library ID
 */
const markInitialSyncAsComplete = async (libraryID: number) => {
    logger(`Beaver Sync: Marking initial sync as complete for library ${libraryID}`, 2);
    updateInitialSyncStatus(libraryID, { status: 'completed' });
}

/**
 * Syncs the local DB with the backend
 * @param libraryId Zotero library ID
 * @param updateSinceLibraryVersion Version to sync from (null for full sync)
 * @param pageSize Size of page to sync (default: 500)
 * @returns Promise resolving when sync is complete
 */
const syncLocalDBWithBackend = async (
    userId: string,
    libraryId: number,
    updateSinceLibraryVersion: number | null = null,
    toLibraryVersion: number | null = null,
    pageSize: number = 500
) => {
    let page = 0;
    
    while (true) {
        logger(`Beaver Sync: Fetching sync data page ${page} for library ${libraryId}`, 4);
        
        const sync_data = await syncService.getSyncData(libraryId, updateSinceLibraryVersion, toLibraryVersion, page, pageSize);
        const { items_state, attachments_state, has_more } = sync_data;

        // Update local DB with sync data
        if (items_state.length > 0) {
            logger(`Beaver Sync: Populating local DB with ${items_state.length} up-to-date items from page ${page}`, 3);
            const itemsForDB = items_state.map(item => ({
                library_id: libraryId,
                zotero_key: item.zotero_key,
                item_metadata_hash: item.metadata_hash,
                zotero_version: item.zotero_version,
                zotero_synced: item.zotero_synced
            }));
            await Zotero.Beaver.db.upsertItemsBatch(userId, itemsForDB);
        }

        if (attachments_state.length > 0) {
            logger(`Beaver Sync: Populating local DB with ${attachments_state.length} up-to-date attachments from page ${page}`, 3);
            const attachmentsForDB = attachments_state.map(attachment => ({
                library_id: libraryId,
                zotero_key: attachment.zotero_key,
                attachment_metadata_hash: attachment.metadata_hash,
                zotero_version: attachment.zotero_version,
                zotero_synced: attachment.zotero_synced,
                file_hash: attachment.file_hash,
                upload_status: attachment.upload_status,
            }));
            await Zotero.Beaver.db.upsertAttachmentsBatch(userId, attachmentsForDB);
        }

        // If there are more items to sync, continue to next page
        if (!has_more) break;
        
        page++;
    }
    
    logger(`Beaver Sync: Completed syncing local DB with backend for library ${libraryId} (${page + 1} pages processed)`, 3);
}

/**
 * Get items to delete from Zotero library
 * 
 * Item to delete are based on the following criteria:
 * - Item doesn't fit syncing criteria anymore (e.g. is in trash)
 * - Item sync state exist indicating that has been synced with Beaver backend
 * 
 * @param userId User ID
 * @param libraryID Zotero library ID
 * @param items Items to delete
 * @returns Items to delete
 */
const getItemsToDelete = async (userId: string, libraryID: number, items: Zotero.Item[]): Promise<Zotero.Item[]> => {
    const allZoteroKeys = await Zotero.Beaver.db.getAllZoteroKeys(userId, libraryID);
    return items.filter(item => allZoteroKeys.includes(item.key));
}

/**
 * Performs initial or periodic sync for all libraries
 * @param filterFunction Optional function to filter which items to sync
 * @param batchSize Size of item batches to process (default: 50)
 * @param onStatusChange Optional callback for status updates (in_progress, completed, failed)
 * @param onProgress Optional callback for progress updates (processed, total)
 * @returns Promise resolving when all libraries have been processed
 */
export async function syncZoteroDatabase(
    libraryIds: number[],
    filterFunction: ItemFilterFunction = syncingItemFilter,
    batchSize: number = 50,
    onStatusChange?: (status: SyncStatus) => void,
    onProgress?: (processed: number, total: number) => void
): Promise<void> {
    // Get libraries
    const libraries = Zotero.Libraries.getAll();
    const librariesToSync = libraries.filter((library) => libraryIds.includes(library.id));

    // Initialize sync status for all libraries
    for (const libraryID of libraryIds) {
        updateInitialSyncStatus(libraryID, { status: 'in_progress', libraryName: Zotero.Libraries.getName(libraryID) });
    }

    // Get user ID
    const userId = store.get(userIdAtom);
    if (!userId) {
        throw new Error('No user found');
    }
    
    // Now perform actual syncs for each library
    for (const library of librariesToSync) {
        const libraryID = library.id;
        const libraryName = library.name;
        
        try {
            logger(`Beaver Sync: Syncing library ${libraryID} (${libraryName})`, 2);
            
            // ----- 1. Update local DB with sync state from backend -----
            logger(`Beaver Sync: (1) Update local DB with sync state from backend`, 3);

            // a. Get last synced library version
            logger(`Beaver Sync: a. Get last synced library state from local DB`, 3);
            const localDBState = await Zotero.Beaver.db.getLibrarySyncState(userId, libraryID);
            const initialSync = localDBState === null;
            const lastSyncLibraryVersion = localDBState?.last_synced_version || null;
            const lastSyncDate = localDBState?.last_synced_date || null;
            logger(`Beaver Sync:    lastSyncLibraryVersion: ${lastSyncLibraryVersion}, lastSyncDate: ${lastSyncDate}`, 3);

            // b. Call backend to check state
            logger(`Beaver Sync: b. Call backend to determine whether local DB needs to be updated`, 3);
            const {
                pull_required: pullRequired,
                backend_library_version: beaverLibraryVersion
            } = await syncService.getSyncState(libraryID, lastSyncLibraryVersion);
            logger(`Beaver Sync:    pull_required: ${pullRequired}, beaverLibraryVersion: ${beaverLibraryVersion}`, 3);

            // c. Update local DB based on sync_response
            switch (pullRequired) {
                
                // No sync needed
                case 'none':
                    break;
                    
                // Frontend needs to pull all data from backend
                case 'full':
                case 'delta': {
                    logger(`Beaver Sync: c. Syncing local DB with backend for library ${libraryID}`, 3);
                    const updateSinceLibraryVersion = pullRequired === 'full' ? null : (lastSyncLibraryVersion || null);
                    await syncLocalDBWithBackend(userId, libraryID, updateSinceLibraryVersion, beaverLibraryVersion);
                    break;
                }
            }

            // Update local DB with sync backend library version
            await Zotero.Beaver.db.updateLibrarySyncState(userId, libraryID, {
                last_synced_version: beaverLibraryVersion
            });

            // At this point, the local DB is up to date with the backend library version

            // ----- 2. Items to sync and delete -----
            logger(`Beaver Sync: (2) Get items to sync and delete`, 3);
            const syncDate = Zotero.Date.dateToSQL(new Date(), true);
            
            // a. Get modified items (based on version or dateModified)
            let items: Zotero.Item[] = [];
            if (initialSync) {
                // For initial sync, get all items
                items = await Zotero.Items.getAll(libraryID, false, false, false);
            } else {
                // For periodic sync, get items that have changed since last sync
                const itemsVersionChanged = await getItemsSinceVersion(libraryID, beaverLibraryVersion);
                const itemsModified = lastSyncDate ? await getModifiedItems(libraryID, lastSyncDate, syncDate, beaverLibraryVersion) : [];
                items = Array.from(
                    new Map([...itemsVersionChanged, ...itemsModified].map(item => [item.key, item])).values()
                );
            }

            // b. Get items to sync: Included by filter function
            const itemsToSync = items.filter(filterFunction);
            
            // c. Get items to delete: Excluded by filter function and in local DB
            const allZoteroKeys = await Zotero.Beaver.db.getAllZoteroKeys(userId, libraryID);
            const itemsToDelete = items
                .filter((item) => !filterFunction(item))
                .filter(item => allZoteroKeys.includes(item.key))
            
            // ----- 3. Sync items with backend -----
            logger(`Beaver Sync: (3) Sync items with backend`, 3);
            await syncItemsToBackend(libraryID, itemsToSync, 'consistency', onStatusChange, onProgress, batchSize);
            await deleteItems(userId, libraryID, itemsToDelete.map(item => item.key));
            
            // Update local DB with last sync date after sync is complete
            await Zotero.Beaver.db.updateLibrarySyncState(userId, libraryID, {
                last_synced_date: syncDate
            });
            
        } catch (error: any) {
            logger(`Beaver Sync Error: Error syncing library ${libraryID} (${libraryName}): ${error.message}`, 1);
            Zotero.logError(error);
            updateInitialSyncStatus(libraryID, { status: 'failed' });
            // Continue with next library even if one fails
        }
    }
        
    logger('Beaver Sync: Sync completed for all libraries', 2);
}

/**
 * Gets items that have been modified since a specific date
 * @param libraryID Zotero library ID
 * @param sinceDate Date to check modifications since
 * @param untilDate Date to check modifications until (optional)
 * @param maxVersion Maximum version number to include (optional)
 * @returns Promise resolving to array of modified Zotero items
 */
async function getModifiedItems(libraryID: number, sinceDate: string, untilDate?: string | null, maxVersion?: number | null): Promise<Zotero.Item[]> {
    let sql = "SELECT itemID FROM items WHERE libraryID=? AND dateModified > ?";
    const params: any[] = [libraryID, sinceDate];
    if (untilDate) {
        sql += " AND dateModified < ?";
        params.push(untilDate);
    }
    if (maxVersion) {
        sql += " AND version <= ?";
        params.push(maxVersion);
    }
    const ids = await Zotero.DB.columnQueryAsync(sql, params) as number[];
    return await Zotero.Items.getAsync(ids);
}

/**
 * Gets items based on version number
 * @param libraryID Zotero library ID
 * @param sinceVersion Zotero version number to check modifications since
 * @returns Promise resolving to array of Zotero items
 */
async function getItemsSinceVersion(libraryID: number, sinceVersion: number): Promise<Zotero.Item[]> {
    const sql = "SELECT itemID FROM items WHERE libraryID=? AND version > ?";
    const ids = await Zotero.DB.columnQueryAsync(sql, [libraryID, sinceVersion]) as number[];
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

