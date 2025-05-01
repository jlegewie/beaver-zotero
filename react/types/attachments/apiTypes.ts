/**
 * MessageAttachment represents an attachment in a message.
 * Mirrors the pydantic models SourceAttachment, AnnotationAttachment, NoteAttachment
 */

export type MessageAttachment =
    | SourceAttachment
    | AnnotationAttachment
    | NoteAttachment;

interface BaseMessageAttachment {
    library_id: number;
    zotero_key: string;
}

// "source" type attachment (Zotero attachment item)
export interface SourceAttachment extends BaseMessageAttachment {
    type: "source";
    chunk_ids?: string[]; // UUIDs as strings
}

// "annotation" type attachment (Zotero annotation item)
export interface AnnotationAttachment extends BaseMessageAttachment {
    type: "annotation";
    parent_key: string;
    annotation_type: string;
    text?: string;
    comment?: string;
    color?: string;
    page_label?: string;
    position?: Record<string, any>;
    // position?: { x: number; y: number; page?: number };
    date_modified?: string; // ISO string
}

// "note" type attachment (Zotero note item)
export interface NoteAttachment extends BaseMessageAttachment {
    type: "note";
    parent_key?: string;
    note_content: string;
    date_modified?: string; // ISO string
}

/**
 * Type guards for MessageAttachment
 */
export function isSourceAttachment(attachment: MessageAttachment): attachment is SourceAttachment {
    return attachment.type === "source";
}

export function isAnnotationAttachment(attachment: MessageAttachment): attachment is AnnotationAttachment {
    return attachment.type === "annotation";
}

export function isNoteAttachment(attachment: MessageAttachment): attachment is NoteAttachment {
    return attachment.type === "note";
}

/**
 * Converter
 */

export function toMessageAttachment(attachment: SourceAttachment): MessageAttachment {
    return attachment;
}