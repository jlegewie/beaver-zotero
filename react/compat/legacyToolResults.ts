/**
 * Legacy tool-result compatibility layer.
 *
 * The shared render layer understands ONLY the hydrated `ToolResultView` models
 * (`react/types/toolResultViews.ts`). New backends ship those on
 * `ToolReturnMetadata.view`. But two row shapes predate them:
 *
 *  1. Old threads, whose tool returns carry only the reference-only `summary`
 *     (and/or `content`), never a `view`.
 *  2. Discontinued tools (`read_pages`, `view_page_images`,
 *     `search_in_attachment`, `search_in_documents`) the backend stopped
 *     emitting a `view` for — mapped here onto the unified views.
 *
 * This module synthesizes the matching `view` from the legacy `summary`/`content`
 * plus live Zotero loads (display names, subtitles, icons, annotation fields).
 */

import { ToolReturnPart } from "../agents/types";
import { ZoteroItemReference } from "../types/zotero";
import { logger } from "../../src/utils/logger";
import { truncateText, formatNumberRanges } from "../utils/stringUtils";
import { EXTERNAL_LIBRARY_ID } from "../../src/services/externalFiles";
import {
    ToolResultView,
    ItemListView,
    ItemListRow,
    AnnotationRowView,
    AnnotationListView,
    ExternalReferenceListView,
    CollectionListView,
    TagListView,
    AttachmentSearchView,
    AttachmentSearchRowView,
    AttachmentMatchView,
} from "../types/toolResultViews";
import {
    // type guards
    isZoteroSearchResult,
    isListItemsResult,
    isItemSearchResult,
    isFulltextSearchResult,
    isReadPagesResult,
    isReadPagesFrontendResult,
    isReadTextResult,
    isViewToolResult,
    isViewPageImagesResult,
    isFindInAttachmentsResult,
    isLookupWorkResult,
    isExternalSearchResult,
    isListCollectionsResult,
    isListTagsResult,
    isGetMetadataResult,
    isExtractResult,
    isReadNoteResult,
    isGetAnnotationsResult,
    // extractors
    extractZoteroSearchData,
    extractListItemsData,
    extractItemSearchData,
    extractFulltextSearchData,
    extractReadPagesData,
    extractReadPagesFrontendData,
    extractReadTextData,
    extractViewToolData,
    extractViewPageImagesData,
    extractFindInAttachmentsData,
    extractLookupWorkData,
    extractExternalSearchData,
    extractListCollectionsData,
    extractListTagsData,
    extractGetMetadataData,
    extractExtractData,
    extractReadNoteData,
    extractGetAnnotationsData,
    extractAnnotationAttachmentId,
    // types
    ChunkReference,
    PageReference,
    LineReference,
    AttachmentSearchReference,
    AttachmentMatchSummary,
} from "../agents/toolResultTypes";

const NOTE_TITLE_MAX_LENGTH = 100;
/** Maximum annotation text/comment preview stored in legacy view rows. */
const ANNOTATION_PREVIEW_MAX_LENGTH = 300;

// ===========================================================================
// Live-Zotero hydration helpers
//
// These are the only functions that touch live Zotero. They mirror the display
// logic of `ZoteroItemsList` / `sourceUtils.getDisplayNameFromItem` /
// `annotationListShared.resolveAnnotationRef`, but produce view-model rows
// (kept self-contained so the compat module owns all legacy Zotero coupling and
// stays unit-testable with mocked items).
// ===========================================================================

/** Resolve a (library, key) reference to a live item, or null. */
async function loadItem(libraryId: number, key: string): Promise<Zotero.Item | null> {
    try {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, key);
        return item || null;
    } catch (error) {
        logger(`legacyToolResults: failed to resolve ${libraryId}-${key}: ${error}`, 1);
        return null;
    }
}

/** Best-effort load of the field/creator data the display helpers read. */
async function ensureItemData(item: Zotero.Item): Promise<void> {
    try {
        await item.loadDataType?.("itemData");
    } catch { /* lazy-load failure degrades the label, not the row */ }
    try {
        if (item.isRegularItem?.()) await item.loadDataType?.("creators");
    } catch { /* best effort */ }
}

/** Resolve a child item's parent (async — the sync getter throws when uncached). */
async function resolveParent(item: Zotero.Item): Promise<Zotero.Item | null> {
    const parentId = (item.parentItemID || (item as unknown as { parentID?: number }).parentID) || null;
    if (!parentId) return null;
    try {
        const parent = await Zotero.Items.getAsync(parentId);
        return parent || null;
    } catch {
        return null;
    }
}

/** Author-year with display fallbacks ("Smith 2004" → title → "Unknown Author"). */
function authorYearWithFallback(item: Zotero.Item): string {
    const firstCreator = item.firstCreator || item.getField?.("title") || "Unknown Author";
    const year = item.getField?.("date")?.match(/\d{4}/)?.[0] || "";
    return `${firstCreator}${year ? ` ${year}` : ""}`;
}

/** Author-year with NO fallback ("Smith 2004", or "" when there are no creators). */
function authorYearStrict(item: Zotero.Item): string {
    const creator = item.firstCreator || "";
    const year = item.getField?.("date")?.match(/\d{4}/)?.[0] || "";
    return [creator, year].filter(Boolean).join(" ");
}

function titleOf(item: Zotero.Item): string {
    try {
        return item.getDisplayTitle?.() || item.getField?.("title") || "";
    } catch {
        return item.getField?.("title") || "";
    }
}

function attachmentOwnName(item: Zotero.Item): string {
    return item.getField?.("title") || item.attachmentFilename || "";
}

/**
 * The "<author-year>. <title>" subtitle (conventions A/N), built from a parent's
 * bibliographic parts. Degrades gracefully: no creators → title only; no title
 * → author-year only; neither → null.
 */
function bibSubtitle(parent: Zotero.Item): string | null {
    const authorYear = authorYearStrict(parent);
    const title = titleOf(parent);
    if (authorYear && title) return `${authorYear}. ${title}`;
    return authorYear || title || null;
}

/**
 * Derive an attachment's content kind for icon disambiguation. Mirrors the
 * readable-kind branch of `attachmentResolution.getContentKind` for the kinds
 * `itemTypeToIconName` distinguishes (pdf/epub/text/snapshot/image); everything
 * else falls back to a generic attachment icon. Self-contained so the compat
 * module pulls no document-extraction internals.
 */
function deriveContentKind(item: Zotero.Item): string | undefined {
    if (!item.isAttachment?.()) return undefined;
    try {
        if (item.isPDFAttachment?.()) return "pdf";
        const contentType = (item.attachmentContentType || "").toLowerCase();
        const isEpub = (item as unknown as { isEPUBAttachment?: () => boolean }).isEPUBAttachment;
        if ((typeof isEpub === "function" && isEpub.call(item)) || contentType === "application/epub+zip") {
            return "epub";
        }
        const isImage = (item as unknown as { isImageAttachment?: () => boolean }).isImageAttachment;
        if ((typeof isImage === "function" && isImage.call(item)) || contentType.startsWith("image/")) {
            return "image";
        }
        if (contentType === "text/html" || contentType === "application/xhtml+xml") return "snapshot";
        if (contentType.startsWith("text/")) return "text";
        return "other";
    } catch {
        return undefined;
    }
}

/** Resolve the bibliographic source display name for an annotation row. */
async function annotationSourceDisplayName(annotation: Zotero.Item): Promise<string> {
    const attachmentId = annotation.parentItemID || (annotation as unknown as { parentID?: number }).parentID;
    const attachment = attachmentId ? await Zotero.Items.getAsync(attachmentId).catch(() => null) : null;
    if (!attachment) return "";

    const sourceParentId = attachment.parentItemID || (attachment as unknown as { parentID?: number }).parentID;
    const source = sourceParentId
        ? (await Zotero.Items.getAsync(sourceParentId).catch(() => null)) || attachment
        : attachment;

    await ensureItemData(source);
    try {
        return authorYearWithFallback(source) || titleOf(source) || source.key || "";
    } catch {
        return titleOf(source) || source.key || "";
    }
}

/** Build an {@link AnnotationRowView} from a resolved annotation item. */
async function hydrateAnnotationRow(
    ref: ZoteroItemReference,
    item: Zotero.Item,
): Promise<AnnotationRowView> {
    try {
        await item.loadDataType?.("itemData");
        await item.loadDataType?.("tags");
    } catch { /* best effort */ }
    return {
        kind: "annotation",
        library_id: ref.library_id,
        zotero_key: ref.zotero_key,
        annotation_type: item.annotationType ?? null,
        // Store a bounded preview; result rows and tooltips do not need the full
        // annotation body.
        text: truncateText(item.annotationText ?? "", ANNOTATION_PREVIEW_MAX_LENGTH),
        comment: truncateText(item.annotationComment ?? "", ANNOTATION_PREVIEW_MAX_LENGTH),
        color: item.annotationColor ?? null,
        page_label: item.annotationPageLabel ?? "",
        source_display_name: await annotationSourceDisplayName(item),
        tags: (item.getTags?.() ?? []).map((t) => t.tag),
    };
}

interface RowSpec {
    ref: ZoteroItemReference;
    /**
     * 'self' → the targeted item is always the headline (R/A/N — target tools,
     * read_note). 'parent' → headline the bibliographic parent when one exists
     * (P, attachment demoted to attachment_label — content tools), falling back
     * to a self-centric row when there is none (e.g. an extracted top-level
     * item). Mirrors the legacy `item.parentItem || item` choice.
     */
    headline: "self" | "parent";
    locationLabel?: string | null;
    status?: "ok" | "error";
    /** Explicit parent reference (read_note carries it in the summary). */
    parentRefOverride?: ZoteroItemReference | null;
}

type RowBase = {
    kind: "item";
    library_id: number;
    zotero_key: string;
    location_label: string | null;
    status: "ok" | "error";
};

/**
 * Render a self-centric row (R/A/N): the targeted item is the headline. An
 * attachment/note uses the resolved parent for its "<author-year>. <title>"
 * subtitle; a regular item is its own bibliographic identity.
 */
function selfRow(base: RowBase, item: Zotero.Item, parent: Zotero.Item | null): ItemListRow {
    if (item.isNote?.()) {
        return {
            ...base,
            display_name: truncateText(item.getNoteTitle?.() || "Note", NOTE_TITLE_MAX_LENGTH),
            subtitle: parent ? bibSubtitle(parent) : null,
            item_type: "note",
        };
    }
    if (item.isAttachment?.()) {
        return {
            ...base,
            display_name: attachmentOwnName(item) || titleOf(item) || "Unknown file",
            subtitle: parent ? bibSubtitle(parent) : null,
            item_type: "attachment",
            content_kind: deriveContentKind(item),
        };
    }
    // Regular item (R).
    return {
        ...base,
        display_name: authorYearWithFallback(item),
        subtitle: titleOf(item) || null,
        item_type: item.itemType,
    };
}

/**
 * Hydrate one item reference into an {@link ItemListRow}, applying the R/P/A/N
 * display conventions. Annotation references become {@link AnnotationRowView}s.
 * Unresolved references degrade to a minimal row (the key as display name)
 * rather than being dropped.
 */
async function hydrateRow(spec: RowSpec): Promise<ItemListRow> {
    const { ref, headline, locationLabel = null, status = "ok" } = spec;
    const item = await loadItem(ref.library_id, ref.zotero_key);

    if (!item) {
        return {
            kind: "item",
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            display_name: ref.zotero_key,
            location_label: locationLabel,
            status,
        };
    }

    if (item.isAnnotation?.()) {
        return hydrateAnnotationRow(ref, item);
    }

    await ensureItemData(item);

    const base: RowBase = {
        kind: "item",
        library_id: ref.library_id,
        zotero_key: ref.zotero_key,
        location_label: locationLabel,
        status,
    };

    // Resolve the bibliographic parent (explicit override for read_note, else
    // the item's own). Regular items have none → resolveParent returns null.
    const parent = spec.parentRefOverride
        ? await loadItem(spec.parentRefOverride.library_id, spec.parentRefOverride.zotero_key)
        : await resolveParent(item);
    if (parent) await ensureItemData(parent);

    // Parent-centric (P): headline the bibliographic parent when one exists,
    // demoting the attachment to attachment_label. With no parent (e.g. an
    // extracted top-level item) fall back to the self-centric row.
    if (headline === "parent" && parent) {
        return {
            ...base,
            display_name: authorYearWithFallback(parent),
            subtitle: titleOf(parent) || null,
            attachment_label: attachmentOwnName(item) || null,
            item_type: "attachment",
            content_kind: deriveContentKind(item),
        };
    }

    return selfRow(base, item, parent);
}

async function hydrateRows(specs: RowSpec[]): Promise<ItemListRow[]> {
    const rows: ItemListRow[] = [];
    for (const spec of specs) {
        rows.push(await hydrateRow(spec));
    }
    return rows;
}

// ===========================================================================
// Per-attachment aggregation (pure — mirrors the legacy *ResultView grouping)
// ===========================================================================

/** Right-aligned page locator label ("Page 1-3, 5"); undefined when no pages. */
function pageLabel(pages: number[]): string | undefined {
    if (pages.length === 0) return undefined;
    return `Page ${formatNumberRanges(pages, ", ")}`;
}

/**
 * Group page-bearing references by attachment, preserving first-seen order, and
 * build a parent-centric (P) row spec per attachment with a "Page …" label.
 */
function pageRowSpecs(
    refs: { library_id: number; zotero_key: string }[],
    pageOf: (ref: any) => number | undefined,
): RowSpec[] {
    const order: string[] = [];
    const grouped = new Map<string, { ref: ZoteroItemReference; pages: number[] }>();
    for (const ref of refs) {
        const key = `${ref.library_id}-${ref.zotero_key}`;
        if (!grouped.has(key)) {
            grouped.set(key, { ref: { library_id: ref.library_id, zotero_key: ref.zotero_key }, pages: [] });
            order.push(key);
        }
        const page = pageOf(ref);
        if (page !== undefined && page !== null) grouped.get(key)!.pages.push(page);
    }
    return order.map((key) => {
        const { ref, pages } = grouped.get(key)!;
        return { ref, headline: "parent" as const, locationLabel: pageLabel(pages) ?? null };
    });
}

/** Group line ranges by attachment and build "Line(s) …" labels. */
function lineRowSpecs(lines: LineReference[]): RowSpec[] {
    const order: string[] = [];
    const grouped = new Map<string, { ref: ZoteroItemReference; ranges: string[] }>();
    for (const line of lines) {
        const key = `${line.library_id}-${line.zotero_key}`;
        if (!grouped.has(key)) {
            grouped.set(key, { ref: { library_id: line.library_id, zotero_key: line.zotero_key }, ranges: [] });
            order.push(key);
        }
        grouped.get(key)!.ranges.push(
            line.start_line === line.end_line ? `${line.start_line}` : `${line.start_line}-${line.end_line}`,
        );
    }
    return order.map((key) => {
        const { ref, ranges } = grouped.get(key)!;
        const plural = ranges.length === 1 && !ranges[0].includes("-") ? "" : "s";
        const label = ranges.length > 0 ? `Line${plural} ${ranges.join(", ")}` : null;
        return { ref, headline: "parent" as const, locationLabel: label };
    });
}

// ===========================================================================
// Per-view builders
// ===========================================================================

function itemListView(toolName: string, items: ItemListRow[]): ItemListView {
    return { view_type: "item_list", tool_name: toolName, items };
}

async function buildFindInAttachmentsView(
    part: ToolReturnPart,
): Promise<AttachmentSearchView | null> {
    const data = extractFindInAttachmentsData(part.content, part.metadata);
    if (!data) return null;

    const rows: AttachmentSearchRowView[] = [];
    for (const att of data.attachments) {
        rows.push(await hydrateAttachmentSearchRow(att));
    }
    return {
        view_type: "attachment_search",
        tool_name: "find_in_attachments",
        query: data.query,
        total_matches: data.totalMatches,
        attachment_count: data.attachmentCount,
        attachments: rows,
    };
}

async function hydrateAttachmentSearchRow(
    att: AttachmentSearchReference,
): Promise<AttachmentSearchRowView> {
    const matches: AttachmentMatchView[] = att.matches.map((m: AttachmentMatchSummary) => ({
        snippet: m.snippet,
        page_number: m.page_number ?? null,
        page_label: m.page_label ?? null,
        target: m.target ?? null,
    }));

    const baseRow: AttachmentSearchRowView = {
        library_id: att.library_id,
        zotero_key: att.zotero_key,
        display_name: att.zotero_key,
        item_type: null,
        content_kind: att.content_kind,
        status: att.status,
        match_count: att.match_count,
        pages: att.pages,
        matches,
        error: att.error ?? null,
        is_external: false,
    };

    // External files: filename from the local registry, never the library.
    if (att.library_id === EXTERNAL_LIBRARY_ID) {
        const record = await Zotero.Beaver?.db
            ?.getExternalFileByKey(att.zotero_key)
            .catch(() => null);
        return {
            ...baseRow,
            display_name: record?.filename ?? `Attached file (ext-${att.zotero_key})`,
            is_external: true,
        };
    }

    const item = await loadItem(att.library_id, att.zotero_key);
    if (!item) {
        return baseRow; // not in library — key as display name, item_type null
    }

    // Headline the bibliographic parent (D3): parent display name + its icon.
    let displayItem = item;
    const parent = await resolveParent(item);
    if (parent) displayItem = parent;
    await ensureItemData(displayItem);

    let itemType: string | null = null;
    try {
        itemType = displayItem.itemType ?? null;
    } catch { /* cosmetic */ }

    return {
        ...baseRow,
        display_name: authorYearWithFallback(displayItem) || titleOf(displayItem) || att.zotero_key,
        item_type: itemType,
    };
}

function buildExternalSearchView(part: ToolReturnPart): ExternalReferenceListView | null {
    const data = extractExternalSearchData(part.content, part.metadata);
    if (!data) return null;
    return {
        view_type: "external_reference_list",
        tool_name: part.tool_name,
        references: data.references,
    };
}

function buildLookupWorkView(part: ToolReturnPart): ExternalReferenceListView | null {
    const data = extractLookupWorkData(part.content, part.metadata);
    if (!data) return null;
    return {
        view_type: "external_reference_list",
        tool_name: part.tool_name,
        references: data.references,
        found_count: data.foundCount,
        not_found_queries: data.notFoundQueries,
        unavailable_queries: data.temporarilyUncheckedQueries,
        message: data.message ?? null,
    };
}

function buildCollectionListView(part: ToolReturnPart): CollectionListView | null {
    const data = extractListCollectionsData(part.content, part.metadata);
    if (!data) return null;
    return {
        view_type: "collection_list",
        tool_name: "list_collections",
        collections: data.collections.map((c) => ({
            library_id: c.library_id,
            collection_key: c.zotero_key,
            name: c.name,
        })),
        total_count: data.totalCount,
    };
}

function buildTagListView(part: ToolReturnPart): TagListView | null {
    const data = extractListTagsData(part.content, part.metadata);
    if (!data) return null;
    return {
        view_type: "tag_list",
        tool_name: "list_tags",
        tags: data.tags.map((t) => ({ name: t.name, item_count: t.item_count })),
        total_count: data.totalCount,
    };
}

async function buildAnnotationListView(
    part: ToolReturnPart,
    toolCallArgs: string | Record<string, any> | null | undefined,
): Promise<AnnotationListView | null> {
    const data = extractGetAnnotationsData(part.content, part.metadata);
    if (!data) return null;

    const rows: AnnotationRowView[] = [];
    for (const ref of data.annotations) {
        const item = await loadItem(ref.library_id, ref.zotero_key);
        if (item && item.isAnnotation?.()) {
            rows.push(await hydrateAnnotationRow(ref, item));
        }
    }

    // Variant mirrors GetAnnotationsResultView: an unscoped find_annotations
    // shows the source on a 2nd line; everything else is compact.
    const attachmentId = extractAnnotationAttachmentId(toolCallArgs ?? null);
    const variant = data.toolName === "find_annotations" && !attachmentId ? "with-parent" : "compact";

    return {
        view_type: "annotation_list",
        tool_name: data.toolName,
        annotations: rows,
        variant,
    };
}

/** Map extract status to the view-model row status (fades failures + legacy not_relevant). */
function extractRowStatus(status: string): "ok" | "error" {
    return status === "error" || status === "not_relevant" ? "error" : "ok";
}

async function buildExtractView(part: ToolReturnPart): Promise<ItemListView | null> {
    const data = extractExtractData(part.content, part.metadata);
    if (!data) return null;
    const rows = await hydrateRows(
        data.items.map((item) => ({
            ref: { library_id: item.library_id, zotero_key: item.zotero_key },
            // Parent-centric like the legacy ExtractResultView (showParentItem):
            // an attachment-backed item headlines its bibliographic parent; a
            // top-level item headlines itself.
            headline: "parent" as const,
            status: extractRowStatus(item.status),
        })),
    );
    return itemListView("extract", rows);
}

async function buildReadNoteView(part: ToolReturnPart): Promise<ItemListView | null> {
    const data = extractReadNoteData(part.content, part.metadata);
    if (!data) return null;
    const row = await hydrateRow({
        ref: data.noteReference,
        headline: "self",
        parentRefOverride: data.parentReference ?? null,
    });
    return itemListView("read_note", [row]);
}

// ---------------------------------------------------------------------------
// Discontinued tools (no backend `view`): search_in_attachment /
// search_in_documents are mapped here from their legacy summary shapes.
// ---------------------------------------------------------------------------

function summaryOf(part: ToolReturnPart): Record<string, unknown> | null {
    const summary = part.metadata?.summary;
    return summary && typeof summary === "object" ? (summary as Record<string, unknown>) : null;
}

function isSearchInAttachmentResult(part: ToolReturnPart): boolean {
    if (part.tool_name !== "search_in_attachment") return false;
    const summary = summaryOf(part);
    return !!summary && Array.isArray(summary.pages);
}

function isSearchInDocumentsResult(part: ToolReturnPart): boolean {
    if (part.tool_name !== "search_in_documents") return false;
    const summary = summaryOf(part);
    return !!summary && Array.isArray(summary.chunks);
}

async function buildSearchInAttachmentView(part: ToolReturnPart): Promise<ItemListView | null> {
    const summary = summaryOf(part);
    const pages = (summary?.pages as PageReference[] | undefined) ?? [];
    if (!Array.isArray(pages)) return null;
    const specs = pageRowSpecs(pages, (p: PageReference) => p.page_number);
    return itemListView("search_in_attachment", await hydrateRows(specs));
}

async function buildSearchInDocumentsView(part: ToolReturnPart): Promise<ItemListView | null> {
    const summary = summaryOf(part);
    const chunks = (summary?.chunks as ChunkReference[] | undefined) ?? [];
    if (!Array.isArray(chunks)) return null;
    // Chunk pages are 0-indexed in retrieval results — match the fulltext view.
    const specs = pageRowSpecs(chunks, (c: ChunkReference) => (c.page !== undefined ? c.page + 1 : undefined));
    return itemListView("search_in_documents", await hydrateRows(specs));
}

// ===========================================================================
// Dispatch
// ===========================================================================

/**
 * Build a hydrated {@link ToolResultView} from a legacy tool-return part, or
 * null when the tool is unrecognized / has no renderable result. Resilient: any
 * thrown error yields null (the caller keeps the un-upgraded part).
 */
export async function buildLegacyView(
    part: ToolReturnPart,
    toolCallArgs?: string | Record<string, any> | null,
): Promise<ToolResultView | null> {
    const { tool_name, content, metadata } = part;
    try {
        // --- item-list tools, target-centric (R/A/N) ---
        if (isZoteroSearchResult(tool_name, content, metadata)) {
            const data = extractZoteroSearchData(content, metadata);
            if (data) {
                return itemListView(tool_name, await hydrateRows(
                    data.items.map((ref) => ({ ref, headline: "self" as const })),
                ));
            }
        }

        if (isListItemsResult(tool_name, content, metadata)) {
            const data = extractListItemsData(content, metadata);
            if (data) {
                return itemListView(tool_name, await hydrateRows(
                    data.items.map((ref) => ({ ref, headline: "self" as const })),
                ));
            }
        }

        if (isItemSearchResult(tool_name, content, metadata)) {
            const data = extractItemSearchData(content, metadata);
            if (data) {
                return itemListView(tool_name, await hydrateRows(
                    data.items.map((ref) => ({ ref, headline: "self" as const })),
                ));
            }
        }

        // --- content tools, parent-centric (P) ---
        if (isFulltextSearchResult(tool_name, content, metadata)) {
            const data = extractFulltextSearchData(content, metadata);
            if (data) {
                // Fulltext chunk pages are 0-indexed.
                const specs = pageRowSpecs(data.chunks, (c: ChunkReference) =>
                    c.page !== undefined ? c.page + 1 : undefined,
                );
                return itemListView(tool_name, await hydrateRows(specs));
            }
        }

        if (isReadPagesResult(tool_name, content, metadata)) {
            const data = extractReadPagesData(content, metadata);
            if (data) {
                const specs = pageRowSpecs(data.pages, (p: PageReference) => p.page_number);
                return itemListView(tool_name, await hydrateRows(specs));
            }
        }

        if (isReadPagesFrontendResult(tool_name, content, metadata)) {
            const data = extractReadPagesFrontendData(content, metadata);
            if (data) {
                const specs = pageRowSpecs(data.pages, (p: PageReference) => p.page_number);
                return itemListView(tool_name, await hydrateRows(specs));
            }
        }

        if (isReadTextResult(tool_name, content, metadata)) {
            const data = extractReadTextData(content, metadata);
            if (data) {
                return itemListView(tool_name, await hydrateRows(lineRowSpecs(data.lines)));
            }
        }

        if (isViewToolResult(tool_name, content, metadata)) {
            const data = extractViewToolData(content, metadata);
            if (data) {
                // Image rows are unlabeled; PDF rows get a page label.
                const specs = data.kind === "pdf"
                    ? pageRowSpecs(data.images, (img) => img.page_number ?? undefined)
                    : data.images.map((img) => ({
                        ref: { library_id: img.library_id, zotero_key: img.zotero_key },
                        headline: "parent" as const,
                    }));
                // Collapse duplicate attachment refs for the image case.
                const deduped = data.kind === "pdf" ? specs : dedupeByRef(specs);
                return itemListView(tool_name, await hydrateRows(deduped));
            }
        }

        if (isViewPageImagesResult(tool_name, content, metadata)) {
            const data = extractViewPageImagesData(content, metadata);
            if (data) {
                const specs = pageRowSpecs(data.pages, (p) => p.page_number);
                return itemListView(tool_name, await hydrateRows(specs));
            }
        }

        if (isSearchInAttachmentResult(part)) {
            return buildSearchInAttachmentView(part);
        }

        if (isSearchInDocumentsResult(part)) {
            return buildSearchInDocumentsView(part);
        }

        // --- self-contained / specialized views ---
        if (isFindInAttachmentsResult(tool_name, content, metadata)) {
            return buildFindInAttachmentsView(part);
        }

        // lookup_work before external_search (both carry a `references` array).
        if (isLookupWorkResult(tool_name, content, metadata)) {
            return buildLookupWorkView(part);
        }

        if (isExternalSearchResult(tool_name, content, metadata)) {
            return buildExternalSearchView(part);
        }

        if (isListCollectionsResult(tool_name, content, metadata)) {
            return buildCollectionListView(part);
        }

        if (isListTagsResult(tool_name, content, metadata)) {
            return buildTagListView(part);
        }

        if (isGetMetadataResult(tool_name, content, metadata)) {
            const data = extractGetMetadataData(content, metadata);
            if (data && data.items.length > 0) {
                return itemListView(tool_name, await hydrateRows(
                    data.items.map((ref) => ({ ref, headline: "self" as const })),
                ));
            }
        }

        if (isExtractResult(tool_name, content, metadata)) {
            return buildExtractView(part);
        }

        if (isGetAnnotationsResult(tool_name, content, metadata)) {
            return buildAnnotationListView(part, toolCallArgs);
        }

        if (isReadNoteResult(tool_name, content, metadata)) {
            return buildReadNoteView(part);
        }
    } catch (error) {
        logger(`legacyToolResults: failed to build view for ${tool_name}: ${error}`, 1);
        return null;
    }

    return null;
}

/** Drop later references that repeat an earlier (library, key). */
function dedupeByRef(specs: RowSpec[]): RowSpec[] {
    const seen = new Set<string>();
    const out: RowSpec[] = [];
    for (const spec of specs) {
        const key = `${spec.ref.library_id}-${spec.ref.zotero_key}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(spec);
    }
    return out;
}

/**
 * Upgrade a tool-return part in place: when it lacks `metadata.view` (legacy
 * backend / old thread), synthesize and attach the hydrated view so the shared
 * render layer can render it. Parts that already carry a `view` (new backend)
 * pass through untouched.
 *
 * @param part The tool-return part (mutated in place when a view is built).
 * @param toolCallArgs Args of the matching tool-call part — needed only for the
 *   annotation-list variant; safe to omit.
 * @returns The same part (for convenience).
 */
export async function upgradeToolReturn(
    part: ToolReturnPart,
    toolCallArgs?: string | Record<string, any> | null,
): Promise<ToolReturnPart> {
    if (part.part_kind !== "tool-return") return part;
    if (part.metadata?.view) return part; // already hydrated by the backend

    const view = await buildLegacyView(part, toolCallArgs);
    if (!view) return part;

    if (!part.metadata) part.metadata = {};
    part.metadata.view = view;
    return part;
}
