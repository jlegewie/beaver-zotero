import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { libraryRefForLibraryID } from '../../src/utils/libraryIdentity';
import { getSelectedCollection, getSelectedLibraryId } from '../../src/utils/zoteroSelection';
import { getContextWindow } from '../runtime/windowRuntime';


function makeZoteroItemReference(libraryID: number, zoteroKey: string): ZoteroItemReference {
    return {
        library_id: libraryID,
        zotero_key: zoteroKey,
        library_ref: libraryRefForLibraryID(libraryID) ?? undefined,
    };
}


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
export async function getZoteroTargetContext(win = getContextWindow()): Promise<ZoteroTargetContext> {
    const zp = win?.ZoteroPane;
    
    let targetLibraryId: number | undefined = undefined;
    let parentReference: ZoteroItemReference | null = null;
    let collectionToAddTo: Zotero.Collection | null = null;

    if (!win || win.closed || !zp) return { targetLibraryId, parentReference, collectionToAddTo };

    // Reader view - check if we're in a reader tab
    const selectedTabType = win.Zotero_Tabs?.selectedType;
    if (selectedTabType === 'reader') {
        const reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
        if (reader?.itemID) {
            const readerItem = await Zotero.Items.getAsync(reader.itemID);
            if (readerItem) {
                targetLibraryId = readerItem.libraryID;
                parentReference = readerItem.parentKey
                    ? makeZoteroItemReference(readerItem.libraryID, readerItem.parentKey)
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
            parentReference = makeZoteroItemReference(item.libraryID, item.key);
        } else if (item.isNote() || item.isAttachment()) {
            // Add to parent (sibling)
            parentReference = item.parentKey
                ? makeZoteroItemReference(item.libraryID, item.parentKey)
                : null;
        }
    // No selection - add to current library/collection
    } else {
        targetLibraryId = getSelectedLibraryId(zp) ?? undefined;
        const collection = getSelectedCollection(zp);
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
export function getZoteroTargetContextSync(win = getContextWindow()): ZoteroTargetContext {
    const zp = win?.ZoteroPane;
    
    let targetLibraryId: number | undefined = undefined;
    let parentReference: ZoteroItemReference | null = null;
    let collectionToAddTo: Zotero.Collection | null = null;

    if (!win || win.closed || !zp) return { targetLibraryId, parentReference, collectionToAddTo };

    // Reader view - check if we're in a reader tab
    const selectedTabType = win.Zotero_Tabs?.selectedType;
    if (selectedTabType === 'reader') {
        const reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
        if (reader?.itemID) {
            const readerItem = Zotero.Items.get(reader.itemID);
            if (readerItem) {
                targetLibraryId = readerItem.libraryID;
                parentReference = readerItem.parentKey
                    ? makeZoteroItemReference(readerItem.libraryID, readerItem.parentKey)
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
            parentReference = makeZoteroItemReference(item.libraryID, item.key);
        } else if (item.isNote() || item.isAttachment()) {
            // Add to parent (sibling)
            parentReference = item.parentKey
                ? makeZoteroItemReference(item.libraryID, item.parentKey)
                : null;
        }
    // No selection - add to current library/collection
    } else {
        targetLibraryId = getSelectedLibraryId(zp) ?? undefined;
        const collection = getSelectedCollection(zp);
        if (collection) {
            collectionToAddTo = collection;
        }
        parentReference = null;
    }

    return { targetLibraryId, parentReference, collectionToAddTo };
}



/**
 * Get the active Zotero library ID
 * @returns The active Zotero library ID, or null if no library is selected
 */
export function getActiveZoteroLibraryId(win = getContextWindow()): number | null {
    const zoteroPane = win?.ZoteroPane as any;
    if (!zoteroPane) return null;

    const libraryID = getSelectedLibraryId(zoteroPane);
    if (typeof libraryID === 'number') {
        return libraryID;
    }

    const collection = getSelectedCollection(zoteroPane);
    if (collection && typeof collection.libraryID === 'number') {
        return collection.libraryID;
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
}


/**
 * Get the current library in the library view, or the library of the currently open file
 * when in Zotero reader.
 *
 * @returns The current library object, or null if no library is available
 */
export function getCurrentLibrary(win = getContextWindow()): _ZoteroTypes.Library.LibraryLike | null {
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
		const libraryID = getSelectedLibraryId(zp);
		if (libraryID) {
			return Zotero.Libraries.get(libraryID) || null;
		}
	}
	
	return null;
}