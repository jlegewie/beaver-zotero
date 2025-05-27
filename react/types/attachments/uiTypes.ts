import { SourceAttachment, AnnotationAttachment, NoteAttachment, MessageAttachment } from "./apiTypes";

export interface SourceAttachmentWithId extends SourceAttachment {
    messageId: string;
}

export interface AnnotationAttachmentWithId extends AnnotationAttachment {
    messageId: string;
}

export interface NoteAttachmentWithId extends NoteAttachment {
    messageId: string;
}

export type MessageAttachmentWithId =
    | SourceAttachmentWithId
    | AnnotationAttachmentWithId
    | NoteAttachmentWithId;

export function getUniqueKey(attachment: MessageAttachment | MessageAttachmentWithId): string {
    return `${attachment.library_id}-${attachment.zotero_key}`;
}

export interface AttachmentCitation extends SourceAttachment {
    parentKey: string | null;    // Key of the parent item
    icon: string | null;         // Icon for the zotero attachment
    name: string;                // Display name
    citation: string;            // In-text citation
    formatted_citation: string;  // Bibliographic reference
    url: string;                 // URL for the zotero attachment
    numericCitation: string;     // Numeric citation
}
