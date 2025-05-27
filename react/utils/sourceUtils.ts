import { v4 as uuidv4 } from 'uuid';
import { InputSource } from '../types/sources';
import { truncateText } from './stringUtils';
import { syncingItemFilter } from '../../src/utils/sync';
import { isValidAnnotationType } from '../types/attachments/apiTypes';
import { MessageAttachmentWithId } from '../types/attachments/uiTypes';

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
    // Get the display name
    let displayName = item.isNote()
        ? `Note: "${truncateText(item.getNoteTitle(), MAX_NOTE_TITLE_LENGTH)}"`
        : Zotero.Beaver.citationService.formatCitation(item, true);

    // Add a count
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

export function createSourceFromItemSync(item: Zotero.Item): InputSource {
    const type = getSourceTypeFromItem(item);

    return {
        id: uuidv4(),
        type: type,
        libraryID: item.libraryID,
        itemKey: item.key,
        pinned: false,
        parentKey: item.parentKey || null,
        childItemKeys: [],
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
            acc.push(createSourceFromAttachmentOrNote(zoteroItem));
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

export function createSourceFromAttachmentOrNote(
    item: Zotero.Item,
    pinned: boolean = false
): InputSource {
    if (item.isRegularItem()) {
        throw new Error("Cannot call createSourceFromAttachment on a regular item");
    }
    return {
        id: uuidv4(),
        libraryID: item.libraryID,
        itemKey: item.key,
        pinned: pinned,
        timestamp: Date.now(),
        type: item.isNote() ? "note" : "attachment",
        parentKey: item.parentKey || null,
        childItemKeys: [],
    };
}

/**
* Source method: Get the Zotero item from a Source
*/
export function getZoteroItem(source: InputSource | MessageAttachmentWithId): Zotero.Item | null {
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
export async function isValidZoteroItem(item: Zotero.Item): Promise<boolean> {
    // Regular items have to pass the syncingItemFilter and have attachments or notes
    if (item.isRegularItem()) {
        if (!syncingItemFilter(item)) return false;
        if ((item.getAttachments().length + item.getNotes().length) == 0) return false;
        return true;
    } 
    // Attachments have to pass the syncingItemFilter and exist
    else if (item.isAttachment()) {
        if (!syncingItemFilter(item)) return false;
        if (item.isAttachment()) return await item.fileExists();
    }
    // Annotation item parent have to pass the syncing filter and exist
    else if (item.isAnnotation()) {
        // Check if the annotation type is valid
        if (!isValidAnnotationType(item.annotationType)) return false;

        // Check if annotation is empty
        if (item.annotationType === 'underline' && !item.annotationText && !item.annotationComment) return false;
        if (item.annotationType === 'highlight' && !item.annotationText && !item.annotationComment) return false;
        if (item.annotationType === 'note' && !item.annotationText && !item.annotationComment) return false;

        // Check if the parent exists and is an attachment
        const parent = item.parentItem;
        if (!parent || !parent.isAttachment()) return false;

        // Check if the parent exists and is syncing
        if (!syncingItemFilter(parent)) return false;

        // Check if the parent file exists
        return await parent.fileExists();
    }
    // Notes are invalid (NoteAttachments are not yet supported)
    else if (item.isNote()) {
        return false;
    }
    return false;
}

export async function isSourceValid(source: InputSource): Promise<boolean> {
    const item = getZoteroItem(source);
    if (!item) return false;
    return await isValidZoteroItem(item);
}

export function revealSource(source: InputSource) {
    const itemID = Zotero.Items.getIDFromLibraryAndKey(source.libraryID, source.itemKey);
    if (itemID && Zotero.getActiveZoteroPane()) {
        // @ts-ignore selectItem exists
        Zotero.getActiveZoteroPane().itemsView.selectItem(itemID);
    }
}

export async function openSource(source: InputSource) {
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