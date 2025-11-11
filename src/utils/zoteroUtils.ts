import { getDisplayNameFromItem } from "../../react/utils/sourceUtils";
import { logger } from "./logger";


/**
 * Get the BibTeX cite-key for a Zotero.Item, if available.
 * Tries Better BibTeX, then Zotero beta field citationKey, then Extra.
 *
 * @param {Zotero.Item} item
 * @return {string|null}
 */
export async function getCitationKeyFromItem(item: Zotero.Item): Promise<string | null> {
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
            logger('getCitationKeyFromItem: BetterBibTeX KeyManager failed');
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
        logger('getCitationKeyFromItem: Failed to get extra field');
        return null;
    }
}

/**
 * Get the clientDateModified for an item
 * @param item Zotero item or item ID
 * @returns clientDateModified as string
 */
export async function getClientDateModified(item: Zotero.Item | number): Promise<string> {
    const itemId = typeof item === 'number' ? item : item.id;
    const sql = "SELECT clientDateModified FROM items WHERE itemID = ?";
    return await Zotero.DB.valueQueryAsync(sql, [itemId]) as string;
}

/**
 * Get the clientDateModified for an item as ISO string
 * @param item Zotero item or item ID
 * @returns clientDateModified as ISO string
 */
export async function getClientDateModifiedAsISOString(item: Zotero.Item | number): Promise<string> {
    const clientDateModified = await getClientDateModified(item);
    return Zotero.Date.sqlToISO8601(clientDateModified);
}

/**
 * Get the clientDateModified for a collection
 * @param collection Zotero collection or collection ID
 * @returns clientDateModified as string
 */
export async function getCollectionClientDateModified(collection: Zotero.Collection | number): Promise<string> {
    const collectionId = typeof collection === 'number' ? collection : collection.id;
    const sql = "SELECT clientDateModified FROM collections WHERE collectionID = ?";
    return await Zotero.DB.valueQueryAsync(sql, [collectionId]) as string;
}

/**
 * Get the clientDateModified for a collection as ISO string
 * @param collection Zotero collection or collection ID
 * @returns clientDateModified as ISO string
 */
export async function getCollectionClientDateModifiedAsISOString(collection: Zotero.Collection | number): Promise<string> {
    const clientDateModified = await getCollectionClientDateModified(collection);
    return Zotero.Date.sqlToISO8601(clientDateModified);
}

/**
 * Get the clientDateModified for multiple items in a batch operation.
 * @param items Array of Zotero items or item IDs
 * @returns Map of itemID to clientDateModified string in ISO format
 */
export async function getClientDateModifiedBatch(
    items: (Zotero.Item | number)[],
    chunkSize: number = 500
): Promise<Map<number, string>> {
    const itemIds = items.map(item => typeof item === 'number' ? item : item.id);
    if (itemIds.length === 0) return new Map();

    const result = new Map<number, string>();
    
    // Process in chunks to avoid SQLite parameter limits
    for (let i = 0; i < itemIds.length; i += chunkSize) {
        const chunk = itemIds.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(', ');
        const sql = `SELECT itemID, clientDateModified FROM items WHERE itemID IN (${placeholders})`;
        
        try {
            const rows = await Zotero.DB.queryAsync(sql, chunk);
            
            for (const row of rows || []) {
                if (row.clientDateModified) {
                    try {
                        result.set(
                            row.itemID,
                            Zotero.Date.sqlToISO8601(row.clientDateModified),
                        );
                    } catch (e) {
                        logger(`getClientDateModifiedBatch: Could not parse clientDateModified '${row.clientDateModified}' for item ${row.itemID}. This item will not be included in date-based batching.`, 2);
                    }
                }
            }
        } catch (error) {
            logger(`getClientDateModifiedBatch: Error processing chunk ${i}-${i + chunk.length}: ${(error as Error).message}`, 1);
            throw error;
            // Continue with next chunk even if one fails
        }
    }

    return result;
}

/**
 * Get recently added or modified items in a library
 * @param {Integer} libraryID - The library to get items from
*
 * @param {Object} [options]
 * @param {String} [options.sortBy='dateModified'] - Field to sort by: 'dateAdded' or 'dateModified'
 * @param {Integer} [options.limit=10] - Maximum number of items to return
 * @param {Boolean} [options.includeTrashed=false] - Whether to include items in the trash
 * @param {Boolean} [options.asIDs=false] - If true, return only item IDs instead of item objects
 * @return {Promise<Array<Zotero.Item|Integer>>}
 */
export const getRecentAsync = async function (
    libraryID: number,
    options: {
        sortBy?: string,
        limit?: number,
        includeTrashed?: boolean,
        asIDs?: boolean
    } = {}
): Promise<Zotero.Item[] | number[]> {
    const { 
        sortBy = 'dateModified', 
        limit = 10, 
        includeTrashed = false,
        asIDs = false
    } = options;
    
    if (!['dateAdded', 'dateModified'].includes(sortBy)) {
        throw new Error("sortBy must be 'dateAdded' or 'dateModified'");
    }
    
    let sql = 'SELECT itemID FROM items';
    
    if (!includeTrashed) {
        sql += ' WHERE itemID NOT IN (SELECT itemID FROM deletedItems)';
    } else {
        sql += ' WHERE 1=1';
    }
    
    // Only return items from the requested library
    sql += ' AND libraryID=?';
    
    // Order by the requested date field
    sql += ` ORDER BY ${sortBy} DESC LIMIT ?`;
    
    const params = [libraryID, limit];
    const ids = await Zotero.DB.columnQueryAsync(sql, params) as number[];
    
    if (asIDs) {
        return ids;
    }
    
    return Zotero.Items.getAsync(ids);
};


export function getZoteroUserIdentifier(): { userID: string | undefined, localUserKey: string } {
    // First try to get the Zotero account user ID
    const userID = Zotero.Users.getCurrentUserID();
    
    // Fallback to local user key
    const localUserKey = Zotero.Users.getLocalUserKey();

    return {
        userID: userID ? `${userID}` : undefined,
        localUserKey: `${localUserKey}`
    }
}

export function isLibrarySynced(libraryID: number): boolean {
    try {
        // Check if sync is enabled globally first
        if (!Zotero.Sync.Runner.enabled) {
            return false;
        }
        
        // Get the library object
        const library = Zotero.Libraries.get(libraryID);
        if (!library) {
            return false;
        }
        
        // Check if library type supports syncing (excludes feed libraries)
        if (!library.syncable) {
            return false;
        }
        
        // Check if this specific library is skipped from sync
        if (isLibrarySkipped(library)) {
            return false;
        }
        
        // Check if library has actually been synced before
        // This indicates it's connected to Zotero sync infrastructure
        if (!library.lastSync) {
            return false;
        }
        
        // Check if library has a version (indicates modern sync setup)
        if (!library.libraryVersion || library.libraryVersion === 0) {
            return false;
        }
        
        return true;

    } catch (e) {
        Zotero.logError(e as Error);
        return false;
    }
}

export function isLibrarySkipped(library: Zotero.Library): boolean {
    try {
        const pref = 'sync.librariesToSkip';
        const librariesToSkip = (Zotero.Prefs.get(pref) || []) as string[];
        
        // Check based on library type
        if (library.libraryType === 'group') {
            // @ts-ignore Zotero.Library.groupID is defined
            return librariesToSkip.includes("G" + library.groupID);
        } else {
            return librariesToSkip.includes("L" + library.libraryID);
        }
    } catch (e) {
        Zotero.logError(e as Error);
        return false;
    }
}

/**
 * Determines the MIME type for a Zotero attachment
 * Falls back to file detection if stored type is missing/generic
 * @param attachment Zotero attachment item
 * @param filePath Optional file path (will be fetched if not provided)
 * @returns Promise<string> MIME type string
 */
export async function getMimeType(attachment: Zotero.Item, filePath?: string): Promise<string> {
    if (!attachment.isAttachment()) return '';
    
    let mimeType = attachment.attachmentContentType;

    // Validate/correct MIME type by checking actual file if needed
    if (!mimeType || mimeType === 'application/octet-stream' || mimeType === '') {
        try {
            if (!filePath) filePath = await attachment.getFilePathAsync() || undefined;
            if (!filePath) {
                logger(`getMimeType: No file path available for ${attachment.key}`, 2);
                return mimeType || 'application/octet-stream';
            }
            
            const detectedMimeType = await Zotero.MIME.getMIMETypeFromFile(filePath);
            if (detectedMimeType) mimeType = detectedMimeType;
        } catch (error) {
            logger(`getMimeType: Failed to detect MIME type for ${attachment.key}, using stored type`, 2);
            // Fall back to stored type or default
            return mimeType || 'application/octet-stream';
        }
    }

    return mimeType;
}


/**
 * Detects the MIME type from in-memory file data.
 * This replicates the logic of Zotero.MIME.getMIMETypeFromFile without needing a file on disk.
 *
 * @param {Zotero.Item} attachment - The attachment item, used for the filename extension hint.
 * @param {Uint8Array|ArrayBuffer} fileData - The binary content of the file.
 * @returns {string} The detected MIME type, or the stored MIME type if detection fails.
 */
export function getMimeTypeFromData(attachment: Zotero.Item, fileData: Uint8Array | ArrayBuffer): string {
    if (!attachment.isAttachment()) return '';

    const mimeType = attachment.attachmentContentType;


    // Validate/correct MIME type by checking actual file if needed
    if (!mimeType || mimeType === 'application/octet-stream' || mimeType === '') {
        // File data check
        if (!fileData) return mimeType;

        // Ensure we have a Uint8Array to work with
        const data = (fileData instanceof Uint8Array) ? fileData : new Uint8Array(fileData);

        // Take a sample from the beginning of the file for sniffing.
        const sampleSize = 512;
        const sampleBytes = data.slice(0, sampleSize);

        // Convert the binary sample to a string
        let sampleString = '';
        for (let i = 0; i < sampleBytes.length; i++) {
            sampleString += String.fromCharCode(sampleBytes[i]);
        }

        // Get the file extension from the attachment's filename as a hint.
        const extension = (attachment.attachmentFilename.split('.').pop() || '').toLowerCase();

        // Use Zotero's internal data-based MIME type detection
        return Zotero.MIME.getMIMETypeFromData(sampleString, extension);
    }

    return mimeType;
}



export async function shortItemTitle(item: Zotero.Item): Promise<string> {
    const parentItem = item.isTopLevelItem() ? item : item.parentItem;

    if (parentItem && parentItem.isRegularItem()) {
        return getDisplayNameFromItem(parentItem);
    }

    if (parentItem && parentItem.isAttachment()) {
        return parentItem.getField('title') || '';
    }

    return '';
}

/**
 * Loads full item data for a list of Zotero items.
 * @param items - The Zotero items to load data for.
 * @param options - The options for loading the data.
 * @returns A promise that resolves when the data is loaded.
 */
export async function loadFullItemData(
    items: Zotero.Item[],
    options: {
        includeParents: boolean,
        includeChildren: boolean,
        dataTypes: string[]
    } = {
        includeParents: true,
        includeChildren: true,
        dataTypes: ["primaryData", "creators", "itemData", "childItems"]
    }
) {
    const { includeParents, includeChildren, dataTypes } = options;

    if (items.length === 0) return;
    
    // 1. Load main items
    await Zotero.Items.loadDataTypes(items, dataTypes);

    // 2. Collect parent and child IDs
    const parentIDs = includeParents
        ? items
            .map(item => item.parentID)
            .filter((id): id is number => Boolean(id))
        : [];

    const childIDs = includeChildren
        ? items
            .filter((item) => item.isRegularItem())
            .flatMap(item => item.getAttachments())
            .filter((id): id is number => Boolean(id))
        : [];

    // 3. Load parent and child items into memory
    const parentItems = parentIDs.length > 0 ? await Zotero.Items.getAsync(parentIDs) : [];
    const childItems = childIDs.length > 0 ? await Zotero.Items.getAsync(childIDs) : []; 
    
    // 4. Load child and parent items
    if (parentItems.length > 0 || childItems.length > 0) {
        const itemsToLoad = [...parentItems, ...childItems]
            .filter((item, index, self) => item && index === self.findIndex((i) => i.id === item.id));
        
        // Load all default data types (itemData, creators, etc.) for display
        await Zotero.Items.loadDataTypes(itemsToLoad, dataTypes);
    }
}

export async function loadFullItemDataWithAllTypes(items: Zotero.Item[] = []) {
    await loadFullItemData(items, {
        includeParents: true,
        includeChildren: true,
        dataTypes: ["primaryData", "creators", "itemData", "childItems", "tags", "collections", "relations", "note"]
    });
}


/**
 * Load all parent data for items
 */
export async function loadParentData(items: Zotero.Item[]): Promise<void> {
    const parentIdsToLoad = new Set<number>();

    // Collect all unique parent IDs
    for (const item of items) {
        let current = item;
        while (current?.parentID) {
            parentIdsToLoad.add(current.parentID);
            const parent = await Zotero.Items.getAsync(current.parentID);
            if (!parent) break;
            current = parent;
        }
    }

    // Load all unique parents in parallel
    if (parentIdsToLoad.size > 0) {
        const parentLoadPromises = Array.from(parentIdsToLoad).map(
            parentId => Zotero.Items.getAsync(parentId).then(p => p?.loadAllData())
        );
        await Promise.all(parentLoadPromises);
    }
}

export async function getParentLoadPromises(item: Zotero.Item) {
    const promises = [];
    const seen = new Set();

    // Include item
    promises.push(item.loadAllData());
    seen.add(item.id);

    // Parents
    let current = item;
    while (current?.parentID) {
        const parent = await Zotero.Items.getAsync(current.parentID);
        if (!parent) break;

        const pid = parent.id;
        if (seen.has(pid)) break;
        seen.add(pid);

        promises.push(parent.loadAllData());
        current = parent;
    }

    return promises;
}


/**
 * Get the active Zotero library ID
 * @returns The active Zotero library ID, or null if no library is selected
 */
export function getActiveZoteroLibraryId(): number | null {
    const zoteroPane = Zotero.getActiveZoteroPane?.() as any;
    if (!zoteroPane) return null;

    if (typeof zoteroPane.getSelectedLibraryID === 'function') {
        const libraryID = zoteroPane.getSelectedLibraryID();
        if (typeof libraryID === 'number') {
            return libraryID;
        }
    }

    if (typeof zoteroPane.getSelectedCollection === 'function') {
        const collection = zoteroPane.getSelectedCollection();
        if (collection && typeof collection.libraryID === 'number') {
            return collection.libraryID;
        }
    }

    const selectedItems = zoteroPane.getSelectedItems?.();
    if (Array.isArray(selectedItems) && selectedItems.length > 0) {
        const itemLibraryId = selectedItems[0]?.libraryID;
        if (typeof itemLibraryId === 'number') {
            return itemLibraryId;
        }
    }

    const collectionsView = zoteroPane.collectionsView as any;
    const selectedTreeRow = collectionsView?._selectedTreeRow || collectionsView?._view?.selectedTreeRow;
    const treeLibraryId = selectedTreeRow?.ref?.libraryID ?? selectedTreeRow?.libraryID;
    if (typeof treeLibraryId === 'number') {
        return treeLibraryId;
    }

    return null;
};