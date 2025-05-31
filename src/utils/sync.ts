import { syncService } from '../services/syncService';
import { SyncStatus } from '../../react/atoms/ui';
import { fileUploader } from '../services/FileUploader';
import { calculateObjectHash } from './hash';
import { logger } from './logger';
import { ItemRecord, AttachmentRecord } from '../services/database';
import { userAtom } from "../../react/atoms/auth";
import { store } from "../../react/index";
import { getPref, setPref } from './prefs';
import { librariesSyncStatusAtom, LibrarySyncStatus } from '../../react/atoms/sync';
import { ZoteroCreator, ItemDataHashedFields, ItemData, BibliographicIdentifier, ZoteroCollection, AttachmentDataHashedFields, AttachmentData } from '../../react/types/zotero';

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
    return (item.isRegularItem() || item.isPDFAttachment() || item.isImageAttachment() && !item.isInTrash());
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
 * @returns Promise resolving to AttachmentData object for syncing
 */
async function extractAttachmentData(item: Zotero.Item): Promise<AttachmentData | null> {
    // 1. Extract File Data (can be null)
    const fileData = await extractFileData(item);
    if (!fileData) return null;

    // 2. Prepare the object containing only fields for hashing
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

    // ------- 3. Calculate hash from the prepared hashed fields object -------
    const metadataHash = await calculateObjectHash(hashedFields);

    // ------- 4. Construct final AttachmentData object -------
    const attachmentData: AttachmentData = {
        ...hashedFields,
        // Add non-hashed fields
        date_added: new Date(item.dateAdded + 'Z').toISOString(),
        date_modified: new Date(item.dateModified + 'Z').toISOString(),
        ...(fileData || {}),
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
    const user = store.get(userAtom);
    if (!user) {
        logger('Beaver Sync: No user found', 1);
        return;
    }
    
    const totalItems = items.length;
    onStatusChange?.('in_progress');
    
    // ------- PHASE 1: Transform and filter ALL items upfront -------
    logger(`Beaver Sync: Transforming and filtering ${totalItems} items...`, 3);
    
    // Transform all items to our format
    const regularItems = items.filter(item => item.isRegularItem());
    const attachmentItems = items.filter(item => item.isAttachment());
    
    const [allItemsData, allAttachmentsData] = await Promise.all([
        Promise.all(regularItems.map(extractItemData)).then(data => 
            data.filter((item) => item !== null) as ItemData[]
        ),
        Promise.all(attachmentItems.map(extractAttachmentData)).then(data => 
            data.filter((att) => att !== null) as AttachmentData[]
        )
    ]);
    
    logger(`Beaver Sync: Transformed ${allItemsData.length} items and ${allAttachmentsData.length} attachments`, 4);
    
    // Get local database records
    const [allItemsDB, allAttachmentsDB] = await Promise.all([
        allItemsData.length > 0
            ? Zotero.Beaver.db.getItemsByZoteroKeys(user.id, libraryID, allItemsData.map(item => item.zotero_key))
            : Promise.resolve([]),
        allAttachmentsData.length > 0
            ? Zotero.Beaver.db.getAttachmentsByZoteroKeys(user.id, libraryID, allAttachmentsData.map(att => att.zotero_key))
            : Promise.resolve([])
    ]);
    
    // Filter out items that haven't changed
    const itemsDBMap = new Map(allItemsDB.map(item => [item.zotero_key, item]));
    const attachmentsDBMap = new Map(allAttachmentsDB.map(att => [att.zotero_key, att]));

    const itemsNeedingSync = allItemsData.filter((item) => {
        const itemDB = itemsDBMap.get(item.zotero_key);
        if (!itemDB) return true;
        return itemDB.item_metadata_hash !== item.item_metadata_hash;
    });

    const attachmentsNeedingSync = allAttachmentsData.filter((att) => {
        const attDB = attachmentsDBMap.get(att.zotero_key);
        if (!attDB) return true;
        return attDB.attachment_metadata_hash !== att.attachment_metadata_hash;
    });
    
    const totalNeedingSync = itemsNeedingSync.length + attachmentsNeedingSync.length;
    const totalFiltered = (allItemsData.length - itemsNeedingSync.length) + 
                          (allAttachmentsData.length - attachmentsNeedingSync.length);
    
    logger(`Beaver Sync: ${totalNeedingSync} items need syncing, ${totalFiltered} filtered out (no changes)`, 3);
    
    // If nothing needs syncing, mark as completed
    if (totalNeedingSync === 0) {
        logger(`Beaver Sync: All items up to date, marking as completed`, 3);
        onStatusChange?.('completed');
        if (onProgress) onProgress(totalItems, totalItems);
        return;
    }

    // ------- PHASE 2: Process filtered items in batches -------
    // Set initial progress to 0 for items needing sync before starting batch processing
    if (onProgress) {
        onProgress(0, totalItems);
    }
    logger(`Beaver Sync: Processing ${totalNeedingSync} items in batches of ${batchSize}`, 3);
    
    let syncId = undefined;
    let processedCount = 0;
    let syncCompleted = false;
    let syncFailed = false;
    
    interface ProcessableItem {
        type: 'item' | 'attachment';
        data: ItemData | AttachmentData;
    }

    const itemsToProcess: ProcessableItem[] = [
        ...itemsNeedingSync.map(item => ({ type: 'item' as const, data: item })),
        ...attachmentsNeedingSync.map(att => ({ type: 'attachment' as const, data: att }))
    ];
    
    for (let i = 0; i < itemsToProcess.length; i += batchSize) {
        const batchItems = itemsToProcess.slice(i, i + batchSize);
        const batchItemsData = batchItems.filter(item => item.type === 'item').map(item => item.data) as ItemData[];
        const batchAttachmentsData = batchItems.filter(item => item.type === 'attachment').map(item => item.data) as AttachmentData[];
        
        const createLog = !syncId;
        const closeLog = i + batchSize >= itemsToProcess.length;
        
        logger(`Beaver Sync: Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(itemsToProcess.length/batchSize)} (${batchItemsData.length} items, ${batchAttachmentsData.length} attachments)`, 4);
        
        try {
            // Send batch to backend
            let attempts = 0;
            const maxAttempts = 3;
            let batchResult = null;
            
            while (attempts < maxAttempts) {
                try {
                    logger(`Beaver Sync: Sending batch to backend (${batchItemsData.length} items, ${batchAttachmentsData.length} attachments, attempt ${attempts + 1}/${maxAttempts})`, 4);
                    batchResult = await syncService.processItemsBatch(
                        libraryID,
                        batchItemsData,
                        batchAttachmentsData,
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
    
            // Process batch result
            if (!batchResult) {
                throw new Error("Failed to process batch after multiple attempts");
            }
            
            syncId = batchResult.sync_id;
            if (batchResult.sync_status === 'failed') {
                onStatusChange?.('failed');
                const error = new Error(`Beaver Sync: Batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(itemsToProcess.length/batchSize)} failed. Failed keys: ${batchResult.failed_keys}`);
                Zotero.logError(error);
                throw new Error("Syncing status is failed");
            }

            // Update database items
            if (batchResult.items.length > 0) {
                logger(`Beaver Sync: Updating local database items`, 2);
                const items = batchResult.items.map(item => ({
                    library_id: item.library_id,
                    zotero_key: item.zotero_key,
                    item_metadata_hash: item.metadata_hash
                }));
                await Zotero.Beaver.db.upsertItemsBatch(user.id, items);
            }

            // Update database attachments and add items to upload queue
            if (batchResult.attachments.length > 0) {
                // Update database attachments
                logger(`Beaver Sync: Updating local database attachments`, 2);
                const attachments = batchResult.attachments.map(attachment => ({
                    library_id: attachment.library_id,
                    zotero_key: attachment.zotero_key,
                    attachment_metadata_hash: attachment.metadata_hash,
                    file_hash: attachment.file_hash,
                    upload_status: attachment.upload_status || 'pending',
                }));
                await Zotero.Beaver.db.upsertAttachmentsBatch(user.id, attachments);
                
                // Add items to upload queue
                // TODO: Check on file size and page count limits here! Set status to 'skipped' if not meeting limits
                const uploadQueueItems = batchResult.attachments
                    .filter(attachment => attachment.needs_upload)
                    .map(attachment => ({
                        file_hash: attachment.file_hash,
                        user_id: user.id,
                        // page_count
                        // file_size
                        library_id: attachment.library_id,
                        zotero_key: attachment.zotero_key,
                    }));
                logger(`Beaver Sync: Adding ${uploadQueueItems.length} items to upload queue`, 2);
                await Zotero.Beaver.db.upsertQueueItemsBatch(user.id, uploadQueueItems);

                // Start file uploader if there are attachments to upload
                logger(`Beaver Sync: Starting file uploader`, 2);
                await fileUploader.start(syncType === 'initial' ? "initial" : "background");
            }

            // Update progress based on items that actually needed syncing
            const batchProcessed = batchItems.length;
            processedCount += batchProcessed;
            
            // Report progress against total items that needed syncing
            if (onProgress) {
                // Convert back to original item count for UI consistency
                const overallProgress = Math.round((processedCount / totalNeedingSync) * totalItems);
                onProgress(Math.min(overallProgress, totalItems), totalItems);
            }
            
            // Track if sync was completed in this batch
            if (closeLog && batchResult.sync_status === 'completed') {
                syncCompleted = true;
                onStatusChange?.('completed');
                if (onProgress) {
                    onProgress(totalItems, totalItems);
                }
            }
        } catch (error: any) {
            logger(`Beaver Sync: Error processing batch: ${error.message}`, 1);
            Zotero.logError(error);
            syncFailed = true;
            onStatusChange?.('failed');
            break;
        }
    }
    
    // Only complete sync if we have a syncId, didn't complete, AND didn't fail
    if (syncId && !syncCompleted && !syncFailed) {
        try {
            logger(`Beaver Sync: Completing sync ${syncId} after processing all batches`, 3);
            await syncService.completeSync(syncId);
            onStatusChange?.('completed');
            if (onProgress) {
                onProgress(totalItems, totalItems);
            }
        } catch (error: any) {
            logger(`Beaver Sync: Error completing sync: ${error.message}`, 1);
            onStatusChange?.('failed'); // ← Set failed status if completion fails
        }
    } else if (!syncId && !syncFailed && processedCount === totalNeedingSync && totalItems > 0 && totalNeedingSync > 0) {
        // SCENARIO: All items that needed syncing were processed successfully,
        // but no backend sync session was established (possibly because backend 
        // determined no server-side changes were needed).
        // This is a valid completion state.
        logger(`Beaver Sync: All ${totalNeedingSync} items requiring sync were processed; no backend sync session established or required for this set, and no errors occurred. Marking as complete.`, 3);
        onStatusChange?.('completed');
        if (onProgress) {
            onProgress(totalItems, totalItems);
        }
    }
}

/**
 * Updates the library-specific sync status atom
 * @param libraryID Zotero library ID
 * @param updates Partial LibrarySyncStatus object containing only the fields to update
 */
const updateLibrarySyncStatus = (libraryID: number, updates: Partial<LibrarySyncStatus>) => {
    // Update the library-specific status atom
    store.set(librariesSyncStatusAtom, (current) => ({
        ...current,
        [libraryID]: {
            ...(current[libraryID] || {}),
            ...updates,
            libraryID
        }
    }));

    setPref('selectedLibrary', JSON.stringify(store.get(librariesSyncStatusAtom)));
};

/*
 * Ensures that the library sync status is completed
 * @param libraryID Zotero library ID
 */
const ensureCompletionOfLibrarySyncStatus = async (libraryID: number) => {
    const current = store.get(librariesSyncStatusAtom);
    const library = current[libraryID];

    // If the library is not found, create a new library sync status
    // (should never happen)
    if (!library) {
        logger(`Beaver Sync: Library ${libraryID} not found, creating new library sync status`, 1);
        const itemsToSync = await getItemsToSync(libraryID);
        const newStatus: LibrarySyncStatus = {
            libraryID,
            libraryName: Zotero.Libraries.getName(libraryID),
            itemCount: itemsToSync.length,
            syncedCount: itemsToSync.length,
            status: 'completed'
        };
        updateLibrarySyncStatus(libraryID, newStatus);
    }

    // If the library is found, but not completed, update the library sync status to completed
    if (library.status !== 'completed' || library.syncedCount < library.itemCount) {
        const newStatus: Partial<LibrarySyncStatus> = {
            ...library,
            status: 'completed',
            syncedCount: library.itemCount,
        };
        updateLibrarySyncStatus(libraryID, newStatus);
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
    onStatusChange?: (status: SyncStatus) => void,
    onProgress?: (processed: number, total: number) => void,
    batchSize: number = 50
): Promise<any> {
    try {
        const library = Zotero.Libraries.get(libraryID);
        if (!library) {
            logger(`Beaver Sync: Library ${libraryID} not found`, 1);
            return;
        }
        const libraryName = library.name;
        logger(`Beaver Sync: Starting initial sync for library ${libraryID} (${libraryName})`, 2);
    
        // 1. Get all items from the library
        const itemsToSync = await getItemsToSync(libraryID);
        const totalItems = itemsToSync.length;
        logger(`Beaver Sync: Found ${totalItems} items to sync for library ${libraryID} (${libraryName})`, 3);

        // 2. Update library-specific sync status atom
        const libraryInitialStatus = {
            libraryID,
            libraryName,
            itemCount: totalItems,
            syncedCount: 0,
            status: 'in_progress'
        } as LibrarySyncStatus;
        
        if (totalItems === 0) {
            logger(`Beaver Sync: No items to sync for library ${libraryID} (${libraryName})`, 3);
            updateLibrarySyncStatus(libraryID, { ...libraryInitialStatus, status: 'completed' });
            return { status: 'completed', message: 'No items to sync' };
        }
        
        updateLibrarySyncStatus(libraryID, libraryInitialStatus);

        // Add custom progress callback that updates library-specific progress
        const librarySpecificProgress = (processed: number, total: number) => {
            const status = processed >= total ? 'completed' : 'in_progress';
            updateLibrarySyncStatus(libraryID, { syncedCount: processed, status });
            
            // Also call the original progress callback if provided
            if (onProgress) {
                onProgress(processed, total);
            }
        };

        // Add custom status change callback
        const librarySpecificStatusChange = (status: SyncStatus) => {
            updateLibrarySyncStatus(libraryID, { status });
            if (onStatusChange) {
                onStatusChange(status);
            }
        };

        // Replace the syncItemsToBackend call with:
        await syncItemsToBackend(
            libraryID, 
            itemsToSync, 
            'initial', 
            librarySpecificStatusChange, 
            librarySpecificProgress, 
            batchSize
        );
        
    } catch (error: any) {
        logger('Beaver Sync: Error during initial sync: ' + error.message, 1);
        Zotero.logError(error);
        updateLibrarySyncStatus(libraryID, { status: 'failed' });
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
        logger(`Beaver Sync: Starting periodic sync from ${lastSyncDate} for library ${libraryID} (${libraryName})`, 2);
    
        // 1. Get all items modified since last sync
        const modifiedItems = await getModifiedItemsSince(libraryID, lastSyncDate);
        
        // 2. Filter items based on criteria
        const itemsToSync = modifiedItems.filter(filterFunction);
        const totalItems = itemsToSync.length;
        
        logger(`Beaver Sync: Found ${totalItems} modified items to sync since ${lastSyncDate} from library "${libraryName}"`, 3);
        
        if (totalItems === 0) {
            onStatusChange?.('completed');
            logger('Beaver Sync: No items to sync, skipping sync operation', 3);
            return { status: 'completed', message: 'No items to sync' };
        }
        
        // 3. Process items in batches
        await syncItemsToBackend(libraryID, itemsToSync, 'verification', onStatusChange, onProgress, batchSize);
        
    } catch (error: any) {
        logger('Beaver Sync: Error during periodic sync: ' + error.message, 1);
        Zotero.logError(error);
        throw error;
    }
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
    filterFunction: ItemFilterFunction = syncingItemFilter,
    batchSize: number = 50,
    onStatusChange?: (status: SyncStatus) => void,
    onProgress?: (processed: number, total: number) => void
): Promise<void> {
    // Get the selected libraries from the preferences
    const selectedLibraries = JSON.parse(getPref("selectedLibrary") || "{}");
    const libraries = Zotero.Libraries.getAll();
    const librariesToSync = libraries.filter((library) => selectedLibraries[library.libraryID]);
    
    // Now perform actual syncs for each library
    for (const library of librariesToSync) {
        const libraryID = library.id;
        const libraryName = library.name;
        
        try {
            logger(`Beaver Sync: Syncing library ${libraryID} (${libraryName})`, 3);
        
            // Get the last sync date for this library
            const response = await syncService.getLastSyncDate(libraryID);
            const lastSyncDate = response.last_sync_date;
            
            // Perform initial sync if no previous sync date is found, otherwise perform periodic sync
            if (!lastSyncDate) {
                await performInitialSync(libraryID, onStatusChange, onProgress, batchSize);
            } else {
                // Mark initial sync as complete
                ensureCompletionOfLibrarySyncStatus(libraryID);
                // Perform periodic sync
                await performPeriodicSync(libraryID, lastSyncDate, filterFunction, onStatusChange, onProgress, batchSize);
            }
        } catch (error: any) {
            logger(`Beaver Sync Error: Error syncing library ${libraryID} (${libraryName}): ${error.message}`, 1);
            Zotero.logError(error);
            // Continue with next library even if one fails
        }
    }
        
    logger('Beaver Sync: Sync completed for all libraries', 2);
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

/**
 * Gets all library items to sync
 * @param libraryID Zotero library ID
 * @param filterFunction Optional function to filter which items to sync
 * @returns Promise resolving to array of modified Zotero items
 */
export async function getItemsToSync(
    libraryID: number,
    filterFunction: ItemFilterFunction = syncingItemFilter
): Promise<Zotero.Item[]> {
    const allItems = await Zotero.Items.getAll(libraryID, false, false, false);
    const itemsToSync = allItems.filter(filterFunction);
    return itemsToSync;
}
