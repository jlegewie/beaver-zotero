import { getDisplayNameFromItem } from "../../react/utils/sourceUtils";
import { ZoteroItemReference } from "../../react/types/zotero";
import type { CreatorJSON } from "../../react/types/agentActions/base";
import { logger } from "./logger";

/**
 * Context for determining where to create or insert a new Zotero item
 */
export interface ZoteroTargetContext {
    targetLibraryId: number | undefined;
    parentReference: ZoteroItemReference | null;
    collectionToAddTo: Zotero.Collection | null;
}

/**
 * Determines the target location for creating a new item based on current Zotero context.
 * Handles both reader view (uses current document's library/parent) and library view (uses selected item or collection).
 * @returns Target library ID, parent reference, and optional collection
 */
export async function getZoteroTargetContext(): Promise<ZoteroTargetContext> {
    const win = Zotero.getMainWindow();
    const zp = Zotero.getActiveZoteroPane();
    
    let targetLibraryId: number | undefined = undefined;
    let parentReference: ZoteroItemReference | null = null;
    let collectionToAddTo: Zotero.Collection | null = null;

    // Reader view - check if we're in a reader tab
    const selectedTabType = win.Zotero_Tabs?.selectedType;
    if (selectedTabType === 'reader') {
        const reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
        if (reader?.itemID) {
            const readerItem = await Zotero.Items.getAsync(reader.itemID);
            if (readerItem) {
                targetLibraryId = readerItem.libraryID;
                parentReference = readerItem.parentKey
                    ? { library_id: readerItem.libraryID, zotero_key: readerItem.parentKey }
                    : null;
                return { targetLibraryId, parentReference, collectionToAddTo };
            }
        }
    }

    // Library view
    const selectedItems = zp.getSelectedItems();
    
    // If items are selected, use the first one
    if (selectedItems.length >= 1) {
        const firstItem = selectedItems[0];
        const item = firstItem.isAnnotation() && firstItem.parentItem ? firstItem.parentItem : firstItem;
        targetLibraryId = item.libraryID;
        
        if (item.isRegularItem()) {
            parentReference = { library_id: item.libraryID, zotero_key: item.key };
        } else if (item.isNote() || item.isAttachment()) {
            // Add to parent (sibling)
            parentReference = item.parentKey
                ? { library_id: item.libraryID, zotero_key: item.parentKey }
                : null;
        }
    // No selection - add to current library/collection
    } else {
        targetLibraryId = zp.getSelectedLibraryID();
        const collection = zp.getSelectedCollection();
        if (collection) {
            collectionToAddTo = collection;
        }
        parentReference = null;
    }

    return { targetLibraryId, parentReference, collectionToAddTo };
}

/**
 * Synchronous version of getZoteroTargetContext for UI state determination.
 * Uses sync Zotero.Items.get() which works because items are loaded when open in reader.
 * @returns Target library ID, parent reference, and optional collection
 */
export function getZoteroTargetContextSync(): ZoteroTargetContext {
    const win = Zotero.getMainWindow();
    const zp = Zotero.getActiveZoteroPane();
    
    let targetLibraryId: number | undefined = undefined;
    let parentReference: ZoteroItemReference | null = null;
    let collectionToAddTo: Zotero.Collection | null = null;

    // Reader view - check if we're in a reader tab
    const selectedTabType = win.Zotero_Tabs?.selectedType;
    if (selectedTabType === 'reader') {
        const reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
        if (reader?.itemID) {
            const readerItem = Zotero.Items.get(reader.itemID);
            if (readerItem) {
                targetLibraryId = readerItem.libraryID;
                parentReference = readerItem.parentKey
                    ? { library_id: readerItem.libraryID, zotero_key: readerItem.parentKey }
                    : null;
                return { targetLibraryId, parentReference, collectionToAddTo };
            }
        }
    }

    // Library view
    const selectedItems = zp.getSelectedItems();
    
    // If items are selected, use the first one
    if (selectedItems.length >= 1) {
        const firstItem = selectedItems[0];
        const item = firstItem.isAnnotation() && firstItem.parentItem ? firstItem.parentItem : firstItem;
        targetLibraryId = item.libraryID;
        
        if (item.isRegularItem()) {
            parentReference = { library_id: item.libraryID, zotero_key: item.key };
        } else if (item.isNote() || item.isAttachment()) {
            // Add to parent (sibling)
            parentReference = item.parentKey
                ? { library_id: item.libraryID, zotero_key: item.parentKey }
                : null;
        }
    // No selection - add to current library/collection
    } else {
        targetLibraryId = zp.getSelectedLibraryID();
        const collection = zp.getSelectedCollection();
        if (collection) {
            collectionToAddTo = collection;
        }
        parentReference = null;
    }

    return { targetLibraryId, parentReference, collectionToAddTo };
}


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
            // Use onRow callback to avoid Proxy issues with Zotero.DB.queryAsync
            await Zotero.DB.queryAsync(sql, chunk, {
                onRow: (row: any) => {
                    const itemID = row.getResultByIndex(0);
                    const clientDateModified = row.getResultByIndex(1);
                    if (clientDateModified) {
                        try {
                            result.set(
                                itemID,
                                Zotero.Date.sqlToISO8601(clientDateModified),
                            );
                        } catch (e) {
                            logger(`getClientDateModifiedBatch: Could not parse clientDateModified '${clientDateModified}' for item ${itemID}. This item will not be included in date-based batching.`, 2);
                        }
                    }
                }
            });
        } catch (error) {
            logger(`getClientDateModifiedBatch: Error processing chunk ${i}-${i + chunk.length}: ${(error as Error).message}`, 1);
            throw error;
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
    // First try to get the Zotero account user ID (only exists if user has Zotero sync enabled)
    const userID = Zotero.Users.getCurrentUserID();
    
    // Get local user key - this always exists
    const localUserKey = Zotero.Users.getLocalUserKey();

    return {
        userID: userID ? `${userID}` : undefined,
        localUserKey: `${localUserKey}`
    }
}

export function isLibraryEditable(libraryId: number): boolean {
    const library = Zotero.Libraries.get(libraryId);
    if (!library) {
        return false;
    }
    // Library must be editable AND files must be editable to create annotations
    return library.editable && library.filesEditable;
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

export function isLibrarySkipped(library: _ZoteroTypes.Library.LibraryLike): boolean {;
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
        return parentItem.getField('title', false, true) || '';
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

/**
 * Get the current library in the library view, or the library of the currently open file
 * when in Zotero reader.
 *
 * @returns The current library object, or null if no library is available
 */
export function getCurrentLibrary(): _ZoteroTypes.Library.LibraryLike | null {
	const win = Zotero.getMainWindow();
	if (!win) {
		return null;
	}
	
	// Check if we're in a reader tab
	if (win.Zotero_Tabs && win.Zotero_Tabs.selectedType === 'reader') {
		const reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
		if (reader && reader.itemID) {
			const item = Zotero.Items.get(reader.itemID);
			if (item && item.libraryID) {
				return Zotero.Libraries.get(item.libraryID) || null;
			}
		}
		return null;
	}
	
	// Otherwise, get library from library view
	const zp = win.ZoteroPane;
	if (zp && zp.collectionsView) {
		const libraryID = zp.getSelectedLibraryID();
		if (libraryID) {
			return Zotero.Libraries.get(libraryID) || null;
		}
	}
	
	return null;
}

/**
 * Creates a citation HTML string for a Zotero item
 * @param {Zotero.Item|Number|String} itemOrID - Zotero item object or item ID
 * @param {String} [page] - Optional page number or locator (e.g., "123", "123-145")
 * @returns {String} HTML string with citation markup
 */
export function createCitationHTML(itemOrID: Zotero.Item | number | string, page?: string): string {
    // Get the item if an ID was passed
    const item = typeof itemOrID === 'object' ? itemOrID : Zotero.Items.get(itemOrID);
    
    if (!item) {
        throw new Error('Item not found');
    }
    
    // Handle attachments: cite the parent item if it exists
    let itemToCite = item;
    if (item.isAttachment()) {
        if (item.parentID) {
            itemToCite = Zotero.Items.get(item.parentID);
            if (!itemToCite || !itemToCite.isRegularItem()) {
                throw new Error('Attachment parent is not a regular item');
            }
        } else {
            throw new Error('Cannot cite standalone attachments - they must have a parent item');
        }
    }
    
    if (!itemToCite.isRegularItem()) {
        throw new Error('Item is not a regular item and cannot be cited');
    }
    
    // Convert item to CSL JSON format
    const itemData = Zotero.Utilities.Item.itemToCSLJSON(itemToCite);
    
    // Get the item URI
    const uri = Zotero.URI.getItemURI(itemToCite);
    
    // Create citation item with optional page locator
    const citationItem: any = {
        uris: [uri],
        itemData: itemData
    };
    
    // Add page locator if provided
    if (page) {
        citationItem.locator = page;
        citationItem.label = "page";
    }
    
    // Create citation object
    const citation = {
        citationItems: [citationItem],
        properties: {}
    };
    
    // Format the citation text (e.g., "(Author, Year)" or "(Author, Year, p. 123)")
    const formatted = Zotero.EditorInstanceUtilities.formatCitation(citation);
    
    // Create the HTML span element
    const citationHTML = `<span class="citation" data-citation="${encodeURIComponent(JSON.stringify(citation))}">${formatted}</span>`;
    
    return citationHTML;
}

// Citation without page
// const citation1 = createCitationHTML(item);

// Citation with page number
// const citation2 = createCitationHTML(item, "123");

// Citation with page range
// const citation3 = createCitationHTML(item, "123-145");

/**
 * Extract available details from a Zotero item for debugging/logging purposes.
 * Safely handles malformed or partial item objects.
 * 
 * @param item Zotero item (or any object) to extract details from
 * @returns String with available item details
 */
export const getItemDetailsForLogging = (item: any): string => {
    if (!item) return "item is null/undefined";
    const details: string[] = [];
    try {
        if (item.id !== undefined) details.push(`id=${item.id}`);
        if (item.key !== undefined) details.push(`key=${item.key}`);
        if (item.libraryID !== undefined) details.push(`libraryID=${item.libraryID}`);
        if (item.itemType !== undefined) details.push(`itemType=${item.itemType}`);
        if (item.itemTypeID !== undefined) details.push(`itemTypeID=${item.itemTypeID}`);
        if (item.version !== undefined) details.push(`version=${item.version}`);
        if (item.parentID !== undefined) details.push(`parentID=${item.parentID}`);
        if (item.parentKey !== undefined) details.push(`parentKey=${item.parentKey}`);
        if (item.deleted !== undefined) details.push(`deleted=${item.deleted}`);
        if (item.synced !== undefined) details.push(`synced=${item.synced}`);
        if (item.dateAdded !== undefined) details.push(`dateAdded=${item.dateAdded}`);
        if (item.dateModified !== undefined) details.push(`dateModified=${item.dateModified}`);
        // Log what methods are available
        const methods = ['isInTrash', 'isRegularItem', 'isAttachment', 'isNote', 'isAnnotation'];
        const availableMethods = methods.filter(m => typeof item[m] === 'function');
        const missingMethods = methods.filter(m => typeof item[m] !== 'function');
        if (availableMethods.length > 0) details.push(`availableMethods=[${availableMethods.join(',')}]`);
        if (missingMethods.length > 0) details.push(`missingMethods=[${missingMethods.join(',')}]`);
        // Log constructor name if available
        if (item.constructor?.name) details.push(`constructor=${item.constructor.name}`);
    } catch (e) {
        details.push(`(error extracting details: ${e})`);
    }
    return details.length > 0 ? details.join(', ') : "no details available";
};

/**
 * Safely check trash status on a Zotero item.
 * Returns null if the item is missing the isInTrash method or if the call throws.
 * 
 * Background: Some edge cases (e.g., corrupted items) can cause isInTrash to be
 * missing or throw. This wrapper provides a safe way to check trash status.
 * 
 * @param item Zotero item (or any object) to check
 * @returns true if in trash, false if not, null if unable to determine
 */
export const safeIsInTrash = (item: any): boolean | null => {
    if (!item || typeof item.isInTrash !== "function") {
        logger(`safeIsInTrash: isInTrash not found. Item details: ${getItemDetailsForLogging(item)}`, 2);
        return null;
    }

    try {
        return item.isInTrash();
    } catch (error: any) {
        logger(`safeIsInTrash: isInTrash threw error="${error?.message ?? error}". Item details: ${getItemDetailsForLogging(item)}`, 2);
        return null;
    }
};

/**
 * Safely check if an attachment file exists.
 * 
 * Unlike item.fileExists(), this handles linked URL attachments which have no
 * associated file. Calling fileExists() on a linked URL throws an error.
 * 
 * @param item - Zotero item to check
 * @returns Promise<boolean> - true if file exists, false otherwise (including for linked URLs and non-attachments)
 */
export async function safeFileExists(item: Zotero.Item): Promise<boolean> {
    if (!item.isAttachment()) return false;
    
    // Linked URLs are web links with no associated file - fileExists() throws on them
    if (item.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL) {
        return false;
    }
    
    return item.fileExists();
}

/**
 * Check if an attachment is a linked URL (web link with no file).
 * 
 * Linked URL attachments don't have an associated file and calling fileExists()
 * on them throws an error.
 * 
 * @param item - Zotero item to check
 * @returns true if the item is a linked URL attachment
 */
export function isLinkedUrlAttachment(item: Zotero.Item): boolean {
    return item.isAttachment() && item.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL;
}

/**
 * Check if two Zotero items are duplicates based on metadata similarity.
 * Uses logic similar to Zotero's built-in duplicate detection:
 * 1. Same ID = duplicate
 * 2. Different item types = not duplicate
 * 3. Matching DOI (case-insensitive) = duplicate
 * 4. Matching ISBN (cleaned) = duplicate
 * 5. Matching normalized title + (year within 1 OR matching creator) = duplicate
 * 
 * @param item1 First Zotero item to compare
 * @param item2 Second Zotero item to compare
 * @returns true if items are considered duplicates
 */
export function areItemsDuplicates(item1: Zotero.Item, item2: Zotero.Item): boolean {
    // Same item
    if (item1.id === item2.id) return true;
    
    // Different item types are not duplicates
    if (item1.itemTypeID !== item2.itemTypeID) return false;
    
    // DOI match (case-insensitive)
    const doi1 = item1.getField('DOI') as string;
    const doi2 = item2.getField('DOI') as string;
    if (doi1 && doi2) {
        return doi1.trim().toUpperCase() === doi2.trim().toUpperCase();
    }
    
    // ISBN match (cleaned)
    const isbn1 = item1.getField('ISBN') as string;
    const isbn2 = item2.getField('ISBN') as string;
    if (isbn1 && isbn2) {
        return Zotero.Utilities.cleanISBN(isbn1) === Zotero.Utilities.cleanISBN(isbn2);
    }
    
    // Title normalization and comparison
    const title1Raw = item1.getField('title', false, true) as string;
    const title2Raw = item2.getField('title', false, true) as string;
    
    if (!title1Raw || !title2Raw) return false;
    
    const normalizeTitle = (title: string): string => {
        return Zotero.Utilities.removeDiacritics(title)
            .replace(/[ !-/:-@[-`{-~]+/g, ' ')
            .trim()
            .toLowerCase();
    };
    
    const title1 = normalizeTitle(title1Raw);
    const title2 = normalizeTitle(title2Raw);
    
    if (title1 !== title2 || !title1) return false;
    
    // Year match (within 1 year)
    const year1 = parseInt(item1.getField('date', false, true) as string);
    const year2 = parseInt(item2.getField('date', false, true) as string);
    if (!isNaN(year1) && !isNaN(year2) && Math.abs(year1 - year2) <= 1) {
        return true;
    }
    
    // Creator match (at least one last name + first initial)
    const creators1 = item1.getCreators();
    const creators2 = item2.getCreators();
    
    for (const c1 of creators1) {
        const ln1 = Zotero.Utilities.removeDiacritics(c1.lastName || '').toLowerCase();
        const fi1 = c1.firstName 
            ? Zotero.Utilities.removeDiacritics(c1.firstName[0]).toLowerCase() 
            : '';
        
        for (const c2 of creators2) {
            const ln2 = Zotero.Utilities.removeDiacritics(c2.lastName || '').toLowerCase();
            const fi2 = c2.firstName 
                ? Zotero.Utilities.removeDiacritics(c2.firstName[0]).toLowerCase() 
                : '';
            
            if (ln1 === ln2 && fi1 === fi2) return true;
        }
    }
    
    return false;
}

/**
 * Deduplicate an array of Zotero items, prioritizing items from a preferred library.
 * When duplicates are found, keeps the item from the preferred library (default: 1).
 * 
 * @param items Array of Zotero items to deduplicate
 * @param preferredLibraryId Library ID to prioritize when choosing between duplicates (default: 1)
 * @returns Deduplicated array of items
 */
export function deduplicateItems(
    items: Zotero.Item[],
    preferredLibraryId: number = 1
): Zotero.Item[] {
    if (items.length <= 1) return items;
    
    const result: Zotero.Item[] = [];
    const processedIndices = new Set<number>();
    
    for (let i = 0; i < items.length; i++) {
        if (processedIndices.has(i)) continue;
        
        const item = items[i];
        let bestItem = item;
        
        // Find all duplicates of this item
        for (let j = i + 1; j < items.length; j++) {
            if (processedIndices.has(j)) continue;
            
            const otherItem = items[j];
            if (areItemsDuplicates(item, otherItem)) {
                processedIndices.add(j);
                
                // Prefer item from preferred library
                if (otherItem.libraryID === preferredLibraryId && bestItem.libraryID !== preferredLibraryId) {
                    bestItem = otherItem;
                }
            }
        }
        
        result.push(bestItem);
    }
    
    return result;
}


/**
 * Sanitize creator objects for Zotero's setCreators().
 * Zotero rejects creators that have both 'name' and 'firstName'/'lastName'
 * properties, even if one side is null. LLM output often includes name: null
 * on person creators.
 */
export function sanitizeCreators(creators: CreatorJSON[]): CreatorJSON[] {
    return creators.map(c => {
        const hasPersonFields = (c.firstName != null && c.firstName !== '') ||
                                (c.lastName != null && c.lastName !== '');
        if (hasPersonFields) {
            const { name, ...rest } = c as any;
            return rest as CreatorJSON;
        }
        if (c.name != null && c.name !== '') {
            const { firstName, lastName, ...rest } = c as any;
            return rest as CreatorJSON;
        }
        return c;
    });
}

/**
 * Primary fields that CAN be set via item.setField().
 * These are system fields that Zotero allows modification of directly.
 */
export const SETTABLE_PRIMARY_FIELDS = [
    'itemTypeID',
    'dateAdded', 
    'dateModified',
    'version',
    'synced',
    'createdByUserID',
    'lastModifiedByUserID'
] as const;

/**
 * Checks if a field can technically be edited/set via item.setField() for a given item.
 * Returns true only for fields that can actually be modified through setField().
 */
export function canSetField(item: Zotero.Item, field: string): boolean {
    // 1. Check if it's a settable primary field
    if ((SETTABLE_PRIMARY_FIELDS as readonly string[]).includes(field)) {
        return true;
    }
    
    // 2. Reject all other primary fields (they're read-only or have special setters)
    if (field === 'id' || Zotero.Items.isPrimaryField(field)) {
        return false;
    }

    const itemTypeID = item.itemTypeID;
    
    // 3. Resolve the field ID (handles name -> ID conversion)
    let fieldID = Zotero.ItemFields.getID(field);
    if (!fieldID) return false;

    // 4. Special handling for notes
    if (item.isNote()) {
        const fieldName = Zotero.ItemFields.getName(fieldID);
        return fieldName === 'title';
    }

    // 5. Resolve base field mappings
    fieldID = Zotero.ItemFields.getFieldIDFromTypeAndBase(itemTypeID, fieldID) || fieldID;

    // 6. Check the schema for validity
    return Zotero.ItemFields.isValidForType(fieldID, itemTypeID);
}
