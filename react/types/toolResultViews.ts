/**
 * Tool-result view models.
 *
 * These are the client-agnostic, render-ready data models that carry *all* data
 * needed to render a successful tool call's expanded body, so the shared render
 * layer never loads Zotero data at render time. They mirror the backend view
 * models that ship on `ToolReturnMetadata.view`.
 */

import type { ContentKind, PartLocation } from "./citations";
import type { ExternalReference } from "./externalReferences";

// ---------------------------------------------------------------------------
// Shared row sub-models
// ---------------------------------------------------------------------------

/**
 * One row in an {@link ItemListView}.
 *
 * Reference invariant: `library_id`/`zotero_key` ALWAYS identify the resolved
 * *main* item the row is about — for read/view/fulltext that is the specific
 * attachment actually read/searched, never the bibliographic parent.
 * `display_name` describes that item's bibliographic identity (the regular item
 * itself, or its parent for an attachment/note). When the displayed identity is
 * the parent (the parent-centric tools), `attachment_label` names which
 * attachment the reference points at; for attachment-centric rows it stays
 * absent.
 */
export interface ItemRowView {
    /** Row discriminator (vs {@link AnnotationRowView}). */
    kind: "item";
    /** ALWAYS the resolved main item (e.g. the attachment read), never the parent. */
    library_id: number;
    zotero_key: string;
    /** Device-portable library identity ("u" | "g<groupID>"). */
    library_ref?: string;
    /** Row's primary identity — see "Row display conventions" (R/P/A/N). */
    display_name: string;
    /** The bib identity NOT shown by display_name: title (R/P), or "Smith 2004. Title" (A/N). */
    subtitle?: string | null;
    /**
     * The resolved attachment's own name ("supplement.pdf"); set ONLY when
     * display_name describes a different (parent) item — absent for
     * attachment-centric rows.
     */
    attachment_label?: string | null;
    /**
     * Zotero item type: "journalArticle", "book", "attachment", "note", ...
     * Optional: some tools can't resolve it → the frontend falls back to a
     * generic icon via `itemTypeToIconName(undefined, ...)`.
     */
    item_type?: string | null;
    /**
     * Attachments only, icon disambiguation. A free string, BROADER than the
     * readable {@link ContentKind} (item lists can hold word/spreadsheet/audio/…).
     */
    content_kind?: string | null;
    /** Right-aligned locator badge: "Page 1-3", "Lines 10-20" — LOCATION only (no status). */
    location_label?: string | null;
    /** Row outcome; the frontend maps it to styling (e.g. dim / error icon). */
    status?: "ok" | "error";
}

/**
 * One annotation row. Replaces the live `resolveAnnotationRef()` lookup.
 *
 * The annotation icon is derived from `annotation_type`
 * (highlight/underline/note/image/text), NOT from the `item_type` path used by
 * {@link ItemRowView}.
 *
 * Used both as the element type of {@link AnnotationListView} and as a row
 * variant of {@link ItemListView} (an item-list tool — e.g. get_metadata — can
 * reference an annotation, rendered as a colored annotation row).
 */
export interface AnnotationRowView {
    /** Row discriminator (vs {@link ItemRowView}). */
    kind: "annotation";
    library_id: number;
    zotero_key: string;
    /** Device-portable library identity ("u" | "g<groupID>"). */
    library_ref?: string;
    /** highlight | underline | note | image | text */
    annotation_type?: string | null;
    /** annotationText */
    text?: string;
    /** annotationComment */
    comment?: string;
    /** hex / CSS var; tints the icon */
    color?: string | null;
    /** annotationPageLabel */
    page_label?: string;
    /** bibliographic parent: "Smith 2020" */
    source_display_name?: string;
    /** resolved; not rendered today, kept for parity */
    tags?: string[];
}

/**
 * Row element of an {@link ItemListView}: an item, or (for tools like
 * get_metadata that can reference an annotation) an annotation. Discriminated
 * by `kind`.
 */
export type ItemListRow = ItemRowView | AnnotationRowView;

export interface CollectionRowView {
    /** Used by the reveal click. */
    library_id: number;
    /** Device-portable library identity ("u" | "g<groupID>"). */
    library_ref?: string;
    /** Collection key (NOT an item key); the frontend maps it to a CollectionReference. */
    collection_key: string;
    name: string;
}

export interface TagRowView {
    name: string;
    /** Number of top-level regular items carrying this tag. */
    item_count: number;
    /** Number of attachments carrying this tag. Absent on older results. */
    attachment_count?: number;
    /** Number of notes carrying this tag. Absent on older results. */
    note_count?: number;
    /** Number of annotations carrying this tag. Absent on older results. */
    annotation_count?: number;
}

/** One find_in_attachments match (snippet + click-to-highlight target). */
export interface AttachmentMatchView {
    snippet: string;
    page_number?: number | null;
    page_label?: string | null;
    /** Same compact shape Citation.locations uses. */
    target?: PartLocation | null;
}

export interface AttachmentSearchRowView {
    library_id: number;
    zotero_key: string;
    /** Device-portable library identity ("u" | "g<groupID>"). */
    library_ref?: string;
    /** Parent "Smith 2024" or external filename. */
    display_name: string;
    /** Zotero item type for the icon (itemTypeToIconName); null when unresolved. */
    item_type?: string | null;
    /** Also disambiguates the attachment icon. */
    content_kind: "pdf" | "epub" | "text" | "snapshot";
    /**
     * Per-attachment search outcome. The backend omits this when it is the
     * default `"ok"` (only `no_matches`/`error` rows carry it), so a missing
     * value means a successful search — treat absent as `"ok"`.
     */
    status?: "ok" | "no_matches" | "error";
    match_count: number;
    pages: number[];
    /** Omitted by the backend for `no_matches`/`error` rows; treat absent as empty. */
    matches?: AttachmentMatchView[];
    error?: string | null;
    /** External-file ref; filename/availability resolved client-side. */
    is_external: boolean;
}

// ---------------------------------------------------------------------------
// Top-level views (discriminated by `view_type`)
// ---------------------------------------------------------------------------

export interface ItemListView {
    view_type: "item_list";
    tool_name: string;
    items: ItemListRow[];
}

export interface AnnotationListView {
    view_type: "annotation_list";
    tool_name: "get_annotations" | "find_annotations";
    annotations: AnnotationRowView[];
    /**
     * "with-parent" → source name + page on a 2nd line; "compact" → page inline.
     * Derived from tool_name + whether the query was scoped to one attachment.
     */
    variant: "with-parent" | "compact";
}

export interface ExternalReferenceListView {
    view_type: "external_reference_list";
    tool_name: string;
    /** Already fully hydrated. */
    references: ExternalReference[];
    // lookup_work-only extras (absent/empty for external_search):
    found_count?: number | null;
    not_found_queries?: string[];
    /** temporarily_unchecked_queries */
    unavailable_queries?: string[];
    message?: string | null;
}

export interface CollectionListView {
    view_type: "collection_list";
    tool_name: "list_collections";
    collections: CollectionRowView[];
    /** Rendered: "Showing X of Y collections". */
    total_count: number;
}

export interface TagListView {
    view_type: "tag_list";
    tool_name: "list_tags";
    tags: TagRowView[];
    /** Rendered: "Showing X of Y tags". */
    total_count: number;
}

export interface AttachmentSearchView {
    view_type: "attachment_search";
    tool_name: "find_in_attachments";
    query: string;
    total_matches: number;
    attachment_count: number;
    attachments: AttachmentSearchRowView[];
}

/** One question + resolved answer of a {@link UserQuestionView}. Selections
 * are option *labels* (already resolved server-side), not option ids. */
export interface UserQuestionAnswerView {
    question: string;
    /** Labels of the options the user selected; empty when skipped/unanswered. */
    selected?: string[];
    /** Free-text 'Other' answer the user typed, if any. */
    custom_text?: string | null;
}

export interface UserQuestionView {
    view_type: "user_question";
    tool_name: "ask_user_question";
    /**
     * Outcome of the question card. The backend default is `"answered"` —
     * treat an absent value as answered and gate only on the NON-default
     * states (`cancelled` / `no_response`).
     */
    status?: "answered" | "no_response" | "cancelled";
    title?: string | null;
    /** One entry per question asked (present in every status). */
    answers: UserQuestionAnswerView[];
}

/** The general discriminated union — discriminated by `view_type`. */
export type ToolResultView =
    | ItemListView
    | AnnotationListView
    | ExternalReferenceListView
    | CollectionListView
    | TagListView
    | AttachmentSearchView
    | UserQuestionView;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Narrow an unknown metadata value to a {@link ToolResultView}. */
export function isToolResultView(value: unknown): value is ToolResultView {
    if (!value || typeof value !== "object") return false;
    const viewType = (value as { view_type?: unknown }).view_type;
    return (
        viewType === "item_list" ||
        viewType === "annotation_list" ||
        viewType === "external_reference_list" ||
        viewType === "collection_list" ||
        viewType === "tag_list" ||
        viewType === "attachment_search" ||
        viewType === "user_question"
    );
}

export function isItemListView(view: ToolResultView): view is ItemListView {
    return view.view_type === "item_list";
}

export function isAnnotationListView(view: ToolResultView): view is AnnotationListView {
    return view.view_type === "annotation_list";
}

export function isExternalReferenceListView(view: ToolResultView): view is ExternalReferenceListView {
    return view.view_type === "external_reference_list";
}

export function isCollectionListView(view: ToolResultView): view is CollectionListView {
    return view.view_type === "collection_list";
}

export function isTagListView(view: ToolResultView): view is TagListView {
    return view.view_type === "tag_list";
}

export function isAttachmentSearchView(view: ToolResultView): view is AttachmentSearchView {
    return view.view_type === "attachment_search";
}

export function isUserQuestionView(view: ToolResultView): view is UserQuestionView {
    return view.view_type === "user_question";
}

export function isItemRow(row: ItemListRow): row is ItemRowView {
    return row.kind === "item";
}

export function isAnnotationRow(row: ItemListRow): row is AnnotationRowView {
    return row.kind === "annotation";
}

/**
 * Number of renderable rows/results a view represents, used **for expansion
 * gating only** (a tool call with a zero count isn't worth expanding).
 *
 * This is deliberately NOT a label-formatting helper — labels need per-tool,
 * per-view-type wording (locator text vs "N matches" vs "N found"), which lives
 * in `getToolResultLabelSuffix` (react/agents/toolLabels.ts). Returns null when
 * the view has no meaningful count (don't block expansion).
 */
export function getToolResultRenderableCount(view: ToolResultView): number | null {
    switch (view.view_type) {
        case "item_list":
            return view.items.length;
        case "annotation_list":
            return view.annotations.length;
        case "collection_list":
            return view.total_count;
        case "tag_list":
            return view.total_count;
        case "attachment_search":
            return view.attachment_count;
        case "external_reference_list":
            return view.found_count ?? view.references.length;
        case "user_question":
            return view.answers.length;
        default:
            return null;
    }
}

export type { ContentKind };
