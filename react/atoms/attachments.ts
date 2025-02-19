import { v4 as uuidv4 } from 'uuid';
import { getFormattedReferences } from '../../src/utils/citations'

// Valid mime types
// TODO: Add more mime types ('text/html')
const VALID_MIME_TYPES = ['application/pdf', 'image/png'] as const;
type ValidMimeType = typeof VALID_MIME_TYPES[number];

function isValidMimeType(mimeType: string): mimeType is ValidMimeType {
    return VALID_MIME_TYPES.includes(mimeType as ValidMimeType);
}


// Attachment interface and types
interface BaseAttachment {
    id: string;               // Unique identifier for tracking
    type: 'zotero_item' | 'file' | 'remote_file';
    shortName: string;        // Short name shown in the UI
    fullName: string;         // Detailed name shown in tooltip
    exists: boolean;          // Does the file/resource currently exist
    mimeType: string;         // MIME type (can be validated elsewhere)
    valid: boolean;           // Validity flag for the attachment
    invalidMessage?: string;  // Optional message explaining invalidity
    pinned: boolean;          // If true, the attachment persists across selections
}

interface ZoteroAttachment extends BaseAttachment {
    type: 'zotero_item';
    item: Zotero.Item;              // The parent item
    attachmentItem?: Zotero.Item;   // The actual item that will be attached (if different)
    filePath?: string;              // Local file path of the attachment
}

interface FileAttachment extends BaseAttachment {
    type: 'file';
    filePath: string;
}

interface RemoteFileAttachment extends BaseAttachment {
    type: 'remote_file';
    url: string;
}

export const createAttachmentFromZoteroItem = async (item: Zotero.Item): Promise<Attachment> => {
    // Get the formatted reference from Zotero item
    const formattedReferences = getFormattedReferences([item])[0]
    // Attachment data
    const attachmentData = {
        id: uuidv4(),
        type: 'zotero_item',
        shortName: formattedReferences.inTextCitation,
        fullName: formattedReferences.bibliography,
        item: item,
        pinned: false,
        valid: false
    }

    // Attachment item
    const attachmentItem: Zotero.Item | false = item.isRegularItem() ? await item.getBestAttachment() : item;
    const attachmentExists = attachmentItem ? await attachmentItem.fileExists() : false;
    // @ts-ignore getAttachmentMIMEType exists
    const mimeType = attachmentItem ? attachmentItem.getAttachmentMIMEType() : '';
    const filePath = attachmentItem ? await attachmentItem.getFilePath() : undefined;
    
    // Return attachment object
    return {
        ...attachmentData,
        attachmentItem: attachmentItem ?? undefined,
        exists: attachmentExists,
        // @ts-ignore getAttachmentMIMEType exists
        mimeType: mimeType,
        filePath: filePath,
        valid: Boolean(attachmentExists && isValidMimeType(mimeType) && filePath)
    } as ZoteroAttachment;

};