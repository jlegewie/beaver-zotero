import { calculateObjectHash } from '../utils/hash';
import { logger } from './logger';
import { ItemDataHashedFields, AttachmentDataHashedFields, ItemData, ZoteroCreator, ZoteroCollection, BibliographicIdentifier, AttachmentDataWithMimeType, ZoteroLibrary } from '../../react/types/zotero';
import { getCollectionClientDateModifiedAsISOString, getCitationKeyFromItem, getMimeType, safeIsInTrash, safeFileExists } from './zoteroUtils';
import { syncingItemFilterAsync } from './sync';
import { isAttachmentOnServer } from './webAPI';
import { skippedItemsManager } from '../services/skippedItemsManager';

export interface FileData {
    // filename: string;
    file_hash: string;
    size: number;
    mime_type: string;
    // content?: string;
    storage_path?: string;
}

/**
 * Get collection keys from Zotero item
 * @param item Zotero item
 * @returns Array of collection keys
 */
function getCollectionKeysFromItem(item: Zotero.Item): string[] | null {
    const collectionKeys = item.getCollections().map(id => Zotero.Collections.get(id).key);
    return collectionKeys.length > 0 ? collectionKeys : null;
}

/**
 * Get creators from item
 * @param item Zotero item
 * @returns Array of creators
 */
function getCreatorsFromItem(item: Zotero.Item): ZoteroCreator[] | null {
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
 * Get collections from Zotero item
 * @param item Zotero item
 * @returns Array of collections
 */
async function getCollectionsFromItem(item: Zotero.Item): Promise<ZoteroCollection[] | null> {
    const collectionPromises = item.getCollections()
        .map(async (collection_id) => {
            const collection = Zotero.Collections.get(collection_id).toJSON();
            return {
                library_id: item.libraryID,
                zotero_key: collection.key,
                name: collection.name,
                zotero_version: collection.version,
                date_modified: await getCollectionClientDateModifiedAsISOString(collection_id),
                parent_collection: collection.parentCollection || null,
                relations: Object.keys(collection.relations).length > 0 ? collection.relations : null,
            } as ZoteroCollection;
        })
    const collections = await Promise.all(collectionPromises);

    return collections.length > 0 ? collections : null;
}

/**
 * Gets identifiers from a Zotero item
 * @param item Zotero item
 * @returns Object with identifiers
 */
function getIdentifiersFromItem(item: Zotero.Item): BibliographicIdentifier | null {
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
 * Attempts to extract a year from a Zotero item's date field
 * @param item Zotero item
 * @returns Extracted year or undefined
 */
export function getYearFromItem(item: Zotero.Item): number | undefined {
    const date = item.getField('date', false, true);
    if (!date) return undefined;
    
    // Try to extract a 4-digit year from the date string
    const yearMatch = date.match(/\b(\d{4})\b/);
    return yearMatch ? parseInt(yearMatch[1]) : undefined;
}

/**
 * Gets file data from a Zotero attachment item.
 * @param item Zotero attachment item
 * @returns Promise resolving to FileData object or null.
 */
async function getFileDataFromItem(item: Zotero.Item): Promise<FileData | null> {
    if (!item.isAttachment() || !(await safeFileExists(item))) return null;

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
 * Extracts primary creators from a Zotero item
 * @param item Zotero item
 * @returns Array of primary creators
 */
export function getPrimaryCreatorsFromItem(item: Zotero.Item): ZoteroCreator[] {
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
 * Serializes a Zotero collection object for syncing
 * @param collection Zotero collection
 * @param clientDateModified Optional pre-fetched clientDateModified
 * @returns Promise resolving to serialized ZoteroCollection object
 */
export async function serializeCollection(
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
        zotero_version: collection.version,
        date_modified: finalDateModified,
        parent_collection: collectionJSON.parentCollection || null,
        relations: Object.keys(collectionJSON.relations).length > 0 ? collectionJSON.relations : null,
    } as ZoteroCollection;
}

/**
 * Extracts relevant data from a Zotero item for syncing, including a metadata hash.
 * @param item Zotero item
 * @returns Promise resolving to ItemData object for syncing
 */
export async function serializeItem(item: Zotero.Item, clientDateModified: string | undefined): Promise<ItemData> {

    // ------- 1. Get full item data -------
    // @ts-ignore - Returns of item.toJSON are not typed correctly
    const {abstractNote, key, libraryID, itemType, deleted, dateAdded, dateModified, accessDate, creators, collections, tags, version, ...fullItemData } = item.toJSON();

    // ------- 2. Extract fields for hashing -------
    const hashedFields: ItemDataHashedFields = {
        zotero_key: item.key,
        library_id: item.libraryID,
        item_type: item.itemType,
        title: item.getField('title', false, true),
        creators: getCreatorsFromItem(item),
        date: item.getField('date', false, true),
        year: getYearFromItem(item),
        publication_title: item.getField('publicationTitle', false, true),
        abstract: item.getField('abstractNote'),
        url: item.getField('url'),
        identifiers: getIdentifiersFromItem(item),
        language: item.getField('language'),
        formatted_citation: Zotero.Beaver?.citationService?.formatBibliography(item) ?? '',
        deleted: (() => {
            const trashState = safeIsInTrash(item);
            if (trashState === null) {
                logger(
                    `serializeItem: Item missing isInTrash, marking deleted. id=${item?.id ?? "unknown"} key=${item?.key ?? "unknown"} library=${item?.libraryID ?? "unknown"} type=${item?.itemType ?? "unknown"}`,
                    2
                );
                return true;
            }
            return trashState;
        })(),
        tags: item.getTags().length > 0 ? item.getTags() : null,
        collections: getCollectionKeysFromItem(item),
        citation_key: await getCitationKeyFromItem(item),
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


/**
 * Extracts relevant data from a Zotero attachment item for syncing, including a metadata hash.
 * Keeps the 'file' property nested in the final output.
 * @param item Zotero item
 * @param options Optional parameters
 * @param options.lightweight If true, skips file-system operations (file existence check and content hashing)
 * @returns Promise resolving to AttachmentData object for syncing
 */
export async function serializeAttachment(
    item: Zotero.Item,
    clientDateModified: string | undefined,
    options?: { skipFileHash?: boolean, skipSyncingFilter?: boolean }
): Promise<AttachmentDataWithMimeType | null> {
    const skipFileHash = options?.skipFileHash || false;
    const skipSyncingFilter = options?.skipSyncingFilter || false;

    // 1. File: Confirm that the item is an attachment and passes the syncing filter (exists locally or on server)
    const passesSyncingFilter = skipSyncingFilter ? true : (await syncingItemFilterAsync(item));
    if (!item.isAttachment() || !passesSyncingFilter) {
        if(item.isAttachment()) {
            logger(`serializeAttachment: Attachment ${item.key} not available locally or on server. Skipping.`, 1);
            skippedItemsManager.upsert(item, 'not available locally or on server');
        }
        return null;
    }
    
    // 2. Get the file hash (local file hash takes precedence, then synced hash from server)
    let file_hash: string = '';

    if (!skipFileHash) {
        const existsLocal = await safeFileExists(item);
        
        if (existsLocal) {
            try {
                file_hash = await item.attachmentHash;
            } catch (error: any) {
                // File may be locked by another application or have permission issues
                logger(`Beaver Sync: Cannot access file for attachment ${item.key}: ${error.message}. Skipping.`, 2);
                skippedItemsManager.upsert(item, 'file access denied');
                return null;
            }
        } else if (isAttachmentOnServer(item)) {
            // isAttachmentOnServer returns true only when attachmentSyncedHash is available
            file_hash = item.attachmentSyncedHash;
        }

        if (!file_hash) {
            logger(`Beaver Sync: Attachment ${item.key} has no file hash available. Skipping.`, 1);
            skippedItemsManager.upsert(item, 'no file hash available locally or on server');
            return null;
        }
    }

    // 2. Metadata: Prepare the object containing only fields for hashing
    const hashedFields: AttachmentDataHashedFields = {
        library_id: item.libraryID,
        zotero_key: item.key,
        parent_key: item.parentKey || null,
        attachment_url: item.getField('url'),
        link_mode: item.attachmentLinkMode,
        tags: item.getTags().length > 0 ? item.getTags() : null,
        collections: getCollectionKeysFromItem(item),
        deleted: (() => {
            const trashState = safeIsInTrash(item);
            if (trashState === null) {
                logger(
                    `serializeAttachment: Attachment missing isInTrash, marking deleted. id=${item?.id ?? "unknown"} key=${item?.key ?? "unknown"} library=${item?.libraryID ?? "unknown"}`,
                    2
                );
                return true;
            }
            return trashState;
        })(),
        title: item.getField('title', false, true),
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

    // 4. AttachmentData: Construct final AttachmentData object
    const attachmentData: AttachmentDataWithMimeType = {
        ...hashedFields,
        // Add non-hashed fields
        file_hash,
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
 * Lightweight item serializer for search results.
 * Extracts only the fields consumed by the backend search path,
 * skipping expensive operations like hashing, JSON serialization,
 * collection fetching, and identifier extraction.
 *
 * @param item Zotero item (must have itemData and creators loaded)
 * @returns ItemData with empty/placeholder values for unused fields
 */
export function serializeItemForSearch(item: Zotero.Item): ItemData {
    return {
        // ZoteroItemBase fields
        library_id: item.libraryID,
        zotero_key: item.key,
        date_added: Zotero.Date.sqlToISO8601(item.dateAdded),
        date_modified: Zotero.Date.sqlToISO8601(item.dateModified),

        // Core bibliographic fields (consumed by backend)
        item_type: item.itemType,
        title: item.getField('title', false, true),
        creators: getCreatorsFromItem(item),
        date: item.getField('date', false, true),
        year: getYearFromItem(item),
        publication_title: item.getField('publicationTitle', false, true),
        abstract: item.getField('abstractNote'),
        formatted_citation: Zotero.Beaver?.citationService?.formatBibliography(item) ?? '',

        // Placeholder values for fields not consumed by search
        deleted: item.deleted,
        item_metadata_hash: '',
        zotero_version: 0,
        zotero_synced: false,
    };
}

/**
 * Serializes a Zotero library object
 * @param library Zotero library (Library, Group, or Feed)
 * @returns Serialized ZoteroLibrary object
 */
export function serializeZoteroLibrary(library: _ZoteroTypes.Library.LibraryLike): ZoteroLibrary {
    return {
        library_id: library.libraryID,
        group_id: library.isGroup ? library.id : null,
        name: library.name,
        is_group: library.isGroup,
        type: library.libraryType,
        type_id: library.libraryTypeID,
        read_only: !library.editable || !library.filesEditable,
    } as ZoteroLibrary;
}

/**
 * Result of serializing an item with its attachments
 */
export interface SerializedItemWithAttachments {
    item_data?: ItemData;
    attachment_data: AttachmentDataWithMimeType[];
}

/**
 * Serializes a Zotero item along with all its PDF attachments.
 * Used for immediate sync of newly imported items.
 * 
 * @param libraryId Library ID
 * @param zoteroKey Zotero key of the item
 * @returns Promise resolving to serialized item and attachment data
 */
export async function serializeItemWithAttachments(
    libraryId: number,
    zoteroKey: string
): Promise<SerializedItemWithAttachments> {
    const result: SerializedItemWithAttachments = {
        attachment_data: []
    };
    
    // Get the Zotero item
    const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, zoteroKey);
    if (!item) {
        logger(`serializeItemWithAttachments: Item ${libraryId}-${zoteroKey} not found`, 2);
        return result;
    }
    
    // Ensure item data is loaded
    try {
        await item.loadAllData();
    } catch (e) {
        // Ignore benign "already loaded" errors
    }
    
    // Serialize the main item (if it's a regular item)
    if (item.isRegularItem()) {
        try {
            result.item_data = await serializeItem(item, undefined);
        } catch (e: any) {
            logger(`serializeItemWithAttachments: Failed to serialize item ${zoteroKey}: ${e.message}`, 1);
        }
        
        // Get and serialize all PDF attachments
        const attachmentIds = await item.getAttachments();
        for (const attachmentId of attachmentIds) {
            try {
                const attachment = await Zotero.Items.getAsync(attachmentId);
                if (attachment && attachment.isPDFAttachment() && !attachment.deleted) {
                    // Ensure attachment data is loaded
                    try {
                        await attachment.loadAllData();
                    } catch (e) {
                        // Ignore benign "already loaded" errors
                    }
                    
                    const attachmentData = await serializeAttachment(attachment, undefined);
                    if (attachmentData) {
                        result.attachment_data.push(attachmentData);
                    }
                }
            } catch (e: any) {
                logger(`serializeItemWithAttachments: Failed to serialize attachment ${attachmentId}: ${e.message}`, 2);
            }
        }
    } else if (item.isAttachment() && item.isPDFAttachment()) {
        // Item is itself an attachment
        try {
            const attachmentData = await serializeAttachment(item, undefined);
            if (attachmentData) {
                result.attachment_data.push(attachmentData);
            }
        } catch (e: any) {
            logger(`serializeItemWithAttachments: Failed to serialize attachment ${zoteroKey}: ${e.message}`, 1);
        }
    }
    
    return result;
}
