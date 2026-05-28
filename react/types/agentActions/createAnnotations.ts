import type { PageLocation } from '../citations';
import type { ZoteroItemReference } from '../zotero';
import type { NotePosition, ToolAnnotationColor } from './annotations';

export interface BackendLocator {
    kind:
        | 'sentence'
        | 'paragraph'
        | 'heading'
        | 'list'
        | 'caption'
        | 'footnote'
        | 'figure'
        | 'equation'
        | 'table'
        | 'margin'
        | 'page'
        | 'unknown';
    value: string;
    raw: string;
}

export interface HighlightAnnotationItem {
    index: number;
    /**
     * Opaque backend correlation token. One token can produce multiple
     * CreatedAnnotationResult rows when a highlight spans multiple pages.
     */
    client_item_id: string;
    title: string;
    loc_raw: string;
    loc: BackendLocator;
    text: string;
    color: ToolAnnotationColor;
    comment?: string | null;
    page_locations: PageLocation[];
    page_label?: string | null;
}

export interface NoteAnnotationItem {
    index: number;
    /** Opaque backend correlation token. */
    client_item_id: string;
    title: string;
    loc_raw: string;
    loc: BackendLocator;
    comment: string;
    note_position: NotePosition;
    page_label?: string | null;
    /** Per-page cumulative character offset in reading order (Zotero sortIndex offset). */
    reading_order_index?: number | null;
}

export interface CreatedAnnotationResult extends ZoteroItemReference {
    client_item_id: string;
    index: number;
    loc_raw: string;
}

export interface FailedAnnotationResult {
    client_item_id: string;
    index: number;
    loc_raw: string;
    error: string;
    error_code?: string | null;
}

export interface CreateHighlightAnnotationsProposedData {
    requested_ref: ZoteroItemReference;
    resolved_ref: ZoteroItemReference;
    items: HighlightAnnotationItem[];
}

export interface CreateNoteAnnotationsProposedData {
    requested_ref: ZoteroItemReference;
    resolved_ref: ZoteroItemReference;
    items: NoteAnnotationItem[];
}

export interface CreateHighlightAnnotationsResultData {
    requested_ref: ZoteroItemReference;
    resolved_ref: ZoteroItemReference;
    created: CreatedAnnotationResult[];
    failed: FailedAnnotationResult[];
    total_created: number;
    total_failed: number;
}

export interface CreateNoteAnnotationsResultData {
    requested_ref: ZoteroItemReference;
    resolved_ref: ZoteroItemReference;
    created: CreatedAnnotationResult[];
    failed: FailedAnnotationResult[];
    total_created: number;
    total_failed: number;
}
