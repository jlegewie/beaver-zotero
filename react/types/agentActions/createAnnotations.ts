import type { PageLocation } from '../citations';
import type { ZoteroItemReference } from '../zotero';
import type { NotePosition, ToolAnnotationColor } from './annotations';

/**
 * Normalize raw call-level annotation tags: trim, drop empty/non-string
 * entries, and return `undefined` when nothing remains. Shared by the
 * action normalizer and the WS execute handlers so all paths agree.
 */
export function normalizeAnnotationTags(raw: unknown): string[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const tags = raw
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
    return tags.length > 0 ? tags : undefined;
}

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
    /** Highlighted text. Required for PDF; EPUB also uses it to locate the range. */
    text?: string;
    color: ToolAnnotationColor;
    comment?: string | null;
    /** PDF-only: page rects/geometry. Absent for EPUB. */
    page_locations?: PageLocation[];
    page_label?: string | null;
    /** EPUB locator (content_kind === 'epub'): section file href, matched by basename. */
    section_href?: string | null;
    /** EPUB locator: DOM id of the cited element inside the section. */
    anchor_id?: string | null;
}

export interface NoteAnnotationItem {
    index: number;
    /** Opaque backend correlation token. */
    client_item_id: string;
    title: string;
    loc_raw: string;
    loc: BackendLocator;
    comment: string;
    color: ToolAnnotationColor;
    /** PDF-only: page anchor position. Absent for EPUB. */
    note_position?: NotePosition;
    page_label?: string | null;
    /** Per-page cumulative character offset in reading order (Zotero sortIndex offset). */
    reading_order_offset?: number | null;
    /** EPUB locator: cited passage text used to anchor the note point. */
    text?: string;
    /** EPUB locator: section file href, matched by basename. */
    section_href?: string | null;
    /** EPUB locator: DOM id of the cited element inside the section. */
    anchor_id?: string | null;
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
    /** Tags applied to every created annotation (call-level, not per item). */
    tags?: string[];
}

export interface CreateNoteAnnotationsProposedData {
    requested_ref: ZoteroItemReference;
    resolved_ref: ZoteroItemReference;
    items: NoteAnnotationItem[];
    /** Tags applied to every created annotation (call-level, not per item). */
    tags?: string[];
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
