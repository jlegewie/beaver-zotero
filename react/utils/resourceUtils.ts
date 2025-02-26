import { v4 as uuidv4 } from 'uuid';
import { ZoteroResource, FileResource, RemoteFileResource, Resource } from '../types/resources';
import { getInTextCitations } from '../../src/utils/citations';

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
* Factory function to create a ZoteroResource from a Zotero item
*/
export async function createZoteroResource(
    item: Zotero.Item,
    pinned: boolean = false
): Promise<ZoteroResource> {
    const bestAtt = item.isRegularItem() ? await item.getBestAttachment() : null;
    return {
        id: uuidv4(),
        type: 'zotero_item',
        libraryID: item.libraryID,
        itemKey: item.key,
        icon: item.getItemTypeIconName(),
        name: getInTextCitations([item])[0],
        pinned: pinned,
        childItemKeys: bestAtt ? [bestAtt.key] : [],
        timestamp: Date.now()
    };
}

/**
* Factory function to create a FileResource from a File
*/
export function createFileResource(file: File): FileResource {
    return {
        id: uuidv4(),
        type: 'file',
        fileName: file.name,
        filePath: file.mozFullPath,
        fileType: file.type,
        name: file.name,
        icon: file.type === 'application/pdf' ? 'attachmentPDF' : 'attachmentImage',
        pinned: false,
        timestamp: Date.now()
    };
}

/**
* Factory function to create a RemoteFileResource
*/
export function createRemoteFileResource(url: string, name: string): RemoteFileResource {
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
* Resource method: Get the Zotero item from a ZoteroResource
*/
export function getZoteroItem(resource: ZoteroResource): Zotero.Item | null {
    try {
        const item = Zotero.Items.getByLibraryAndKey(resource.libraryID, resource.itemKey);
        return item || null;
    } catch (error) {
        console.error("Error retrieving Zotero item:", error);
        return null;
    }
}

/**
* Resource method: Get child items for a ZoteroResource
*/
export function getChildItems(resource: ZoteroResource): Zotero.Item[] {
    if (!resource.childItemKeys || resource.childItemKeys.length === 0) {
        return [];
    }
    
    try {
        const childItems = 
            resource.childItemKeys.map(key => 
                Zotero.Items.getByLibraryAndKey(resource.libraryID, key)
            )
        
        return childItems.filter(Boolean) as Zotero.Item[];
    } catch (error) {
        console.error("Error retrieving child items:", error);
        return [];
    }
}

/**
* Resource method: Check if a resource is valid
*/
export const isValidZoteroItem = async (item: Zotero.Item): Promise<boolean> => {
    if (item.isNote()) return true;
    const attachmentItem: Zotero.Item | false = item.isRegularItem() ? await item.getBestAttachment() : item;
    const attachmentExists = attachmentItem ? await attachmentItem.fileExists() : false;
    // @ts-ignore getAttachmentMIMEType exists
        const mimeType = attachmentItem ? attachmentItem.getAttachmentMIMEType() : '';
    return attachmentExists && isValidMimeType(mimeType);
}

export async function isResourceValid(resource: Resource, confirmChildItems: boolean = false): Promise<boolean> {
    switch (resource.type) {
        case 'zotero_item': {
            const item = getZoteroItem(resource);
            if (!item) return false;
            const isValid = await isValidZoteroItem(item);
            if (item.isRegularItem() && confirmChildItems) {
                const childItems = getChildItems(resource);
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
            return Boolean(resource.url);
        default:
            return false;
    }
}

/**
* Resource method: Convert resource to database-friendly format
*/
export function resourceToDb(resource: Resource): any {
    // Strip any circular references or complex objects
    return { ...resource };
}

/**
* Resource method: Create resource from database data
*/
export function resourceFromDb(data: any): Resource | null {
    if (!data || !data.type) return null;
    
    switch (data.type) {
        case 'zotero_item':
            return data as ZoteroResource;
        case 'file':
            return data as FileResource;
        case 'remote_file':
            return data as RemoteFileResource;
        default:
            return null;
    }
}