import { v4 as uuidv4 } from 'uuid';
import { InputSource } from '../types/sources';
import { truncateText } from './stringUtils';
import { syncingItemFilter, syncingItemFilterAsync } from '../../src/utils/sync';
import { isValidAnnotationType, SourceAttachment } from '../types/attachments/apiTypes';
import { MessageAttachmentWithId } from '../types/attachments/uiTypes';
import { selectItemById } from '../../src/utils/selectItem';
import { CitationData } from '../types/citations';
import { syncLibraryIdsAtom } from '../atoms/profile';
import { store } from '../store';

// Constants
export const MAX_NOTE_TITLE_LENGTH = 20;
export const MAX_NOTE_CONTENT_LENGTH = 150;

// Limits
export const FILE_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB
export const MAX_ATTACHMENTS = 10;
export const MAX_PAGES = 100;

// TODO: Add more mime types as needed
export const VALID_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg'] as const;
type ValidMimeType = typeof VALID_MIME_TYPES[number];

function isValidMimeType(mimeType: string): mimeType is ValidMimeType {
    return VALID_MIME_TYPES.includes(mimeType as ValidMimeType);
}

export function getDisplayNameFromItem(item: Zotero.Item, count: number | null = null): string {
    let displayName: string;
    
    if (item.isNote()) {
        displayName = `Note: "${truncateText(item.getNoteTitle(), MAX_NOTE_TITLE_LENGTH)}"`;
    } else {
        const firstCreator = item.firstCreator || 'Unknown Author';
        const year = item.getField('date')?.match(/\d{4}/)?.[0] || '';
        displayName = `${firstCreator} ${year ? year : ''}`;
    }
    
    if (count && count > 1) displayName = `${displayName} (${count})`;
    return displayName;
}

export function getCitationFromItem(item: Zotero.Item): string {
    const citation = item.isNote()
        ? "Note"
        : Zotero.Beaver.citationService.formatCitation(item, true);
    return citation;
}

export function getReferenceFromItem(item: Zotero.Item): string {
    const formatted_citation = item.isNote()
        // @ts-ignore unescapeHTML exists
        ? truncateText(Zotero.Utilities.unescapeHTML(item.getNote()), MAX_NOTE_CONTENT_LENGTH)
        : Zotero.Beaver.citationService.formatBibliography(item);
    return formatted_citation.replace(/\n/g, '<br />');
}

export function createSourceIdentifier(item: Zotero.Item): string {
    return `${item.libraryID}-${item.key}`;
}

export function getIdentifierFromItem(item: Zotero.Item): string {
    return `${item.libraryID}-${item.key}`;
}

export function getIdentifierFromSource(source: InputSource): string {
    return `${source.libraryID}-${source.itemKey}`;
}

export function getSourceTypeFromItem(item: Zotero.Item): InputSource["type"] {
    if (item.isRegularItem()) return "regularItem";
    if (item.isAttachment()) return "attachment";
    if (item.isNote()) return "note";
    if (item.isAnnotation()) return "annotation";
    throw new Error("Invalid item type");
}


/**
* Factory function to create a Source from a Zotero item
*/
export async function createSourceFromItem(
    item: Zotero.Item,
    pinned: boolean = false,
    excludeKeys: string[] = [],
    type?: InputSource["type"]
): Promise<InputSource> {
    type = type || getSourceTypeFromItem(item);
    const bestAtt = item.isRegularItem() ? await item.getBestAttachment() : null;

    return {
        id: uuidv4(),
        type: type,
        libraryID: item.libraryID,
        itemKey: item.key,
        pinned: pinned,
        parentKey: item.parentKey || null,
        childItemKeys: bestAtt && !excludeKeys.includes(bestAtt.key) ? [bestAtt.key] : [],
        timestamp: Date.now(),
    } as InputSource;
}


export function organizeSourcesByRegularItems(attachments: MessageAttachmentWithId[]): InputSource[] {
    return attachments.reduce((acc, attachment) => {
        const zoteroItem = getZoteroItem(attachment);

        // 1. Skip invalid items
        if(!zoteroItem) return acc;
        
        // 2. Add standalone attachments or annotations (no parent)
        if(!zoteroItem.parentItem || zoteroItem.isAnnotation()) {
            acc.push(createSourceFromAttachmentOrNoteOrAnnotation(zoteroItem));
            return acc;
        }

        // 3. Get or add parent source
        const parent = acc.find((s: InputSource) => s.itemKey === zoteroItem.parentKey);
        if(!parent) {
            acc.push({
                id: uuidv4(),
                type: "regularItem",
                messageId: attachment.messageId,
                libraryID: zoteroItem.libraryID,
                itemKey: zoteroItem.parentKey,
                pinned: false,
                parentKey: null,
                childItemKeys: [attachment.zotero_key]
            } as InputSource);
            return acc;
        } else {
            parent.childItemKeys.push(attachment.zotero_key);
        }

        return acc;
    }, [] as InputSource[]);
}

export function createSourceFromAttachmentOrNoteOrAnnotation(
    item: Zotero.Item,
    pinned: boolean = false
): InputSource {
    if (item.isRegularItem()) {
        throw new Error("Cannot call createSourceFromAttachment on a regular item");
    }
    let type: InputSource["type"] = "attachment";
    if (item.isAnnotation()) type = "annotation";
    if (item.isNote()) type = "note";
    if (item.isRegularItem()) type = "regularItem";

    return {
        id: uuidv4(),
        libraryID: item.libraryID,
        itemKey: item.key,
        pinned: pinned,
        timestamp: Date.now(),
        type: type,
        parentKey: item.parentKey || null,
        childItemKeys: [],
    };
}

/**
* Source method: Get the Zotero item from a Source
*/
export function getZoteroItem(source: InputSource | MessageAttachmentWithId | SourceAttachment | CitationData): Zotero.Item | null {
    try {
        let libId: number;
        let itemKeyValue: string;

        if ('libraryID' in source && 'itemKey' in source) {
            libId = source.libraryID;
            itemKeyValue = source.itemKey;
        } else if ('library_id' in source && 'zotero_key' in source) {
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
* Source method: Get the parent item from a Source
*/
export function getParentItem(source: InputSource): Zotero.Item | null {
    try {
        const parentItem = source.parentKey
            ? Zotero.Items.getByLibraryAndKey(source.libraryID, source.parentKey)
            : null;
        return parentItem || null;
    } catch (error) {
        console.error("Error retrieving Zotero item:", error);
        return null;
    }
}

/**
* Source method: Get child items for a Source
*/
export function getChildItems(source: InputSource): Zotero.Item[] {
    try {
        return source.childItemKeys
            .map(key => Zotero.Items.getByLibraryAndKey(source.libraryID, key))
            .filter(Boolean) as Zotero.Item[];
    } catch (error) {
        console.error("Error retrieving child items:", error);
        return [];
    }
}

/**
* Source method: Check if a source is valid
*/
export async function isValidZoteroItem(item: Zotero.Item): Promise<{valid: boolean, error?: string}> {

    // Is library synced?
    const libraryIds = store.get(syncLibraryIdsAtom);
    if (!libraryIds.includes(item.libraryID)) return {valid: false, error: "This item's library is not synced with Beaver."};

    // ------- Regular items -------
    if (item.isRegularItem()) {
        if (item.isInTrash()) return {valid: false, error: "Item is in trash"};

        // (a) Pass the syncing filter
        if (!(await syncingItemFilterAsync(item))) {
            return {valid: false, error: "File not available for sync"};
        }

        // (b) Has attachments or notes
        if ((item.getAttachments().length + item.getNotes().length) == 0) return {valid: false, error: "Item has no attachments or notes"};
        return {valid: true};
    }

    // ------- Attachments -------
    else if (item.isAttachment()) {
        if (!(item.isPDFAttachment() || item.isImageAttachment())) {
            return {valid: false, error: "Beaver only supports PDF and image files"};
        }

        if (item.isInTrash()) return {valid: false, error: "Item is in trash"};

        // Use the same comprehensive filter as sync
        if (!(await syncingItemFilterAsync(item))) {
            return {valid: false, error: "File not available for sync"};
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
        if (item.annotationType === 'note' && !item.annotationText && !item.annotationComment) return {valid: false, error: "Annotation is empty"};

        // (c) Check if the parent exists and is an attachment
        const parent = item.parentItem;
        if (!parent || !parent.isAttachment()) return {valid: false, error: "Parent item is not an attachment"};

        // (d) Check if the parent exists and is syncing
        if (!syncingItemFilter(parent)) return {valid: false, error: "Parent item is not syncing"};

        // (e) Check if the parent file exists
        const hasFile = await parent.fileExists();
        if (!hasFile) return {valid: false, error: "Parent file does not exist"};

        return {valid: true};
    }

    // ------- Notes -------
    else if (item.isNote()) {
        return {valid: false, error: "Notes not supported"};
    }

    return {valid: false, error: "Invalid item type"};
}

export async function isSourceValid(source: InputSource): Promise<{valid: boolean, error?: string}> {
    const item = getZoteroItem(source);
    if (!item) return {valid: false, error: "Item not found"};
    return await isValidZoteroItem(item);
}

export function revealSource(source: SourceAttachment | CitationData) {
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