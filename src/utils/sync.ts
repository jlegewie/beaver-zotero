import { syncService, DeleteLibraryTask } from '../services/syncService';
import { fileUploader } from '../services/FileUploader';
import { calculateObjectHash } from './hash';
import { logger } from './logger';
import { userIdAtom } from "../../react/atoms/auth";
import { store } from "../../react/store";
import { syncStatusAtom, LibrarySyncStatus, SyncStatus, SyncType } from '../../react/atoms/sync';
import { ZoteroCreator, ItemDataHashedFields, ItemData, BibliographicIdentifier, ZoteroCollection, AttachmentDataHashedFields, DeleteData, AttachmentDataWithMimeType, ZoteroItemReference } from '../../react/types/zotero';
import { getMimeType, isLibrarySynced, getClientDateModified, getClientDateModifiedBatch, getZoteroUserIdentifier, getCollectionClientDateModifiedAsISOString, getParentLoadPromises } from './zoteroUtils';
import { v4 as uuidv4 } from 'uuid';
import { addPopupMessageAtom } from '../../react/utils/popupMessageUtils';
import { syncWithZoteroAtom } from '../../react/atoms/profile';
import { SyncMethod } from '../../react/atoms/sync';
import { SyncLogsRecord } from '../services/database';
import { isAttachmentOnServer, getFileHashes } from './webAPI';
import { getServerOnlyAttachmentCount } from './libraries';
import { skippedItemsManager } from '../services/skippedItemsManager';

const NEEDS_HASH = '[needs_hash]';
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
    if (item.isInTrash()) return false;
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
        date_modified: await getClientDateModified(item)
        // date_modified: await getClientDateModifiedAsISOString(item)
    };
}

/**
 * Extracts relevant data from a Zotero item for syncing, including a metadata hash.
 * @param item Zotero item
 * @returns Promise resolving to ItemData object for syncing
 */
export async function extractItemData(item: Zotero.Item, clientDateModified: string | undefined): Promise<ItemData> {

    // ------- 1. Get full item data -------
    // @ts-ignore - Returns of item.toJSON are not typed correctly
    const {abstractNote, key, libraryID, itemType, deleted, dateAdded, dateModified, accessDate, creators, collections, tags, version, ...fullItemData } = item.toJSON();

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
        language: item.getField('language'),
        formatted_citation: Zotero.Beaver.citationService.formatBibliography(item) ?? '',
        deleted: item.isInTrash(),
        tags: item.getTags().length > 0 ? item.getTags() : null,
        collections: extractCollectionKeys(item),
        citation_key: await getCiteKey(item),
    };

    // ------- 3. Calculate hash from the extracted hashed fields -------
    const metadataHash = await calculateObjectHash(hashedFields);

    // ------- 4. Construct final ItemData object -------
    let finalDateModified: string;
    if (clientDateModified) {
        finalDateModified = clientDateModified;
    } else {
        try {
            // Fallback to dateModified if clientDateModified was invalid
            finalDateModified = Zotero.Date.sqlToISO8601(item.dateModified);
        } catch (e) {
            logger(
                `Beaver Sync: Invalid clientDateModified and dateModified for item ${item.key}. Falling back to dateAdded.`,
                2,
            );
            // As a last resort, use dateAdded
            finalDateModified = Zotero.Date.sqlToISO8601(item.dateAdded);
        }
    }

    const itemData: ItemData = {
        ...hashedFields,
        // Add full item data
        item_json: fullItemData,
        // Add non-hashed fields
        date_added: Zotero.Date.sqlToISO8601(item.dateAdded), // Convert UTC SQL datetime format to ISO string
        date_modified: finalDateModified,
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
export async function extractAttachmentData(
    item: Zotero.Item,
    clientDateModified: string | undefined,
    options?: { skipFileHash?: boolean }
): Promise<AttachmentDataWithMimeType | null> {
    const skipFileHash = options?.skipFileHash || false;

    // 1. File: Confirm that the item is an attachment and passes the syncing filter (exists locally or on server)
    if (!item.isAttachment() || !(await syncingItemFilterAsync(item))) {
        if(item.isAttachment()) skippedItemsManager.upsert(item, 'not available locally or on server');
        return null;
    }
    
    // 2. Get the file hash
    let file_hash: string = '';
    let needs_hash: boolean = false;

    // Determine local availability
    const existsLocal = await item.fileExists();
    const existsServer = isAttachmentOnServer(item);

    // Get the file hash
    if (!skipFileHash) {
        // Hash from local file
        if(existsLocal) {
            file_hash = await item.attachmentHash;
        
        // Hash from server
        } else if (existsServer) {
            needs_hash = true;
        }
    }

    if (!file_hash && !needs_hash && !skipFileHash) {
        // TODO: silent failure for example when user doesn't sync and local file was removed
        logger(`Beaver Sync: Attachment ${item.key} unavailable (local: ${existsLocal}, server: ${existsServer}). Skipping.`, 1);
        skippedItemsManager.upsert(item, 'not available locally or on server');
        return null;
    }

    // 2. Metadata: Prepare the object containing only fields for hashing
    const hashedFields: AttachmentDataHashedFields = {
        library_id: item.libraryID,
        zotero_key: item.key,
        parent_key: item.parentKey || null,
        attachment_url: item.getField('url'),
        link_mode: item.attachmentLinkMode,
        tags: item.getTags().length > 0 ? item.getTags() : null,
        collections: extractCollectionKeys(item),
        deleted: item.isInTrash(),
        title: item.getField('title'),
        filename: item.attachmentFilename,
    };

    // 3. Metadata Hash: Calculate hash from the prepared hashed fields object
    const metadataHash = await calculateObjectHash(hashedFields);

    let finalDateModified: string;
    if (clientDateModified) {
        finalDateModified = clientDateModified;
    } else {
        try {
            // Fallback to dateModified if clientDateModified was invalid
            finalDateModified = Zotero.Date.sqlToISO8601(item.dateModified);
        } catch (e) {
            logger(
                `Beaver Sync: Invalid clientDateModified and dateModified for item ${item.key}. Falling back to dateAdded.`,
                2,
            );
            // As a last resort, use dateAdded
            finalDateModified = Zotero.Date.sqlToISO8601(item.dateAdded);
        }
    }

    // 4. AttachmentData: Construct final AttachmentData object (with optional placeholder flag)
    const attachmentData: AttachmentDataWithMimeType = {
        ...hashedFields,
        // Add non-hashed fields
        file_hash: needs_hash ? NEEDS_HASH : file_hash,
        mime_type: await getMimeType(item),
        date_added: Zotero.Date.sqlToISO8601(item.dateAdded),
        date_modified: finalDateModified,
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
export function extractPrimaryCreators(item: Zotero.Item): ZoteroCreator[] {
    const itemCreators = item.getCreators();
    const primaryCreatorTypeID = Zotero.CreatorTypes.getPrimaryIDForType(item.itemTypeID);
    return itemCreators
        .filter(creator => creator.creatorTypeID == primaryCreatorTypeID)
        .map(creator => ({
            first_name: creator.firstName || null,
            last_name: creator.lastName || null,
            field_mode: creator.fieldMode,
            creator_type_id: creator.creatorTypeID,
            creator_type: Zotero.CreatorTypes.getName(creator.creatorTypeID),
            is_primary: creator.creatorTypeID === primaryCreatorTypeID
        } as ZoteroCreator));
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

/**
 * Extracts collections from a Zotero item
 * @param item Zotero item
 * @returns Array of collections
 */
async function extractCollections(item: Zotero.Item): Promise<ZoteroCollection[] | null> {
    const collectionPromises = item.getCollections()
        .map(async (collection_id) => {
            const collection = Zotero.Collections.get(collection_id).toJSON();
            return {
                library_id: item.libraryID,
                zotero_key: collection.key,
                name: collection.name,
                version: collection.version,
                date_modified: await getCollectionClientDateModifiedAsISOString(collection_id),
                parent_collection: collection.parentCollection || null,
                relations: Object.keys(collection.relations).length > 0 ? collection.relations : null,
            } as ZoteroCollection;
        })
    const collections = await Promise.all(collectionPromises);

    return collections.length > 0 ? collections : null;
}

/**
 * Extracts data from a Zotero collection for syncing
 * @param collection Zotero collection
 * @param clientDateModified Optional pre-fetched clientDateModified
 * @returns Promise resolving to ZoteroCollection object for syncing
 */
export async function extractCollectionData(
    collection: Zotero.Collection,
    clientDateModified?: string
): Promise<ZoteroCollection> {
    const collectionJSON = collection.toJSON();
    
    let finalDateModified: string;
    if (clientDateModified) {
        finalDateModified = clientDateModified;
    } else {
        try {
            finalDateModified = await getCollectionClientDateModifiedAsISOString(collection.id);
        } catch (e) {
            logger(`Beaver Sync: Invalid clientDateModified for collection ${collection.key}. Falling back to current timestamp.`, 2);
            finalDateModified = new Date().toISOString();
        }
    }

    return {
        library_id: collection.libraryID,
        zotero_key: collection.key,
        name: collection.name,
        version: collection.version,
        date_modified: finalDateModified,
        parent_collection: collectionJSON.parentCollection || null,
        relations: Object.keys(collectionJSON.relations).length > 0 ? collectionJSON.relations : null,
    } as ZoteroCollection;
}

/**
 * Extracts collection keys from a Zotero item
 * @param item Zotero item
 * @returns Array of collection keys
 */
function extractCollectionKeys(item: Zotero.Item): string[] | null {
    const collectionKeys = item.getCollections().map(id => Zotero.Collections.get(id).key);
    return collectionKeys.length > 0 ? collectionKeys : null;
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

export interface SyncItem {
    action: 'upsert' | 'delete';
    item: Zotero.Item;
}

export interface SyncCollection {
    action: 'upsert' | 'delete';
    collection: Zotero.Collection;
}

/**
 * Syncs an array of Zotero items and collections to the backend in batches
 * 
 * @param syncSessionId Sync session ID
 * @param libraryID Zotero library ID
 * @param items Array of SyncItem objects to sync (upsert or delete)
 * @param collections Array of SyncCollection objects to sync
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
    collections: SyncCollection[],
    syncType: SyncType,
    syncMethod: SyncMethod,
    onStatusChange?: (libraryID: number, status: SyncStatus, errorMessage?: string) => void,
    onProgress?: (libraryID: number, processed: number, totalForLibrary: number) => void,
    batchSize: number = 100,
) {
    const userId = store.get(userIdAtom);
    if (!userId) {
        logger('Beaver Sync:   No user found', 1);
        return;
    }

    const totalItemsForLibrary = items.length + collections.length;
    let processedCount = 0;
    let syncFailed = false;
    let lastError: any = null;
    const syncCompleted = false;
    onStatusChange?.(libraryID, 'in_progress');
    
    if (totalItemsForLibrary === 0) {
        logger(`Beaver Sync '${syncSessionId}':   No items or collections to process`, 3);
        onStatusChange?.(libraryID, 'completed');
        if (onProgress) onProgress(libraryID, 0, 0);
        return;
    }
    
    logger(`Beaver Sync '${syncSessionId}':   Processing ${items.length} items and ${collections.length} collections in batches of ${batchSize}`, 3);

    // Get clientDateModified for all items
    const clientDateModifiedMap = await getClientDateModifiedBatch(items.map(item => item.item));
    // Error handling and logging for batch operation
    const missingEntries = items.filter(item => !clientDateModifiedMap.has(item.item.id));
    if (missingEntries.length > 0) {
        logger(`Beaver Sync '${syncSessionId}': Warning: ${missingEntries.length} items missing clientDateModified, using fallback`, 2);
    }
    
    // Get clientDateModified for all collections
    const collectionDateMap = new Map<number, string>();
    for (const syncCollection of collections) {
        try {
            const dateModified = await getCollectionClientDateModifiedAsISOString(syncCollection.collection.id);
            collectionDateMap.set(syncCollection.collection.id, dateModified);
        } catch (e) {
            logger(`Beaver Sync '${syncSessionId}': Warning: Could not get clientDateModified for collection ${syncCollection.collection.id}`, 2);
            collectionDateMap.set(syncCollection.collection.id, new Date().toISOString());
        }
    }
    
    // 1. Sort items by version and date
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

    // 2. Sort collections by version and date
    collections.sort((a, b) => {
        // Primary sort: version
        if (a.collection.version !== b.collection.version) {
            return a.collection.version - b.collection.version;
        }
        
        // Secondary sort: clientDateModified
        const dateAStr = collectionDateMap.get(a.collection.id);
        const dateBStr = collectionDateMap.get(b.collection.id);
        const dateA = dateAStr ? new Date(dateAStr).getTime() : 0;
        const dateB = dateBStr ? new Date(dateBStr).getTime() : 0;
        return dateA - dateB;
    });

    // 3. Create batches respecting clientDateModifiedMap boundaries
    const batches = createBatches(
        items,
        batchSize,
        (item) => {
            const clientDate = clientDateModifiedMap.get(item.item.id);
            if (clientDate) {
                return clientDate;
            }
            // Fallback for items with invalid clientDateModified
            try {
                return Zotero.Date.sqlToISO8601(item.item.dateModified);
            } catch (e) {
                logger(
                    `Beaver Sync '${syncSessionId}': Could not parse dateModified '${item.item.dateModified}' for item ${item.item.id}. Using epoch for batching.`,
                    2,
                );
                return new Date(0).toISOString();
            }
        },
    );

    // Track skipped items
    const skippedItems: ZoteroItemReference[] = [];
    
    // Track which collections have been processed
    let collectionIndex = 0;

    // 4. Process each batch
    for (let i = 0; i < batches.length; i++) {
        const batchItems = batches[i];

        // Determine the max version and date for this batch
        const batchMaxVersion = Math.max(...batchItems.map(item => item.item.version));
        const batchMaxDate = clientDateModifiedMap.get(batchItems[batchItems.length - 1].item.id) || new Date(0).toISOString();

        // Log batch info for debugging
        const batchDateRange = {
            first: clientDateModifiedMap.get(batchItems[0].item.id),
            last: batchMaxDate,
            versions: [batchItems[0].item.version, batchMaxVersion]
        };
        
        try {
            // ------- Transform items in this batch -------
            const regularItems = batchItems
                .filter(item => item.action === 'upsert' && item.item.isRegularItem())
                .map(item => item.item);

            const attachmentItems = batchItems
                .filter(item => item.action === 'upsert' && item.item.isAttachment())
                .map(item => item.item);

            const itemsToDelete = await Promise.all(
                batchItems.filter(item => item.action === 'delete')
                    .map(item => extractDeleteData(item.item))
            );
            
            // ------- Extract collection data for this batch -------
            // Include collections with version <= batchMaxVersion AND date <= batchMaxDate
            const batchCollections: SyncCollection[] = [];
            while (collectionIndex < collections.length) {
                const collection = collections[collectionIndex];
                const collectionVersion = collection.collection.version;
                const collectionDate = collectionDateMap.get(collection.collection.id) || new Date(0).toISOString();
                
                // Check if this collection should be in this batch
                // Use syncMethod to determine which comparison to use
                const shouldInclude = syncMethod === 'version' 
                    ? collectionVersion <= batchMaxVersion
                    : collectionDate <= batchMaxDate;
                
                if (shouldInclude) {
                    batchCollections.push(collection);
                    collectionIndex++;
                } else {
                    // This collection belongs in a later batch
                    break;
                }
            }
            
            // Extract collection data
            const batchCollectionsData: ZoteroCollection[] = await Promise.all(
                batchCollections.map(c => extractCollectionData(c.collection, collectionDateMap.get(c.collection.id)))
            );

            logger(`Beaver Sync '${syncSessionId}':   Batch ${i + 1}/${batches.length}: ` +
                   `${batchItems.length} items, ${batchCollectionsData.length} collections, ` +
                   `dates: ${batchDateRange.first} to ${batchDateRange.last}, ` +
                   `versions: ${batchDateRange.versions[0]} to ${batchDateRange.versions[1]}`);
            
            // Extract item and attachment data
            const [batchItemsData, tempBatchAttachmentsData] = await Promise.all([
                // Items
                Promise.all(
                    regularItems.map((item) =>
                        extractItemData(item, clientDateModifiedMap.get(item.id))
                    )
                ).then(data => data.filter((item) => item !== null) as ItemData[]),
                // Attachments
                Promise.all(attachmentItems.map((item) =>
                    extractAttachmentData(item, clientDateModifiedMap.get(item.id)))
                ).then(data => 
                    data.filter((att) => att !== null) as AttachmentDataWithMimeType[]
                )
            ]);
            let batchAttachmentsData = tempBatchAttachmentsData

            // ------- Fetch file hashes for attachments that need them -------
            const attachmentsNeedingHashes = batchAttachmentsData.filter(
                att => att && att.file_hash === NEEDS_HASH
            );
            const attachmentsWithHashes = batchAttachmentsData.filter(
                att => att && att.file_hash !== NEEDS_HASH,
            );

            if (attachmentsNeedingHashes.length > 0) {
                const updatedAttachments = await fetchRemoteFileHashes(
                    attachmentsNeedingHashes as AttachmentDataWithMimeType[],
                    syncSessionId
                );

                // Filter for attachments where a hash was successfully found
                const successfullyUpdated = updatedAttachments.filter(
                    (att) => att.file_hash !== NEEDS_HASH
                );

                // Track skipped items
                const itemsWithMissingHash = updatedAttachments.filter(
                    (att) => att.file_hash === NEEDS_HASH
                );
                if (itemsWithMissingHash.length > 0) {
                    logger(`Beaver Sync '${syncSessionId}':     Failed to fetch file hashes for ${itemsWithMissingHash.length} attachments`, 1);
                    const itemReferences = itemsWithMissingHash.map(att => ({
                        zotero_key: att.zotero_key,
                        library_id: att.library_id,
                    } as ZoteroItemReference));
                    skippedItemsManager.batchUpsert(itemReferences, 'Failed to fetch file hashes from server');
                    skippedItems.push(...itemReferences);
                }

                // Recombine the lists
                batchAttachmentsData = [...attachmentsWithHashes, ...successfullyUpdated];
            }

            // Count total items
            const totalItems = batchItemsData.length + batchAttachmentsData.length + itemsToDelete.length + batchCollectionsData.length;
            if (totalItems === 0) {
                logger(`Beaver Sync '${syncSessionId}':     No items to send to backend`, 4);
                continue;
            }

            // ------- Send to backend only if items need syncing -------
            const { userID: zoteroUserId, localUserKey } = getZoteroUserIdentifier();

            let attempts = 0;
            const maxAttempts = 2;
            let batchResult = null;
            
            while (attempts < maxAttempts) {
                try {
                    logger(`Beaver Sync '${syncSessionId}':     Sending batch to backend (${batchItemsData.length} items, ${batchAttachmentsData.length} attachments, ${batchCollectionsData.length} collections, ${itemsToDelete.length} deletions, attempt ${attempts + 1}/${maxAttempts})`, 4);

                    // Upsert items, attachments, and collections
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
                        itemsToDelete
                    );

                    // Insert sync log into local database
                    await Zotero.Beaver.db.insertSyncLog({
                        session_id: syncSessionId,
                        sync_type: syncType,
                        method: syncMethod,
                        zotero_local_id: localUserKey,
                        zotero_user_id: zoteroUserId || null,
                        library_id: libraryID,
                        total_upserts: batchResult.total_upserts,
                        total_deletions: batchResult.total_deletions,
                        library_version: batchResult.library_version,
                        library_date_modified: batchResult.library_date_modified,
                        user_id: userId,
                    } as SyncLogsRecord);

                    logger(`Beaver Sync '${syncSessionId}':     Batch result: ${JSON.stringify(batchResult)}`, 4);

                    // Success, exit retry loop
                    break;
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
            if (!batchResult) {
                throw new Error("Failed to process batch after multiple attempts");
            }
            
            // start file uploader if there are attachments to upload
            if (batchResult.pending_uploads > 0) {                                
                logger(`Beaver Sync '${syncSessionId}':     ${batchResult.pending_uploads} attachments need to be uploaded, starting file uploader`, 2);
                await fileUploader.start(syncType === 'initial' ? "initial" : "background");
            }

            // Update progress for this batch
            processedCount += batchItems.length;
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
        if (skippedItems.length/ totalItemsForLibrary > 0.05) {
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


interface SyncZoteroDatabaseOptions {
    filterFunction?: ItemFilterFunction;
    batchSize?: number;
    syncType?: SyncType;
    resetSyncStatus?: boolean;
}

/**
 * Performs sync for all libraries
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
    const libraries = Zotero.Libraries.getAll();
    const librariesToSync = libraries.filter((library) => libraryIds.includes(library.libraryID));

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
    const syncWithZotero = store.get(syncWithZoteroAtom);
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

            if (syncLog) {
                const { itemsToUpsert, itemsToDelete, collectionsToSync } = await getItemsToSync(
                    libraryID,
                    false,
                    syncMethod,
                    syncLog.library_date_modified,
                    syncLog.library_version,
                    filterFunction
                );

                if (itemsToUpsert.length === 0 && itemsToDelete.length === 0 && collectionsToSync.length === 0) {
                    logger(`Beaver Sync '${syncSessionId}':   Library ${libraryID} (${libraryName}) is up to date based on local sync log. (${syncMethod}: ${syncLog.library_date_modified}, ${syncLog.library_version})`, 3);
                    updateSyncStatus(libraryID, { status: 'completed' });
                    continue;
                }
            }
            
            // ----- 2. Get backend sync status -----
            logger(`Beaver Sync '${syncSessionId}': (1) Get backend sync status (syncMethod: ${syncMethod})`, 3);
            const syncState = await syncService.getSyncState(libraryID, syncMethod);

            const isInitialSync = syncState === null;
            const lastSyncDate = syncState ? Zotero.Date.isoToSQL(syncState.last_sync_date_modified) : null;
            const lastSyncVersion = syncState ? syncState.last_sync_version : null;
            
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
        
            // ----- 3. Items to sync and delete -----
            logger(`Beaver Sync '${syncSessionId}': (2) Get items to sync and delete`, 3);
            
            const { itemsToUpsert, itemsToDelete, collectionsToSync } = await getItemsToSync(
                libraryID,
                isInitialSync,
                syncMethod,
                lastSyncDate,
                lastSyncVersion,
                filterFunction
            );
            
            // Update library-specific progress and status
            const itemCount = itemsToUpsert.length + itemsToDelete.length + collectionsToSync.length;
            const libraryInitialStatus = {
                libraryID,
                libraryName,
                itemCount,
                syncedCount: 0,
                status: 'in_progress',
                syncType: derivedSyncType
            } as LibrarySyncStatus;

            logger(`Beaver Sync '${syncSessionId}':   ${itemsToUpsert.length} items to upsert, ${itemsToDelete.length} items to delete, ${collectionsToSync.length} collections to sync`, 3);

            if (itemCount === 0) {
                logger(`Beaver Sync '${syncSessionId}':   Sync complete`, 3);
                updateSyncStatus(libraryID, { ...libraryInitialStatus, status: 'completed' });
                continue;
            }
            updateSyncStatus(libraryID, libraryInitialStatus);

            // ----- 4. Sync items with backend -----
            logger(`Beaver Sync '${syncSessionId}': (3) Sync items with backend`, 3);
            const itemsToSync = [...itemsToUpsert, ...itemsToDelete];
            await syncItemsToBackend(syncSessionId, libraryID, itemsToSync, collectionsToSync, derivedSyncType, syncMethod, onStatusChange, onProgress, batchSize);

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


async function getItemsToSync(
    libraryID: number,
    isInitialSync: boolean,
    syncMethod: SyncMethod,
    lastSyncDate: string | null,
    lastSyncVersion: number | null,
    filterFunction: ItemFilterFunction
): Promise<{ itemsToUpsert: SyncItem[], itemsToDelete: SyncItem[], collectionsToSync: SyncCollection[] }> {

    // Get items
    let items: Zotero.Item[] = [];
    let collections: Zotero.Collection[] = [];
    if (isInitialSync) {
        const itemIds = await getRegularAndAttachmentIDs(libraryID, false);
        items = await Zotero.Items.getAsync(itemIds);
        collections = await getAllCollections(libraryID);
        try {
            await Zotero.Items.loadAll(libraryID);
        } catch (e) {
            // Ignore benign "already loaded" errors.
        }
        // collections = await getAllCollections(libraryID);
    } else if (lastSyncVersion !== null && syncMethod === 'version') {
        items = await getItemsSinceVersion(libraryID, lastSyncVersion);
        logger(`Beaver Sync: Found ${items.length} modified items: ${items.map(item => item.id).join(', ')}`, 3);
        collections = await getCollectionsSinceVersion(libraryID, lastSyncVersion);
    } else if (lastSyncDate !== null && syncMethod === 'date_modified') {
        lastSyncDate = Zotero.Date.isISODate(lastSyncDate) ? Zotero.Date.isoToSQL(lastSyncDate) : lastSyncDate;
        items = await getModifiedItems(libraryID, lastSyncDate);
        logger(`Beaver Sync: Found ${items.length} modified items: ${items.map(item => item.id).join(', ')}`, 3);
        collections = await getModifiedCollections(libraryID, lastSyncDate);
    } else {
        throw new Error(`Beaver Sync: Invalid sync state: ${syncMethod} ${lastSyncDate} ${lastSyncVersion}`);
    }

    // For incremental syncs, load data only for the specific items
    if (!isInitialSync && items.length > 0) {
        logger(`Beaver Sync: Loading data for ${items.length} items`, 3);
        const loadPromises = items
            .map(async (item) => {
                try {
                    await item.loadAllData();
                    return item;
                } catch (e) {
                    logger(`Beaver Sync: Failed to load data for item ${libraryID}-${item.key}. Skipping.`, 2);
                    return null;
                }
            });
        const settledItems = await Promise.all(loadPromises);
        items = settledItems.filter(Boolean) as Zotero.Item[];

        // Load parents
        // await loadParentData(items); // optimized but untested
        const parentLoadPromisesArrays = await Promise.all(
            items.map(item => getParentLoadPromises(item))
        );
        const parentLoadPromises = parentLoadPromisesArrays.flat();
        await Promise.all(parentLoadPromises);        
    }
    
    // Get items to upsert: Included by filter function
    const itemsToUpsert = items
        .filter(item => filterFunction(item))
        .map(item => ({
            action: 'upsert',
            item
        } as SyncItem));
    
    logger(`Beaver Sync: Found ${itemsToUpsert.length} items to upsert: ${itemsToUpsert.map(item => item.item.id).join(', ')}`, 3);
    
    // Get items to delete: Excluded by filter function
    const itemsToDelete = items
        .filter((_) => !isInitialSync) // Only delete items if not initial sync
        .filter(isSupportedItem)
        .filter((item) => !filterFunction(item))
        .map(item => ({
            action: 'delete',
            item
        } as SyncItem));
    
    logger(`Beaver Sync: Found ${itemsToDelete.length} items to delete: ${itemsToDelete.map(item => item.item.id).join(', ')}`, 3);

    // Get collections to sync: All collections that have been modified
    const collectionsToSync = collections
        .filter(collection => !collection.deleted) // Exclude deleted collections
        .map(collection => ({
            action: 'upsert',
            collection
        } as SyncCollection));
    
    logger(`Beaver Sync: Found ${collectionsToSync.length} collections to sync: ${collectionsToSync.map(c => c.collection.id).join(', ')}`, 3);

    return {
        itemsToUpsert,
        itemsToDelete,
        collectionsToSync
    };
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
 * Gets items based on version number
 * @param libraryID Zotero library ID
 * @param sinceVersion Zotero version number to check modifications since
 * @param toVersion Zotero version number to check modifications until (optional)
 * @returns Promise resolving to array of Zotero items
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
    const itemsToSync = allItems.filter(item => filterFunction(item));
    return itemsToSync;
}

/**
 * Gets all collections in a library
 * @param libraryID Zotero library ID
 * @returns Promise resolving to array of Zotero collections
 */
async function getAllCollections(libraryID: number): Promise<Zotero.Collection[]> {
    return (await Zotero.Collections.getAllIDs(libraryID))
        .map(id => Zotero.Collections.get(id))
        .filter(c => c.libraryID === libraryID && !c.deleted);
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