
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

// "source" type attachment
export interface SourceAttachment extends BaseMessageAttachment {
    type: "source";
    chunk_ids?: string[]; // UUIDs as strings
}

// "annotation" type attachment
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

// "note" type attachment
export interface NoteAttachment extends BaseMessageAttachment {
    type: "note";
    parent_key?: string;
    note_content: string;
    date_modified?: string; // ISO string
}

/**
 * UIMessageAttachment represents attachments with additional UI metadata
 */

export interface UIAttachmentState {
    id: string;
    messageId: string;
    pinned: boolean;
    parentKey: string | null;
    timestamp: number;
}

export interface UISourceAttachment extends SourceAttachment, UIAttachmentState { }
export interface UIAnnotationAttachment extends AnnotationAttachment, UIAttachmentState { }
export interface UINoteAttachment extends NoteAttachment, UIAttachmentState { }

export type UIMessageAttachment = UISourceAttachment | UIAnnotationAttachment | UINoteAttachment;

/**
 * Type guards for MessageAttachment and UIMessageAttachment
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

export function isUISourceAttachment(attachment: UIMessageAttachment): attachment is UISourceAttachment {
    return attachment.type === "source";
}

export function isUIAnnotationAttachment(attachment: UIMessageAttachment): attachment is UIAnnotationAttachment {
    return attachment.type === "annotation";
}

export function isUINoteAttachment(attachment: UIMessageAttachment): attachment is UINoteAttachment {
    return attachment.type === "note";
}
