import { calculateObjectHash } from '../utils/hash';
import { logger } from './logger';
import { libraryRefForLibraryID } from './libraryIdentity';
import { ItemDataHashedFields, AttachmentDataHashedFields, ItemData, ItemStub, ItemSummary, CollectionSummary, ZoteroCreator, ZoteroCollection, BibliographicIdentifier, AttachmentDataWithMimeType, ZoteroLibrary, AttachmentStub } from '../../react/types/zotero';
import { getCollectionClientDateModifiedAsISOString, getCitationKeyFromItem, getMimeType, safeIsInTrash, safeFileExists } from './zoteroUtils';
import { syncingItemFilterAsync } from './sync';
import { isAttachmentOnServer } from './webAPI';
import { skippedItemsManager } from '../services/skippedItemsManager';
import { AnnotationResultItem, NoteResultItem } from '../services/agentProtocol';
import { getContentKind } from '../services/documentExtraction/attachmentResolution';
import type { ContentKind } from '../services/documentExtraction/shared/contentKinds';

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
export function getCollectionKeysFromItem(item: Zotero.Item): string[] | null {
    const collectionKeys = item.getCollections()
        .map(id => {
            const col = Zotero.Collections.get(id);
            if (!col) {
                logger(`getCollectionKeysFromItem: Collection ${id} not found for item ${item.libraryID}/${item.key}, skipping`, 1);
                return null;
            }
            return col.key;
        })
        .filter((key): key is string => key !== null);
    return collectionKeys.length > 0 ? collectionKeys : null;
}

export function getCollectionSummariesFromItem(item: Zotero.Item): CollectionSummary[] | null {
    const collectionIds = item.getCollections();
    if (collectionIds.length === 0) return null;
    // Constant across all of this item's collections; computed once.
    const libraryRef = libraryRefForLibraryID(item.libraryID) ?? undefined;
    const summaries = collectionIds
        .map(id => {
            const collection = Zotero.Collections.get(id);
            if (!collection) {
                logger(`getCollectionSummariesFromItem: Collection ${id} not found for item ${item.libraryID}/${item.key}, skipping`, 1);
                return null;
            }
            return {
                library_id: item.libraryID,
                zotero_key: collection.key,
                library_ref: libraryRef,
                name: collection.name,
            } as CollectionSummary;
        })
        .filter((s): s is CollectionSummary => s !== null);
    return summaries.length > 0 ? summaries : null;
}

/**
 * Get creators from item
 * @param item Zotero item
 * @returns Array of creators
 */
export function getCreatorsFromItem(item: Zotero.Item): ZoteroCreator[] | null {
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
 * Formats creators as a compact, citation-style string (last names only),
 * matching the backend `format_item_stub_creators` projection so the strings the
 * frontend sends in an `ItemStub` are identical to what the backend would derive:
 *   - prefer primary creators; fall back to author-typed creators if none flagged
 *   - 1 name → "Smith"; 2–3 → "Smith, Jones & Lee"; 4+ → "Smith et al."
 *   - returns null when the kept set has no usable names (e.g. editors only)
 */
export function formatZoteroCreatorsString(creators: ZoteroCreator[] | null | undefined): string | null {
    if (!creators || creators.length === 0) return null;

    let list = creators;
    if (list.some(c => c.is_primary != null)) {
        list = list.filter(c => c.is_primary);
    } else if (list.some(c => c.creator_type)) {
        const authors = list.filter(c => c.creator_type === 'author');
        if (authors.length > 0) list = authors;
    }

    const names = list
        .map(c => c.last_name || c.first_name || null)
        .filter((name): name is string => Boolean(name));

    if (names.length === 0) return null;
    if (names.length === 1) return names[0];
    if (names.length <= 3) {
        return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
    }
    return `${names[0]} et al.`;
}

/**
 * Get collections from Zotero item
 * @param item Zotero item
 * @returns Array of collections
 */
async function getCollectionsFromItem(item: Zotero.Item): Promise<ZoteroCollection[] | null> {
    // Constant across all of this item's collections; computed once.
    const libraryRef = libraryRefForLibraryID(item.libraryID) ?? undefined;
    const collectionPromises = item.getCollections()
        .map(async (collection_id) => {
            const col = Zotero.Collections.get(collection_id);
            if (!col) {
                logger(`getCollectionsFromItem: Collection ${collection_id} not found for item ${item.libraryID}/${item.key}, skipping`, 1);
                return null;
            }
            const collection = col.toJSON();
            return {
                library_id: item.libraryID,
                zotero_key: collection.key,
                library_ref: libraryRef,
                name: collection.name,
                zotero_version: collection.version,
                date_modified: await getCollectionClientDateModifiedAsISOString(collection_id),
                parent_collection: collection.parentCollection || null,
                relations: Object.keys(collection.relations).length > 0 ? collection.relations : null,
            } as ZoteroCollection;
        })
    const collections = (await Promise.all(collectionPromises)).filter((c): c is ZoteroCollection => c !== null);

    return collections.length > 0 ? collections : null;
}

/**
 * Gets identifiers from a Zotero item
 * @param item Zotero item
 * @returns Object with identifiers
 */
export function getIdentifiersFromItem(item: Zotero.Item): BibliographicIdentifier | null {
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
        library_ref: libraryRefForLibraryID(collection.libraryID) ?? undefined,
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
 * @param options.skipHash If true, skip SHA-256 hash computation and set item_metadata_hash to ''.
 *   Use for search/lookup paths where the hash is not consumed by the backend.
 * @returns Promise resolving to ItemData object for syncing
 */
export async function serializeItem(item: Zotero.Item, clientDateModified: string | undefined, options?: { skipHash?: boolean }): Promise<ItemData> {
    const skipHash = options?.skipHash ?? false;

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
    const metadataHash = skipHash ? '' : await calculateObjectHash(hashedFields);

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
        // Device-portable library identity. Not part of hashedFields: it's
        // derived from library_id (already hashed) and never changes on its
        // own, so it must not affect the metadata hash.
        library_ref: libraryRefForLibraryID(item.libraryID) ?? undefined,
        // Add the calculated hash
        zotero_version: item.version,
        zotero_synced: item.synced,
        item_metadata_hash: metadataHash,
    };

    return itemData;
}


/**
 * Lightweight item serializer for search results.
 * Skips expensive operations: formatBibliography(), item.toJSON(), calculateObjectHash(),
 * and all sync/date/deleted fields.
 * @param item Zotero item
 * @returns Promise resolving to ItemSummary
 */
export async function serializeItemSummary(item: Zotero.Item): Promise<ItemSummary> {
    const tags = item.getTags();
    return {
        // ItemSummary keeps split keys + structured creators (it is parsed as a
        // full ItemSummary by the backend), unlike the lean ItemStub.
        zotero_key: item.key,
        library_id: item.libraryID,
        library_ref: libraryRefForLibraryID(item.libraryID) ?? undefined,
        item_type: item.itemType,
        title: item.getField('title', false, true) || null,
        creators: getCreatorsFromItem(item),
        year: getYearFromItem(item) ?? null,
        date: item.getField('date', false, true) || null,
        publication_title: item.getField('publicationTitle', false, true) || null,
        abstract: item.getField('abstractNote') || null,
        identifiers: getIdentifiersFromItem(item),
        language: item.getField('language') || null,
        tags: tags.length > 0 ? tags.map((t: any) => t.tag) : null,
        collections: getCollectionSummariesFromItem(item),
        citation_key: await getCitationKeyFromItem(item),
    };
}

/**
 * Serializes the minimal bibliographic anchor (`ItemStub`) for a regular item.
 *
 * Emits the lean, model-facing shape the backend consumes directly: a combined
 * `item_id` and a pre-formatted `creators` string. Keep this in sync with the
 * backend `ItemStub` projection (`format_item_stub_creators`).
 */
export function serializeItemStub(item: Zotero.Item): ItemStub {
    return {
        item_id: `${item.libraryID}-${item.key}`,
        library_ref: libraryRefForLibraryID(item.libraryID) ?? undefined,
        item_type: item.itemType,
        title: item.getField('title', false, true) || null,
        creators: formatZoteroCreatorsString(getCreatorsFromItem(item)),
        year: getYearFromItem(item) ?? null,
    };
}

/**
 * Runs display-stub serialization defensively.
 *
 * Message attachment stubs are optional UI data, so a Zotero lazy-load or
 * metadata edge case must not prevent constructing the attachment payload.
 */
export function safeStub<T>(build: () => T): T | undefined {
    try {
        return build();
    } catch {
        return undefined;
    }
}

/**
 * Serializes the minimal display anchor (`AttachmentStub`) for a Zotero attachment.
 *
 * Carries the served file's identity and broad content kind for client-side
 * rendering; availability and readability analysis belongs in `AttachmentInfo`.
 */
export function serializeAttachmentStub(item: Zotero.Item, contentKind?: ContentKind): AttachmentStub {
    return {
        attachment_id: `${item.libraryID}-${item.key}`,
        library_ref: libraryRefForLibraryID(item.libraryID) ?? undefined,
        parent_item_id: item.parentKey ? `${item.libraryID}-${item.parentKey}` : null,
        title: item.getField?.('title') || item.getDisplayTitle?.() || null,
        filename: item.attachmentFilename || null,
        content_kind: contentKind ?? getContentKind(item),
    };
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
    options?: {
        skipFileHash?: boolean,
        skipSyncingFilter?: boolean,
        skipHash?: boolean,
        includeAnnotationsCount?: boolean,
    }
): Promise<AttachmentDataWithMimeType | null> {
    const skipFileHash = options?.skipFileHash ?? false;
    const skipSyncingFilter = options?.skipSyncingFilter ?? false;
    const skipHash = options?.skipHash ?? false;
    const includeAnnotationsCount = options?.includeAnnotationsCount ?? false;

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
    const metadataHash = skipHash ? '' : await calculateObjectHash(hashedFields);

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
        // Device-portable library identity, derived from library_id (already
        // hashed above) — kept out of hashedFields so it never affects the
        // metadata hash.
        library_ref: libraryRefForLibraryID(item.libraryID) ?? undefined,
        // Add the calculated hash
        attachment_metadata_hash: metadataHash,
        zotero_version: item.version,
        zotero_synced: item.synced,
    };

    if (includeAnnotationsCount) {
        await item.loadDataType("childItems");
        attachmentData.annotations_count = item.isFileAttachment?.() ? item.getAnnotations().length : 0;
    }

    return attachmentData;
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
        library_ref: libraryRefForLibraryID(library.libraryID) ?? undefined,
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

/**
 * Serializes a Zotero note item into a NoteResultItem.
 *
 * The `parent_item` field carries the bibliographic parent as an `ItemStub`
 * (the minimal anchor the backend reduces every parent reference to). The flat
 * `parent_item_id`/`parent_title` fields are derived from it and are deprecated:
 * they remain only for clients/backends that predate `parent_item` and should be
 * dropped once the backend reads `parent_item`.
 *
 * @param note Zotero note item
 * @param parent Optional parent item anchor (ItemStub)
 * @returns NoteResultItem
 */
export function serializeNote(
    note: Zotero.Item,
    parent?: ItemStub | null,
): NoteResultItem {
    return {
        result_type: 'note',
        item_id: `${note.libraryID}-${note.key}`,
        library_ref: libraryRefForLibraryID(note.libraryID) ?? undefined,
        title: note.getDisplayTitle?.() || '',
        parent_item_id: parent?.item_id ?? null,
        parent_title: parent?.title ?? null,
        parent_item: parent ?? null,
        date_modified: note.dateModified,
    };
}

/**
 * Serializes a Zotero annotation item into an AnnotationResultItem.
 *
 * Annotations are children of attachments, which are children of regular
 * items. The bibliographic parent (regular item) is therefore two levels up.
 * Callers pass it in as `itemInfo`. The PDF attachment is `attachmentInfo`.
 *
 * `page` is the 1-based page number derived from the annotation's stored
 * position; the agent reasons in 1-based page numbers. `page_label` carries the
 * document's printed label (e.g. roman numerals) for UI rendering only — the
 * backend keeps it out of the agent-facing tool result.
 */
export function serializeAnnotation(
    annotation: Zotero.Item,
    attachmentInfo?: { item_id: string } | null,
    itemInfo?: {
        item_id: string;
        item_type?: string | null;
        title: string;
        creators?: string | null;
        year?: number | null;
    } | null,
): AnnotationResultItem {
    const ann = annotation as Zotero.Item & {
        annotationType?: string;
        annotationText?: string;
        annotationComment?: string;
        annotationColor?: string;
        annotationAuthorName?: string;
        annotationPosition?: string;
        annotationPageLabel?: string;
    };

    // Derive 1-based page from the annotation's position. Zotero stores
    // annotationPosition as a JSON string with a 0-based pageIndex.
    let page: number | null = null;
    if (typeof ann.annotationPosition === 'string' && ann.annotationPosition) {
        try {
            const parsed = JSON.parse(ann.annotationPosition);
            if (parsed && typeof parsed.pageIndex === 'number' && parsed.pageIndex >= 0) {
                page = parsed.pageIndex + 1;
            }
        } catch {
            // Malformed position is non-fatal — page stays null.
        }
    }

    const tagObjects = annotation.getTags?.() ?? [];
    const tags = tagObjects
        .map((t: any) => (typeof t === 'string' ? t : t?.tag))
        .filter((name: any): name is string => typeof name === 'string' && name.length > 0);

    return {
        result_type: 'annotation',
        annotation_id: `${annotation.libraryID}-${annotation.key}`,
        library_ref: libraryRefForLibraryID(annotation.libraryID) ?? undefined,
        annotation_type: ann.annotationType ?? null,
        text: ann.annotationText ?? null,
        comment: ann.annotationComment ?? null,
        color: ann.annotationColor ?? null,
        page,
        page_label: ann.annotationPageLabel ?? null,
        tags,
        author: ann.annotationAuthorName || null,
        attachment_id: attachmentInfo?.item_id ?? null,
        item_id: itemInfo?.item_id ?? null,
        item_type: itemInfo?.item_type ?? null,
        item_title: itemInfo?.title ?? null,
        item_creators: itemInfo?.creators ?? null,
        item_year: itemInfo?.year ?? null,
        date_added: annotation.dateAdded,
        date_modified: annotation.dateModified,
    };
}
