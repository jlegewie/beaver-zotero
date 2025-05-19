import { v4 as uuidv4 } from 'uuid';
import { InputSource, ThreadSource } from '../types/sources';
import { truncateText } from './stringUtils';
import { syncingItemFilter } from '../../src/utils/sync';
import { isValidAnnotationType } from '../types/attachments/apiTypes';

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
        // @ts-ignore Beaver exists
        : Zotero.Beaver.citationService.formatCitation(item, true);

    // Add a count
    if (count && count > 1) displayName = `${displayName} (${count})`;

    return displayName;
}

export function getCitationFromItem(item: Zotero.Item): string {
    const citation = item.isNote()
        ? "Note"
        // @ts-ignore Beaver exists
        : Zotero.Beaver.citationService.formatCitation(item, true);
    return citation;
}

export function getReferenceFromItem(item: Zotero.Item): string {
    const reference = item.isNote()
        // @ts-ignore unescapeHTML exists
        ? truncateText(Zotero.Utilities.unescapeHTML(item.getNote()), MAX_NOTE_CONTENT_LENGTH)
        // @ts-ignore Beaver exists
        : Zotero.Beaver.citationService.formatBibliography(item);
    return reference.replace(/\n/g, '<br />');
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

export function createThreadSourceFromItem(item: Zotero.Item): ThreadSource {
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
    } as ThreadSource;
}


export function organizeSourcesByRegularItems(sources: InputSource[]): InputSource[] {
    const regularItemSources = sources.filter((s) => s.type === "regularItem");
    return sources.reduce((acc, source) => {
        // If the source is not a regular item, skip it (already in regularItemSources)
        if(source.type === "regularItem") return acc;

        // If the source has no parent or is an annotation, add it to the accumulator
        if(!source.parentKey || source.type === "annotation") {
            acc.push(source);
            return acc;
        }

        // Get the parent key
        const parent = acc.find((s) => s.itemKey === source.parentKey);
        
        // If the parent is not in the accumulator, add it
        if(!parent) {
            const parentItem = getParentItem(source);
            if(!parentItem) return acc;
            acc.push({
                ...source,
                id: uuidv4(),
                itemKey: parentItem.key,
                type: "regularItem",
                parentKey: null,
                childItemKeys: [source.itemKey]
            } as InputSource);
            return acc;
        }

        // Add the source to the parent
        parent.childItemKeys.push(source.itemKey);

        return acc;
    }, regularItemSources);
}

export function createSourceFromAttachmentOrNote(
    item: Zotero.Item,
    pinned: boolean = false
): ThreadSource {
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
export function getZoteroItem(source: InputSource): Zotero.Item | null {
    try {
        const item = Zotero.Items.getByLibraryAndKey(source.libraryID, source.itemKey);
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