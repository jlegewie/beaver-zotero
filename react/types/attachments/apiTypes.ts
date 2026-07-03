/**
 * MessageAttachment represents an attachment in a message.
 * Mirrors the pydantic models SourceAttachment, AnnotationAttachment, NoteAttachment
 */

import type { AttachmentStub, ItemStub } from "../zotero";

// Valid annotation types
export const VALID_ANNOTATION_TYPES = ["highlight", "underline", "note", "image"] as const;
export type ValidAnnotationType = typeof VALID_ANNOTATION_TYPES[number];

export function isValidAnnotationType(type: _ZoteroTypes.Annotations.AnnotationType): type is ValidAnnotationType {
    return VALID_ANNOTATION_TYPES.includes(type as ValidAnnotationType);
}

export type MessageAttachment =
    | SourceAttachment
    | ItemMetadataAttachment
    | AnnotationAttachment
    | NoteAttachment
    | CollectionAttachment
    | ExternalFileAttachment;

interface BaseMessageAttachment {
    library_id: number;
    zotero_key: string;
}

export interface ItemMetadataAttachment extends BaseMessageAttachment {
    type: "item";
    item?: ItemStub;
}

// "source" type attachment (Zotero attachment item)
export type SourceAttachmentInclude = "none"| "metadata" | "fulltext" | "chunks" | "custom";
export interface SourceAttachment extends BaseMessageAttachment {
    type: "source";
    attachment?: AttachmentStub;
    parent_item?: ItemStub;
    include: SourceAttachmentInclude;

    chunk_ids?: string[]; // UUIDs as strings
    custom_content?: string;
}

// "annotation" type attachment (Zotero annotation item)
export interface AnnotationAttachment extends BaseMessageAttachment {
    type: "annotation";
    parent_key: string;
    annotation_type: ValidAnnotationType;
    text?: string;
    comment?: string;
    color: string;
    page_label: string;
    position: AnnotationPosition;
    date_modified: string;
    image_base64?: string;
}

// "note" type attachment (Zotero note item)
export interface NoteAttachment extends BaseMessageAttachment {
    type: "note";
    parent_key?: string;      // Optional - standalone notes have no parent
    title?: string;            // Derived from note content (getNoteTitle())
    date_modified?: string;    // ISO string
}

// "collection" type attachment (explicit collection reference)
export interface CollectionAttachment extends BaseMessageAttachment {
    type: "collection";
    name: string;
    parent_key: string | null;
}

export interface TagAttachment {
    type: "tag";
    name: string;
    library_id?: number | null;
    color?: string | null;
}

export type AnswerReference =
    | ItemMetadataAttachment
    | CollectionAttachment
    | TagAttachment;

export type ExternalFileContentKind = 'pdf' | 'epub' | 'text' | 'image';

/**
 * "external_file" type attachment: a user-attached file from disk (not a
 * Zotero item). Metadata only — the file content stays on this device and is
 * served on demand through the read/view request paths. Does not extend
 * BaseMessageAttachment (no library_id/zotero_key); the model-facing id is
 * `ext-<ext_key>`. Never includes a file path (privacy).
 */
export interface ExternalFileAttachment {
    type: "external_file";
    /** 8-character key assigned at attach time (Zotero-style object key). */
    ext_key: string;
    /** File basename only — never a path. */
    filename: string;
    content_kind: ExternalFileContentKind;
    mime_type: string;
    /** File size in bytes. */
    file_size: number;
    /** Page count when known at attach time (PDFs, best-effort). */
    page_count?: number;
    /** ISO timestamp of when the file was attached. */
    date_added?: string;
}

/**
 * ReaderState represents the state of a reader.
 *
 * Note: current_page is 1-based (first page = 1). For PDFs it is the PDF.js
 * page number. For EPUBs it is the current page reported by the reader view.
 */
export interface ReaderState {
    library_id: number;
    zotero_key: string;
    current_page: number | null;
    /** Reader type. Lets the backend route the active reader's selection to the
     *  correct locator model. Omitted only for unrecognized reader types. */
    content_kind?: 'pdf' | 'epub' | 'snapshot';
    text_selection?: TextSelection;
    annotations?: Annotation[];
}

export interface NoteState {
    library_id: number;
    zotero_key: string;
    parent_key?: string;
    title?: string;
}

/**
 * TextSelection represents a text selection in a reader.
 *
 * Note: page is 1-based (first page = 1) and matches ReaderState.current_page's
 * coordinate system.
 */
export interface TextSelection {
    text: string;
    page?: number;
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
    annotation_type: ValidAnnotationType;
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

export function isCollectionAttachment(attachment: MessageAttachment): attachment is CollectionAttachment {
    return attachment.type === "collection";
}

export function isExternalFileAttachment(attachment: MessageAttachment): attachment is ExternalFileAttachment {
    return attachment.type === "external_file";
}

/**
 * Stable key for any message attachment: `ext-<KEY>` for external files,
 * `<library_id>-<zotero_key>` otherwise. Use this instead of reading
 * `library_id`/`zotero_key` off the union directly — external files have
 * neither.
 */
export function messageAttachmentKey(attachment: MessageAttachment): string {
    if (isExternalFileAttachment(attachment)) {
        return `ext-${attachment.ext_key}`;
    }
    return `${attachment.library_id}-${attachment.zotero_key}`;
}

/**
 * Converter
 */

export function toMessageAttachment(attachment: SourceAttachment): MessageAttachment {
    return attachment;
}
