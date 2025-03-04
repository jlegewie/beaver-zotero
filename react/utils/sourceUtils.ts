import { v4 as uuidv4 } from 'uuid';
import { ZoteroSource, FileSource, RemoteFileSource, Source } from '../types/sources';
import { getInTextCitation } from './citationFormatting';

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
* Define source names
*/
function getNameForZoteroSource(item: Zotero.Item): string {
    const citation = getInTextCitation(item, false)
        .replace(/,? ?n\.d\.$/, '');
    return item.isNote() ? `Note: ${citation}` : citation;
}

function getNameForFileSource(file: File): string {
    return file.name;
}


/**
* Factory function to create a ZoteroSource from a Zotero item
*/
export async function createZoteroSource(
    item: Zotero.Item,
    pinned: boolean = false
): Promise<ZoteroSource> {
    const bestAtt = item.isRegularItem() ? await item.getBestAttachment() : null;
    return {
        id: uuidv4(),
        type: 'zotero_item',
        libraryID: item.libraryID,
        itemKey: item.key,
        icon: item.getItemTypeIconName(),
        name: getNameForZoteroSource(item),
        pinned: pinned,
        childItemKeys: bestAtt ? [bestAtt.key] : [],
        timestamp: Date.now()
    };
}

/**
* Factory function to create a FileSource from a File
*/
export function createFileSource(file: File): FileSource {
    return {
        id: uuidv4(),
        type: 'file',
        fileName: file.name,
        filePath: file.mozFullPath,
        fileType: file.type,
        name: getNameForFileSource(file),
        icon: file.type === 'application/pdf' ? 'attachmentPDF' : 'attachmentImage',
        pinned: false,
        timestamp: Date.now()
    };
}

/**
* Factory function to create a RemoteFileSource
*/
export function createRemoteFileSource(url: string, name: string): RemoteFileSource {
    return {
        id: uuidv4(),
        type: 'remote_file',
        name,
        icon: 'link',
        url,
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
        const childItems = 
            source.childItemKeys.map(key => 
                Zotero.Items.getByLibraryAndKey(source.libraryID, key)
            )
        
        return childItems.filter(Boolean) as Zotero.Item[];
    } catch (error) {
        console.error("Error retrieving child items:", error);
        return [];
    }
}

/**
* Source method: Check if a source is valid
*/
export const isValidZoteroItem = async (item: Zotero.Item): Promise<boolean> => {
    if (item.isNote()) return true;
    const attachmentItem: Zotero.Item | false = item.isRegularItem() ? await item.getBestAttachment() : item;
    const attachmentExists = attachmentItem ? await attachmentItem.fileExists() : false;
    // @ts-ignore getAttachmentMIMEType exists
        const mimeType = attachmentItem ? attachmentItem.getAttachmentMIMEType() : '';
    return attachmentExists && isValidMimeType(mimeType);
}

export async function isSourceValid(source: Source, confirmChildItems: boolean = false): Promise<boolean> {
    switch (source.type) {
        case 'zotero_item': {
            const item = getZoteroItem(source);
            if (!item) return false;
            const isValid = await isValidZoteroItem(item);
            if (item.isRegularItem() && confirmChildItems) {
                const childItems = getChildItems(source);
                const childItemValidities = await Promise.all(childItems.map(isValidZoteroItem));
                return isValid && childItemValidities.length > 0 && childItemValidities.some(Boolean);
            }
            return isValid;
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