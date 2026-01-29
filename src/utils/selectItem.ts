import { logger } from "./logger";

/**
 * Enhanced item selection that ensures the item is visible before selecting it
 * @param itemId - The ID of the item to select
 * @param changeView - Whether to change the view to the library root
 * @param collectionId - Optional collection ID to navigate to instead of library root
 * @returns True if item was successfully selected, false otherwise
 */
export async function selectItemById(itemId: number, changeView: boolean = true, collectionId?: number) {
    if (!itemId) return false;

    // Get the item to check its properties
    const item = await Zotero.Items.getAsync(itemId);
    if (!item) return false;

    const zoteroPane = Zotero.getActiveZoteroPane();
    if (!zoteroPane || !zoteroPane.collectionsView) return false;

    // Check if item is in the currently visible collection/library
    const isItemVisible = await checkItemVisibility(itemId);
    
    if (!isItemVisible && changeView) {
        let success = false;
        
        // If a collection ID is provided, try to navigate to that collection first
        if (collectionId) {
            const collection = Zotero.Collections.get(collectionId);
            if (collection) {
                success = await switchToCollection(collection.id);
            }
        }
        
        // Fall back to library root if collection navigation failed or wasn't requested
        if (!success) {
            success = await switchToLibraryRoot(item.libraryID);
        }
        
        if (!success) {
            logger(`Failed to switch to library ${item.libraryID}`, 2);
            return false;
        }
    }

    // Now select the item using the existing Zotero method
    try {
        const result = await zoteroPane.selectItem(itemId);
        return !!result;
    } catch (error) {
        logger(`Error selecting item ${itemId}: ${error}`, 2);
        return false;
    }
}

/**
 * Enhanced item selection that ensures the item is visible before selecting it
 * @param {Zotero.Item} item - The item to select
 * @param {boolean} changeView - Whether to change the view to the library root
 * @returns {Promise<boolean>} - True if item was successfully selected, false otherwise
 */
export async function selectItem(item: Zotero.Item, changeView: boolean = true) {
    if (!item) return false;

    const zoteroPane = Zotero.getActiveZoteroPane();
    if (!zoteroPane || !zoteroPane.collectionsView) return false;

    // Check if item is in the currently visible collection/library
    const isItemVisible = await checkItemVisibility(item.id);
    
    if (!isItemVisible && changeView) {        
        // Switch to the item's library root
        const success = await switchToLibraryRoot(item.libraryID);
        if (!success) {
            logger(`Failed to switch to library ${item.libraryID}`, 2);
            return false;
        }
    }

    // Now select the item using the existing Zotero method
    try {
        const result = await zoteroPane.selectItem(item.id);
        return !!result;
    } catch (error) {
        logger(`Error selecting item ${item.id}: ${error}`, 2);
        return false;
    }
}


/**
 * Check if an item is visible in the current collection/library view
 * @param {number} itemId - The ID of the item to check
 * @returns {Promise<boolean>} - True if item is visible, false otherwise
 */
async function checkItemVisibility(itemId: number) {
    const zoteroPane = Zotero.getActiveZoteroPane();
    if (!zoteroPane.itemsView) return false;

    // Wait for items to load
    await zoteroPane.itemsView.waitForLoad();
    
    // Check if the item exists in the current view's row map
    const rowIndex = zoteroPane.itemsView.getRowIndexByID(itemId.toString());
    return rowIndex !== false;
}

/**
 * Switch to a specific collection
 * @param collectionId - The ID of the collection to switch to
 * @returns True if successfully switched, false otherwise
 */
async function switchToCollection(collectionId: number): Promise<boolean> {
    const zoteroPane = Zotero.getActiveZoteroPane();
    if (!zoteroPane.collectionsView || !zoteroPane.itemsView) return false;

    try {
        const success = await zoteroPane.collectionsView.selectCollection(collectionId);
        if (success) {
            await zoteroPane.itemsView.waitForLoad();
        }
        return success;
    } catch (error) {
        logger(`Error switching to collection ${collectionId}: ${error}`, 2);
        return false;
    }
}

/**
 * Switch to the library root for a given library
 * @param libraryId - The ID of the library to switch to
 * @returns True if successfully switched, false otherwise
 */
async function switchToLibraryRoot(libraryId: number) {
    const zoteroPane = Zotero.getActiveZoteroPane();
    if (!zoteroPane.collectionsView || !zoteroPane.itemsView) return false;

    try {
        // Select the library root
        const success = await zoteroPane.collectionsView.selectLibrary(libraryId);
        if (success) {
            // Wait for the items view to load
            await zoteroPane.itemsView.waitForLoad();
        }
        return success;
    } catch (error) {
        logger(`Error switching to library ${libraryId}: ${error}`, 2);
        return false;
    }
}

/**
 * Selects a library in the Zotero collections view
 * @param {Zotero.Library} library - The library to select
 * @returns {Promise<boolean>} - True if successfully selected, false otherwise
 */
export async function selectLibrary(library: Zotero.Library) {
    if (!library) return false;

    const zoteroPane = Zotero.getActiveZoteroPane();
    if (!zoteroPane || !zoteroPane.collectionsView || !zoteroPane.itemsView) return false;

    try {
        const success = await zoteroPane.collectionsView.selectLibrary(library.libraryID);
        if (success) {
            await zoteroPane.itemsView.waitForLoad();
        }
        return success;
    } catch (error) {
        logger(`Error selecting library ${library.libraryID}: ${error}`, 2);
        return false;
    }
}

/**
 * Selects a collection in the Zotero collections view
 * @param {Zotero.Collection} collection - The collection to select
 * @returns {Promise<boolean>} - True if successfully selected, false otherwise
 */
export async function selectCollection(collection: Zotero.Collection) {
    if (!collection) return false;

    const zoteroPane = Zotero.getActiveZoteroPane();
    if (!zoteroPane || !zoteroPane.collectionsView || !zoteroPane.itemsView) return false;

    try {
        const success = await zoteroPane.collectionsView.selectCollection(collection.id);
        if (success) {
            await zoteroPane.itemsView.waitForLoad();
        }
        return success;
    } catch (error) {
        logger(`Error selecting collection ${collection.id}: ${error}`, 2);
        return false;
    }
}
