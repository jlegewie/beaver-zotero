import { truncateText } from './stringUtils';
import { syncingItemFilter, syncingItemFilterAsync, isSupportedItem, isLibraryValidForSync } from '../../src/utils/sync';
import { isValidAnnotationType, SourceAttachment } from '../types/attachments/apiTypes';
import { selectItemById } from '../../src/utils/selectItem';
import { CitationData } from '../types/citations';
import { ZoteroItemReference } from '../types/zotero';
import { searchableLibraryIdsAtom, syncWithZoteroAtom} from '../atoms/profile';
import { store } from '../store';
import { userIdAtom } from '../atoms/auth';
import { isAttachmentOnServer } from '../../src/utils/webAPI';

// Constants
export const MAX_NOTE_TITLE_LENGTH = 20;
export const MAX_NOTE_CONTENT_LENGTH = 150;

// Limits
export const FILE_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB
export const MAX_ATTACHMENTS = 10;
export const MAX_PAGES = 100;

export const VALID_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg'] as const;
type ValidMimeType = typeof VALID_MIME_TYPES[number];

function isValidMimeType(mimeType: string): mimeType is ValidMimeType {
    return VALID_MIME_TYPES.includes(mimeType as ValidMimeType);
}

export function getDisplayNameFromItem(item: Zotero.Item, count: number | null = null): string {
    let displayName: string;
    
    if (item.isNote()) {
        displayName = `Note: "${truncateText(item.getNoteTitle(), MAX_NOTE_TITLE_LENGTH)}"`;
    } else if(item.isAttachment() && !item.parentItem) {
        displayName = item.getField('title') || '';
    } else {
        const firstCreator = item.firstCreator || 'Unknown Author';
        const year = item.getField('date')?.match(/\d{4}/)?.[0] || '';
        displayName = `${firstCreator}${year ? ` ${year}` : ''}`;
    }
    
    if (count && count > 1) displayName = `${displayName} (${count})`;
    return displayName;
}

export function getReferenceFromItem(item: Zotero.Item): string {
    const formatted_citation = item.isNote()
        // @ts-ignore unescapeHTML exists
        ? truncateText(Zotero.Utilities.unescapeHTML(item.getNote()), MAX_NOTE_CONTENT_LENGTH)
        : Zotero.Beaver.citationService.formatBibliography(item);
    return formatted_citation.replace(/\n/g, '<br />');
}


/**
* Source method: Get the Zotero item from a Source
*/
export function getZoteroItem(source: SourceAttachment | CitationData): Zotero.Item | null {
    try {
        let libId: number;
        let itemKeyValue: string;
        if (!source.library_id || !source.zotero_key) return null;

        if ('library_id' in source && 'zotero_key' in source) {
            libId = source.library_id;
            itemKeyValue = source.zotero_key;
        } else {
            console.error("getZoteroItem: Source object does not have expected key structure (libraryID/itemKey or library_id/zotero_key):", source);
            return null;
        }
        const item = Zotero.Items.getByLibraryAndKey(libId, itemKeyValue);
        return item || null;
    } catch (error) {
        console.error("Error retrieving Zotero item:", error);
        return null;
    }
}

/**
 * Check if an item was added before the last sync
 * @param item The item to check
 * @param syncWithZotero Whether to use Zotero sync
 * @param userID The user ID
 * @returns True if the item was added before the last sync
 */
export async function wasItemAddedBeforeLastSync(item: Zotero.Item, syncWithZotero: boolean, userID: string): Promise<boolean> {
    let syncLog = null;
    if (syncWithZotero) {
        syncLog = await Zotero.Beaver.db.getSyncLogWithHighestVersion(userID, item.libraryID);
    } else {
        syncLog = await Zotero.Beaver.db.getSyncLogWithMostRecentDate(userID, item.libraryID);
    }

    if (!syncLog) {
        return false;
    }

    const lastSyncDate = syncLog.library_date_modified;
    const itemDateAdded = item.dateAdded;
    const lastSyncDateSQL = Zotero.Date.isISODate(lastSyncDate) 
        ? Zotero.Date.isoToSQL(lastSyncDate) 
        : lastSyncDate;
    
    // Item was added before the last sync
    return itemDateAdded <= lastSyncDateSQL;
}

/**
* Source method: Check if a source is valid
*/
export async function isValidZoteroItem(item: Zotero.Item): Promise<{valid: boolean, error?: string}> {

    // User ID
    const userID = store.get(userIdAtom);
    if (!userID) return {valid: false, error: "User ID not found. Make sure you are logged in."};

    // Item library
    const library = Zotero.Libraries.get(item.libraryID);
    if (!library) {
        return {valid: false, error: "Library not found"};
    }

    // Is library searchable?
    const libraryIds = store.get(searchableLibraryIdsAtom);
    if (!libraryIds.includes(item.libraryID)) {
        const library_name = library ? library.name : undefined;
        return {
            valid: false,
            error: library_name
                ? `The library "${library_name}" is not synced with Beaver.`
                : "This library is not synced with Beaver."};
    }

    // Is the library valid for sync?
    const syncWithZotero = store.get(syncWithZoteroAtom);
    if (library.isGroup && !syncWithZotero) {
        return {valid: false, error: `The group library "${library.name}" cannot be synced with Beaver because the setting "Coordinate with Zotero Sync" is disabled.`};
    }

    if (!isLibraryValidForSync(library, syncWithZotero)) {
        return {valid: false, error: `The group library "${library.name}" cannot be synced with Beaver. Please check Beaver Preferences to resolve this issue.`};
    }

    // ------- Regular items -------
    if (item.isRegularItem()) {
        if (item.isInTrash()) return {valid: false, error: "Item is in trash"};

        // (a) Pass the syncing filter
        if (!(await syncingItemFilterAsync(item))) {
            return {valid: false, error: "File not available for sync"};
        }

        // (b) If syncWithZotero is true, check whether item has been synced with Zotero
        if (syncWithZotero && item.version === 0 && !item.synced) {
            return {valid: false, error: "Item not yet synced with Zotero and therefore not available in Beaver."};
        }
        
        // (c) Check whether item was added after the last sync
        if (!(await wasItemAddedBeforeLastSync(item, syncWithZotero, userID))) {
            return {valid: false, error: "Item not yet synced with Beaver. Please wait for sync to complete or sync manually in settings."};
        }

        return {valid: true};
    }

    // ------- Attachments -------
    else if (item.isAttachment()) {

        // (a) Check if attachment is supported
        if (!isSupportedItem(item)) {
            return {valid: false, error: "Beaver only supports PDF attachments"};
        }

        // (b) Check if attachment is in trash
        if (item.isInTrash()) return {valid: false, error: "Item is in trash"};

        
        // (c) Check if file exists locally or on server
        if (!(await item.fileExists()) && !isAttachmentOnServer(item)) {
            return {valid: false, error: "File unavailable locally and on server"};
        }

        // (d) Use comprehensive syncing filter
        if (!(await syncingItemFilterAsync(item))) {
            return {valid: false, error: "Attachment not synced with Beaver"};
        }
        
        // (e) If syncWithZotero is true, check whether item has been synced with Zotero
        if (syncWithZotero && item.version === 0 && !item.synced) {
            return {valid: false, error: "Attachment not yet synced with Zotero and therefore not available in Beaver."};
        }

        // (f) Check whether attachment was added after the last sync
        if (!(await wasItemAddedBeforeLastSync(item, syncWithZotero, userID))) {
            return {valid: false, error: "Attachment not yet synced with Beaver. Please wait for sync to complete or sync manually in settings."};
        }

        // Confirm upload status
        // const userId = store.get(userIdAtom) || '';
        // const attachment = await Zotero.Beaver.db.getAttachmentByZoteroKey(userId, item.libraryID, item.key);
        // if (!attachment) return {valid: false, error: "Attachment not found"};
        // if (attachment.upload_status !== 'completed') return {valid: false, error: "Attachment not uploaded"};

        return {valid: true};
    }

    // ------- Annotations -------
    else if (item.isAnnotation()) {
        // (a) Check if the annotation type is valid
        if (!isValidAnnotationType(item.annotationType)) return {valid: false, error: "Invalid annotation type"};

        // (b) Check if annotation is empty
        if (item.annotationType === 'underline' && !item.annotationText && !item.annotationComment) return {valid: false, error: "Annotation is empty"};
        if (item.annotationType === 'highlight' && !item.annotationText && !item.annotationComment) return {valid: false, error: "Annotation is empty"};
        // if (item.annotationType === 'note' && !item.annotationText && !item.annotationComment) return {valid: false, error: "Annotation is empty"};

        // (c) Check if the parent exists and is an attachment
        const parent = item.parentItem;
        if (!parent || !parent.isAttachment()) return {valid: false, error: "Parent item is not an attachment"};

        // (d) Check if the parent exists and is syncing
        if (!syncingItemFilter(parent)) return {valid: false, error: "Parent item is not syncing"};

        // (e) Check if the parent file exists
        const hasFile = await parent.fileExists();
        if (!hasFile) return {valid: false, error: "Parent file does not exist"};

        // (f) If syncWithZotero is true, check whether item has been synced with Zotero
        if (syncWithZotero && parent.version === 0 && !parent.synced) {
            return {valid: false, error: "Attachment not yet synced with Zotero and therefore not available in Beaver."};
        }

        // (g) Check whether attachment was added after the last sync
        if (!(await wasItemAddedBeforeLastSync(parent, syncWithZotero, userID))) {
            return {valid: false, error: "Attachment not yet synced with Beaver. Please wait for sync to complete or sync manually in settings."};
        }

        return {valid: true};
    }

    // ------- Notes -------
    else if (item.isNote()) {
        return {valid: false, error: "Notes not supported"};
    }

    return {valid: false, error: "Invalid item type"};
}

export function revealSource(source: ZoteroItemReference | SourceAttachment | CitationData) {
    if (!source.library_id || !source.zotero_key) return;
    const itemID = Zotero.Items.getIDFromLibraryAndKey(source.library_id, source.zotero_key);
    if (itemID && Zotero.getActiveZoteroPane()) {
        selectItemById(itemID);
    }
}

export async function openSource(source: SourceAttachment | CitationData) {
    const item = getZoteroItem(source);
    if (!item) return;
    
    // Regular items
    if (item.isRegularItem()) {
        const bestAttachment = await item.getBestAttachment();
        if (bestAttachment) {
            Zotero.getActiveZoteroPane().viewAttachment(bestAttachment.id);
        }
    }

    // Attachments
    if (item.isAttachment()) {
        Zotero.getActiveZoteroPane().viewAttachment(item.id);
    }

    // Notes
    if (item.isNote()) {
        // @ts-ignore selectItem exists
        await Zotero.getActiveZoteroPane().openNoteWindow(item.id);
    }
}