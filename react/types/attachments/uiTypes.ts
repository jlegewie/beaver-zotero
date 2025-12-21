import { SourceAttachment, AnnotationAttachment, NoteAttachment, MessageAttachment, ItemMetadataAttachment } from "./apiTypes";

/**
 * Attachment with messageId and optional item.
 * The item is populated lazily when needed - attachments start as metadata-only
 * and items are loaded on-demand via getZoteroItem() or similar.
 */
export interface SourceAttachmentWithId extends SourceAttachment {
    messageId: string;
    item?: Zotero.Item;
}

export interface AnnotationAttachmentWithId extends AnnotationAttachment {
    messageId: string;
    item?: Zotero.Item;
}

export interface NoteAttachmentWithId extends NoteAttachment {
    messageId: string;
    item?: Zotero.Item;
}

export interface ItemMetadataAttachmentWithId extends ItemMetadataAttachment {
    messageId: string;
    item?: Zotero.Item;
}

