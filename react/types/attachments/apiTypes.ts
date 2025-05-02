/**
 * MessageAttachment represents an attachment in a message.
 * Mirrors the pydantic models SourceAttachment, AnnotationAttachment, NoteAttachment
 */

export type MessageAttachment =
    | SourceAttachment
    | AnnotationAttachment
    | NoteAttachment
    | ReaderAttachment;

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
    annotation_type: "highlight" | "underline" | "note" | "image";
    text?: string;
    comment?: string;
    color: string;
    page_label: string;
    position: AnnotationPosition;
    date_modified: string;
}

// "note" type attachment (Zotero note item)
export interface NoteAttachment extends BaseMessageAttachment {
    type: "note";
    parent_key?: string;
    note_content: string;
    date_modified?: string; // ISO string
}

// "reader" type attachment (Zotero reader item)
export interface ReaderAttachment extends BaseMessageAttachment {
    type: "reader";
    current_page: number;
    text_selection?: TextSelection;
    annotations: Annotation[];
}

/**
 * TextSelection represents a text selection in a reader.
 */
export interface TextSelection {
    text: string;
    page: number;
}

/**
 * AnnotationPosition represents the position of an annotation in a reader.
 */
export interface AnnotationPosition {
    page_index: number;
    rects: number[][];
}

/**
 * Annotation represents an annotation in a reader.
 */
export interface Annotation {
    library_id: number;
    zotero_key: string;
    parent_key: string;
    // annotation_type: "ink" | "highlight" | "underline" | "note" | "image" | "text";
    annotation_type: "highlight" | "underline" | "note" | "image";
    text?: string;
    comment?: string;
    color: string;
    page_label: string;
    position: AnnotationPosition;
    date_modified: string; // Timestamp in "YYYY-MM-DD HH:MM:SS" format (not strict ISO)
    image_base64?: string;
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

export function isReaderAttachment(attachment: MessageAttachment): attachment is ReaderAttachment {
    return attachment.type === "reader";
}

/**
 * Converter
 */

export function toMessageAttachment(attachment: SourceAttachment): MessageAttachment {
    return attachment;
}