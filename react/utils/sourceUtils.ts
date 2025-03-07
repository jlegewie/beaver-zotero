import { v4 as uuidv4 } from 'uuid';
import { ZoteroSource, FileSource, RemoteFileSource, Source } from '../types/sources';
import { createZoteroURI } from './zoteroURI';
import { truncateText } from './stringUtils';

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

/**
* Factory function to create a ZoteroSource from a Zotero item
*/
export function getNameFromItem(item: Zotero.Item): string {
    const name = item.isNote()
        ? `Note: "${truncateText(item.getNoteTitle(), MAX_NOTE_TITLE_LENGTH)}"`
        // @ts-ignore Beaver exists
        : Zotero.Beaver.citationService.formatCitation(item, true);
    return name;
}

export function getCitationFromItem(item: Zotero.Item): string {
    const citation = item.isNote()
        ? `Note: "${truncateText(item.getNoteTitle(), MAX_NOTE_TITLE_LENGTH)}"`
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

export async function createZoteroSource(
    item: Zotero.Item,
    pinned: boolean = false
): Promise<ZoteroSource> {
    const bestAtt = item.isRegularItem() ? await item.getBestAttachment() : null;

    return {
        id: uuidv4(),
        identifier: `${item.libraryID}-${item.key}`,
        type: 'zotero_item',
        libraryID: item.libraryID,
        itemKey: item.key,
        icon: item.getItemTypeIconName(),
        name: getNameFromItem(item),
        citation: getCitationFromItem(item),
        reference: getReferenceFromItem(item),
        url: createZoteroURI(item),
        parentKey: item.parentKey || null,
        isRegularItem: item.isRegularItem(),
        isNote: item.isNote(),
        pinned: pinned,
        childItemKeys: bestAtt ? [bestAtt.key] : [],
        timestamp: Date.now(),
    };
}

/**
* Factory function to create a FileSource from a File
*/
export function createFileSource(file: File): FileSource {
    return {
        id: uuidv4(),
        identifier: `${file.mozFullPath}`,
        type: 'file',
        fileName: file.name,
        filePath: file.mozFullPath,
        fileType: file.type,
        name: file.name,
        citation: 'File',
        reference: file.mozFullPath,
        url: `file://${file.mozFullPath}`,
        icon: file.type === 'application/pdf' ? 'attachmentPDF' : 'attachmentImage',
        pinned: false,
        timestamp: Date.now()
    };
}

/**
* Source method: Get the Zotero item from a ZoteroSource
*/
export function getZoteroItem(source: ZoteroSource): Zotero.Item | null {
    try {
        const item = Zotero.Items.getByLibraryAndKey(source.libraryID, source.itemKey);
        return item || null;
    } catch (error) {
        console.error("Error retrieving Zotero item:", error);
        return null;
    }
}

/**
* Source method: Get child items for a ZoteroSource
*/
export function getChildItems(source: ZoteroSource): Zotero.Item[] {
    if (!source.childItemKeys || source.childItemKeys.length === 0) {
        return [];
    }
    
    try {
        const childItems = source.childItemKeys
            .map(key => Zotero.Items.getByLibraryAndKey(source.libraryID, key))
            .filter(Boolean) as Zotero.Item[];
        
        return childItems;
    } catch (error) {
        console.error("Error retrieving child items:", error);
        return [];
    }
}

/**
* Source method: Check if a source is valid
*/
export const isValidRegularItem = async (source: ZoteroSource, item: Zotero.Item): Promise<boolean> => {
    if (source.childItemKeys.length == 0) return false;
    const bestAttachment = await item.getBestAttachment();
    if (!bestAttachment) return false;
    if (!source.childItemKeys.includes(bestAttachment.key)) return false;
    const isBestAttachmentValid = await isValidAttachment(bestAttachment);
    return isBestAttachmentValid;
}

export const isValidAttachment = async (att: Zotero.Item): Promise<boolean> => {
    if (!att.isAttachment()) return false;
    const exists = await att.fileExists();
    // @ts-ignore getAttachmentMIMEType exists
    const mimeType = att.getAttachmentMIMEType();
    return exists && isValidMimeType(mimeType);
}

export async function isSourceValid(source: Source): Promise<boolean> {
    switch (source.type) {
        case 'zotero_item': {
            const item = getZoteroItem(source);
            if (!item) return false;
            if (item.isNote()) return true;
            if (item.isAttachment()) return await isValidAttachment(item);
            if (item.isRegularItem()) return await isValidRegularItem(source,item);
            return false;
        }
        case 'file':
            // TODO: Implement file existence check
            return true;
        case 'remote_file':
            // TODO: Potentially check if URL is valid/reachable
            return Boolean(source.url);
        default:
            return false;
    }
}

/**
* Source method: Convert source to database-friendly format
*/
export function sourceToDb(source: Source): any {
    // Strip any circular references or complex objects
    return { ...source };
}

/**
* Source method: Create source from database data
*/
export function sourceFromDb(data: any): Source | null {
    if (!data || !data.type) return null;
    
    switch (data.type) {
        case 'zotero_item':
            return data as ZoteroSource;
        case 'file':
            return data as FileSource;
        case 'remote_file':
            return data as RemoteFileSource;
        default:
            return null;
    }
}

export function revealSource(source: Source) {
    if (source.type === 'zotero_item') {
        const itemID = Zotero.Items.getIDFromLibraryAndKey(source.libraryID, source.itemKey);
        if (itemID && Zotero.getActiveZoteroPane()) {
            // @ts-ignore selectItem exists
            Zotero.getActiveZoteroPane().itemsView.selectItem(itemID);
        }
    } else if (source.type === 'file') {
        Zotero.File.reveal(source.filePath);
    }
}

export async function openSource(source: Source) {
    if (source.type === 'zotero_item') {
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

    } else if (source.type === 'file') {
        Zotero.launchFile(source.filePath);
    }
}