import { v4 as uuidv4 } from 'uuid';
import { atom } from "jotai";
import { Attachment, ZoteroAttachment, FileAttachment, RemoteFileAttachment } from "../types/attachments";
import { threadAttachmentKeysAtom } from "./messages";
import { getFormattedReferences } from '../../src/utils/citations'

/**
 * Factory functions to create attachments from Zotero items and files
 */
export function createAttachmentFromZoteroItem(
    item: Zotero.Item,
    pinned: boolean = false
): ZoteroAttachment {
    // Get the formatted reference from Zotero item
    const formattedReferences = getFormattedReferences([item])[0]
    
    // Return attachment object
    return {
        id: uuidv4(),
        type: "zotero_item",
        shortName: formattedReferences.inTextCitation,
        fullName: formattedReferences.bibliography,
        pinned: pinned,
        item: item,
        timestamp: Date.now()
    } as ZoteroAttachment;
}

export function createAttachmentFromFile(file: File): FileAttachment {
    return {
        id: uuidv4(),
        type: "file",
        shortName: file.name,
        fullName: file.name,
        pinned: true,
        filePath: file.name,
        timestamp: Date.now()
    };
}


/**
 * Atom to store the attachments with setters to add, remove, and toggle pinned attachments
 */
export const attachmentsAtom = atom<Attachment[]>([]);

export const updateAttachmentsFromSelectedItemsAtom = atom(
    null,
    (get, set, selectedItems: Zotero.Item[]) => {
        const currentAttachments = get(attachmentsAtom);
        const threadAttachmentKeys = get(threadAttachmentKeysAtom);

        // Map of existing Zotero attachments by item.key
        const existingMap = new Map(
            currentAttachments
                .filter((att) => att.type === 'zotero_item')
                .map((att) => [att.item.key, att])
        );

        // Pinned attachments
        const pinnedAttachments = currentAttachments
            .filter((att) => att.type === 'zotero_item' && att.pinned) as ZoteroAttachment[];
        
        // Excluded keys
        const excludedKeys = new Set([
            ...removedItemKeysCache,
            ...threadAttachmentKeys,
            ...pinnedAttachments.map((att) => att.item.key)
        ]);

        // Updated list of attachments
        const newAttachments = [
            ...pinnedAttachments,
            ...selectedItems
                .filter((item) => !excludedKeys.has(item.key))
                .map((item) => {
                    if (existingMap.has(item.key)) {
                        return existingMap.get(item.key)!;
                    }
                    return createAttachmentFromZoteroItem(item, false);
                })
        ];

        // Combine with non-Zotero attachments (e.g. file attachments) that already exist.
        const nonZoteroAttachments = currentAttachments.filter((att) => att.type !== 'zotero_item');

        // Update state: merge and sort by timestamp.
        set(
            attachmentsAtom,
            [...newAttachments, ...nonZoteroAttachments].sort((a, b) => a.timestamp - b.timestamp)
        );
    }
);

// Setter to add a file attachment
export const addFileAttachmentAtom = atom(
    null,
    (get, set, file: File) => {
        const currentAttachments = get(attachmentsAtom);
        // Use file.name as a unique identifier for files
        const exists = currentAttachments.find(
            (att) => att.type === 'file' && att.filePath === file.name
        );
        if (!exists) {
            set(attachmentsAtom, [...currentAttachments, createAttachmentFromFile(file)]);
        }
    }
);

// Setter to remove an attachment by id
export const removedItemKeysCache: Set<string> = new Set();
export const removeAttachmentAtom = atom(
    null,
    (get, set, attachment: Attachment) => {
        const currentAttachments = get(attachmentsAtom);
        if (attachment.type === 'zotero_item') {
            removedItemKeysCache.add(attachment.item.key);
        }
        set(
            attachmentsAtom,
            currentAttachments.filter((att) => att.id !== attachment.id)
        );
    }
);

// Setter to toggle the pinned state of an attachment by id
export const togglePinAttachmentAtom = atom(
    null,
    (get, set, attachmentId: string) => {
        const currentAttachments = get(attachmentsAtom);
        const updated = currentAttachments.map((att) =>
            att.id === attachmentId ? { ...att, pinned: !att.pinned } : att
        );
        set(attachmentsAtom, updated);
    }
);


/**
 * Validate attachments
 */

// TODO: Add more mime types ('text/html')
const VALID_MIME_TYPES = ['application/pdf', 'image/png'] as const;
type ValidMimeType = typeof VALID_MIME_TYPES[number];

function isValidMimeType(mimeType: string): mimeType is ValidMimeType {
    return VALID_MIME_TYPES.includes(mimeType as ValidMimeType);
}

export const isValidAttachment = async (attachment: Attachment): Promise<boolean> => {
    if (attachment.type === 'zotero_item') {
        const item = attachment.item;
        if (item.isNote()) return true;
        const attachmentItem: Zotero.Item | false = item.isRegularItem() ? await item.getBestAttachment() : item;
        const attachmentExists = attachmentItem ? await attachmentItem.fileExists() : false;
        // @ts-ignore getAttachmentMIMEType exists
        const mimeType = attachmentItem ? attachmentItem.getAttachmentMIMEType() : '';
        return attachmentExists && isValidMimeType(mimeType);
    }
    return true;
}
