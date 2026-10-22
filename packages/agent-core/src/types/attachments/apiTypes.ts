import { resolveObjectIdReference } from '../../identity/libraryRef';
/**
 * MessageAttachment represents an attachment in a message.
 * Mirrors the pydantic models SourceAttachment, AnnotationAttachment, NoteAttachment
 */

import type { AttachmentStub, ItemStub } from "../zotero";
import type { TableReference } from "../../protocol/artifactProtocol";

// Valid annotation types
export const VALID_ANNOTATION_TYPES = ["highlight", "underline", "note", "image"] as const;
export type ValidAnnotationType = typeof VALID_ANNOTATION_TYPES[number];

// Accepts `string` so this module needs no ambient Zotero types. Callers pass
// a Zotero item's `annotationType` or a value parsed from drag/drop data, and
// rely on the predicate's own narrowing rather than the argument type.
export function isValidAnnotationType(type: string): type is ValidAnnotationType {
    return VALID_ANNOTATION_TYPES.includes(type as ValidAnnotationType);
}

export type MessageAttachment =
    | SourceAttachment
    | ItemMetadataAttachment
    | AnnotationAttachment
    | NoteAttachment
    | CollectionAttachment
    | SavedSearchAttachment
    | SpecialCollectionAttachment
    | TableAttachment
    | ExternalFileAttachment;

export interface TableAttachment {
    type: "table";
    reference: TableReference;
}

interface BaseMessageAttachment {
    library_id: number;
    zotero_key: string;
    /** Device-portable library identity ("u" | "g<groupID>"). See `src/utils/libraryIdentity.ts`. */
    library_ref?: string;
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
    collection_id?: string;
    parent_collection_id?: string;
    type: "collection";
    name: string;
    parent_key: string | null;
}

/**
 * "saved_search" type attachment: a saved search attached as the scope of a
 * request (a collection action run on it). `zotero_key` is the search key.
 *
 * Identified by its portable library only — no device-local `library_id` —
 * so the backend and history never carry one. Resolve the local library with
 * `resolveLibraryRef` where Zotero needs it.
 */
export interface SavedSearchAttachment {
    type: "saved_search";
    /** Device-portable library identity ("u" | "g<groupID>"). See `src/utils/libraryIdentity.ts`. */
    library_ref: string;
    zotero_key: string;
    name: string;
}

/** Built-in library views a request can be scoped to. */
export const SPECIAL_COLLECTION_TYPES = ['unfiled', 'publications', 'retracted'] as const;
export type SpecialCollectionType = typeof SPECIAL_COLLECTION_TYPES[number];

/**
 * "special_collection" type attachment: a built-in library view (Unfiled
 * Items, My Publications, Retracted Items) attached as the scope of a request.
 * Views have no key of their own; `special_collection` is Zotero's
 * collection-tree row type. Typed as `string` on the wire so a thread written
 * by a newer client still loads.
 */
export interface SpecialCollectionAttachment {
    type: "special_collection";
    special_collection: SpecialCollectionType | (string & {});
    library_id: number;
    /** Device-portable library identity ("u" | "g<groupID>"). See `src/utils/libraryIdentity.ts`. */
    library_ref?: string;
    /** Display name, as shown in the collections pane when attached. */
    name: string;
}

/** Saved searches and built-in views: collection-like scopes without a collection. */
export type ViewAttachment = SavedSearchAttachment | SpecialCollectionAttachment;

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
    /** Device-portable library identity ("u" | "g<groupID>"). See `src/utils/libraryIdentity.ts`. */
    library_ref?: string;
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
    /** Device-portable library identity ("u" | "g<groupID>"). See `src/utils/libraryIdentity.ts`. */
    library_ref?: string;
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
    /** Device-portable library identity ("u" | "g<groupID>"). See `src/utils/libraryIdentity.ts`. */
    library_ref?: string;
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

export function isViewAttachment(attachment: MessageAttachment): attachment is ViewAttachment {
    return attachment.type === "saved_search" || attachment.type === "special_collection";
}

function specialCollectionKey(view: SpecialCollectionAttachment, libraryToken: string | number): string {
    return `${libraryToken}-${view.special_collection}`;
}

/**
 * Stable identity key for a Zotero reference. Portable `library_ref` wins so
 * references persisted on different devices deduplicate even when their local
 * Zotero `library_id` values differ.
 */
export function zoteroReferenceKey(ref: {
    library_id: number;
    zotero_key: string;
    library_ref?: string | null;
}): string {
    return `${ref.library_ref ?? ref.library_id}-${ref.zotero_key}`;
}

/**
 * All identity aliases for a Zotero reference. New records with a portable
 * `library_ref` also expose their numeric legacy alias so they match persisted
 * attachments written before portable library identity was introduced.
 */
export function zoteroReferenceLookupKeys(ref: {
    library_id: number;
    zotero_key: string;
    library_ref?: string | null;
}): string[] {
    const canonicalKey = zoteroReferenceKey(ref);
    const legacyKey = `${ref.library_id}-${ref.zotero_key}`;
    return canonicalKey === legacyKey ? [canonicalKey] : [canonicalKey, legacyKey];
}

/**
 * Stable key for any message attachment: `ext-<KEY>` for external files,
 * `<library_ref>-<zotero_key>` when portable identity is available, and the
 * legacy `<library_id>-<zotero_key>` form otherwise. Use this instead of
 * reading identity fields off the union directly — external files have none.
 */
export function messageAttachmentKey(attachment: MessageAttachment): string {
    if (attachment.type === 'table') return attachment.reference.key;
    if (isExternalFileAttachment(attachment)) {
        return `ext-${attachment.ext_key}`;
    }
    if (attachment.type === 'special_collection') {
        return specialCollectionKey(attachment, attachment.library_ref ?? attachment.library_id);
    }
    if (attachment.type === 'saved_search') return `${attachment.library_ref}-${attachment.zotero_key}`;
    return attachment.type === 'collection' && attachment.collection_id ? attachment.collection_id : zoteroReferenceKey(attachment);
}

/** Portable and legacy aliases used to look up an existing attachment. */
export function messageAttachmentLookupKeys(attachment: MessageAttachment): string[] {
    if (attachment.type === 'table') return [attachment.reference.key];
    if (isExternalFileAttachment(attachment)) {
        return [`ext-${attachment.ext_key}`];
    }
    if (attachment.type === 'special_collection') {
        const canonicalKey = messageAttachmentKey(attachment);
        const legacyKey = specialCollectionKey(attachment, attachment.library_id);
        return canonicalKey === legacyKey ? [canonicalKey] : [canonicalKey, legacyKey];
    }
    if (attachment.type === 'saved_search') return [messageAttachmentKey(attachment)];
    return zoteroReferenceLookupKeys(attachment);
}

/**
 * The Zotero key namespace an attachment's key belongs to. Collections and
 * items are separate namespaces, so the same key in the same library can name
 * both; any comparison that decides "same attachment?" has to account for that,
 * or an attached item swallows a collection that merely shares its key.
 */
function attachmentNamespace(attachment: MessageAttachment): string {
    switch (attachment.type) {
        case 'collection': return 'collection';
        case 'saved_search': return 'search';
        case 'special_collection': return 'view';
        default: return 'item';
    }
}

/**
 * Canonical identity for an attachment: {@link messageAttachmentKey} qualified
 * by object kind. Use this, not the bare key, wherever two attachments are
 * compared for being the same object.
 */
export function messageAttachmentIdentity(attachment: MessageAttachment): string {
    return `${attachmentNamespace(attachment)}:${messageAttachmentKey(attachment)}`;
}

/**
 * Every identity alias for an attachment, qualified by object kind — the
 * kind-aware companion to {@link messageAttachmentLookupKeys}, so a record
 * written before portable library refs still matches.
 */
export function messageAttachmentIdentityKeys(attachment: MessageAttachment): string[] {
    const namespace = attachmentNamespace(attachment);
    return messageAttachmentLookupKeys(attachment).map((key) => `${namespace}:${key}`);
}

/** Kind-qualified identity aliases for a Zotero *item* reference (never a collection). */
export function zoteroItemIdentityKeys(ref: {
    library_id: number;
    zotero_key: string;
    library_ref?: string | null;
}): string[] {
    return zoteroReferenceLookupKeys(ref).map((key) => `item:${key}`);
}

/**
 * Append `added` onto `existing`, skipping anything already present under any
 * {@link messageAttachmentLookupKeys} alias.
 */
export function mergeMessageAttachments(
    existing: MessageAttachment[],
    added: MessageAttachment[],
): MessageAttachment[] {
    const keys = new Set(existing.flatMap(messageAttachmentIdentityKeys));
    const merged = [...existing];
    for (const attachment of added) {
        const aliases = messageAttachmentIdentityKeys(attachment);
        if (aliases.some((key) => keys.has(key))) continue;
        aliases.forEach((key) => keys.add(key));
        merged.push(attachment);
    }
    return merged;
}

/**
 * Whether two attachments identify the same object. When both carry portable
 * identity it is authoritative; the numeric fallback is only used when at
 * least one side is a legacy record without `library_ref`.
 */
export function messageAttachmentsHaveSameIdentity(
    left: MessageAttachment,
    right: MessageAttachment,
): boolean {
    if (left.type === 'table' || right.type === 'table') {
        return attachmentNamespace(left) === attachmentNamespace(right)
            && messageAttachmentKey(left) === messageAttachmentKey(right);
    }
    if (isExternalFileAttachment(left) || isExternalFileAttachment(right)) {
        return isExternalFileAttachment(left) &&
            isExternalFileAttachment(right) &&
            left.ext_key === right.ext_key;
    }
    if (isViewAttachment(left) || isViewAttachment(right)) {
        if (left.type !== right.type) return false;
        if (left.type === 'special_collection' && right.type === 'special_collection'
            && left.special_collection !== right.special_collection) return false;
        if (left.type === 'saved_search' && right.type === 'saved_search') {
            return left.zotero_key === right.zotero_key && left.library_ref === right.library_ref;
        }
        if (left.type === 'special_collection' && right.type === 'special_collection') {
            if (left.library_ref && right.library_ref) return left.library_ref === right.library_ref;
            return left.library_id === right.library_id;
        }
        return false;
    }
    if (left.zotero_key !== right.zotero_key) return false;
    if (left.library_ref && right.library_ref) {
        return left.library_ref === right.library_ref;
    }
    return left.library_id === right.library_id;
}

/**
 * Converter
 */

export function toMessageAttachment(attachment: SourceAttachment): MessageAttachment {
    return attachment;
}

/** Hydrate structured collection identity while retaining old attachment fields. */
export function normalizeCollectionAttachment(attachment: CollectionAttachment): CollectionAttachment {
    const ref = resolveObjectIdReference(attachment.collection_id ?? attachment.zotero_key ?? '');
    return ref ? { ...attachment, ...ref } : attachment;
}
