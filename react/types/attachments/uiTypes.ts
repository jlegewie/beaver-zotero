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