/**
 * Types for tool result payloads from the agent.
 * These match the backend pydantic models.
 * 
 * Data source:
 * - `metadata.summary`: Summary data for frontend rendering (required)
 */

import { ExternalReference } from "../types/externalReferences";
import { ZoteroItemReference, CollectionReference, AttachmentInfo } from "../types/zotero";
import { ToolReturnPart } from "./types";
import { logger } from "../../src/utils/logger";

// ============================================================================
// Summary Types (from backend)
// ============================================================================

/**
 * Chunk reference with ZoteroItemReference fields and optional page.
 * Matches ChunkReference from backend.
 */
export interface ChunkReference {
    library_id: number;
    zotero_key: string;
    page?: number;
    sequence?: number;
}

/**
 * Page reference with ZoteroItemReference fields and page number.
 * Matches PageReference from backend.
 */
export interface PageReference {
    library_id: number;
    zotero_key: string;
    page_number: number;
}

/**
 * Page image reference with ZoteroItemReference fields and page metadata.
 * Matches PageImageReference from backend.
 */
export interface PageImageReference {
    library_id: number;
    zotero_key: string;
    page_number: number;
    format: "png" | "jpeg";
    width: number;
    height: number;
}

/**
 * Read note result summary.
 * Matches ReadNoteToolResultSummary from backend.
 */
export interface ReadNoteResultSummary {
    tool_name: string;
    result_count: number;
    note_item: ZoteroItemReference;
    parent_item?: ZoteroItemReference | null;
}

/**
 * Item search result summary.
 * Matches ItemSearchResultSummary from backend.
 */
export interface ItemSearchResultSummary {
    tool_name: string;
    result_count: number;
    items: ZoteroItemReference[];
}

/**
 * Fulltext search result summary.
 * Matches FulltextSearchResultSummary from backend.
 */
export interface FulltextSearchResultSummary {
    tool_name: string;
    result_count: number;
    chunks: ChunkReference[];
}

/**
 * Read pages result summary.
 * Matches ReadPagesToolResultSummary from backend.
 */
export interface ReadPagesToolResultSummary {
    tool_name: string;
    // result_count: number;
    chunks: ChunkReference[];
}

/**
 * Read pages frontend result summary.
 * Matches ReadPagesFrontendResultSummary from backend.
 * The unified `read` tool reuses this shape for paginated documents
 * (ReadDocumentResultSummary on the backend).
 */
export interface ReadPagesFrontendResultSummary {
    tool_name: string;
    result_count: number;
    pages: PageReference[];
}

/**
 * Line range reference with ZoteroItemReference fields and a contiguous
 * 1-indexed line range. Matches LineReference from backend.
 */
export interface LineReference {
    library_id: number;
    zotero_key: string;
    start_line: number;
    end_line: number;
}

/**
 * Read text result summary (unified `read` tool on text/markdown files).
 * Matches ReadTextResultSummary from backend.
 */
export interface ReadTextResultSummary {
    tool_name: string;
    result_count: number;
    lines: LineReference[];
}

/**
 * View page images result summary.
 * Matches ViewPageImagesFrontendResultSummary from backend.
 */
export interface ViewPageImagesResultSummary {
    tool_name: string;
    result_count: number;
    pages: PageImageReference[];
}

/**
 * Reference to a single image returned by the unified `view` tool.
 * Matches ViewImageReference from backend. `page_number` is null/absent for
 * image attachments.
 */
export interface ViewImageReference {
    library_id: number;
    zotero_key: string;
    page_number?: number | null;
    page_label?: string | null;
    format: "png" | "jpeg";
    width: number;
    height: number;
}

/**
 * Unified view tool result summary.
 * Matches ViewResultSummary from backend.
 */
export interface ViewResultSummary {
    tool_name: string;
    kind: "pdf" | "image";
    result_count: number;
    images: ViewImageReference[];
}

/**
 * Passage retrieval result summary.
 * Matches SearchInDocumentsToolResultSummary from backend.
 */
export interface SearchInDocumentsToolResultSummary {
    tool_name: string;
    result_count: number;
    chunks: ChunkReference[];
}

/**
 * Page search reference with ZoteroItemReference fields, page number, match info.
 * Matches PageSearchReference from backend.
 */
export interface PageSearchReference {
    library_id: number;
    zotero_key: string;
    page_number: number;
    match_count: number;
    score: number;
}

/**
 * Search in attachment result summary.
 * Matches SearchInAttachmentResultSummary from backend.
 */
export interface SearchInAttachmentResultSummary {
    tool_name: string;
    query: string;
    total_matches: number;
    pages_with_matches: number;
    pages: PageSearchReference[];
}

/**
 * Compact click-to-highlight target for one document part.
 * Matches PartLocation from backend. Which fields are set depends on the
 * attachment's content_kind; absent fields are omitted from JSON (not null).
 */
export interface AttachmentMatchTarget {
    /** Citation anchor of the part, e.g. "s33", "p12", or "l12". */
    part_id: string;
    /** 0-based page index (PDF). */
    page_idx?: number;
    /** Bounding boxes as [l, t, r, b] integer PDF points, top-left origin (PDF). */
    boxes?: [number, number, number, number][];
    /** Section href (EPUB). */
    section_href?: string;
    /** HTML anchor id nearest the part (EPUB, snapshot). */
    anchor_id?: string;
    /** Part text (possibly a prefix) for locating the passage in the reader DOM (EPUB, snapshot). */
    text?: string;
    /** 1-based line number (text documents). */
    line?: number;
    /** Last line of a line range (text documents). */
    line_end?: number;
}

/**
 * One find_in_attachments match for display.
 * Matches AttachmentMatchSummary from backend.
 */
export interface AttachmentMatchSummary {
    /** Plain-text preview centered on the query hit (no citation markup). */
    snippet: string;
    /** 1-based page number (EPUB: 1-based section ordinal); absent for text files. */
    page_number?: number;
    /** Printed page label when the PDF defines one (e.g. "226" or "iv"). */
    page_label?: string;
    /** Click target; absent when the document carries no citation anchors. */
    target?: AttachmentMatchTarget;
}

/**
 * Per-attachment find_in_attachments result for display.
 * Matches AttachmentSearchReference from backend.
 */
export interface AttachmentSearchReference {
    library_id: number;
    zotero_key: string;
    status: 'ok' | 'no_matches' | 'error';
    /** Total matches in this attachment; `matches` is the top-ranked subset. */
    match_count: number;
    /** Distinct 1-based page numbers of the returned matches, sorted. */
    pages: number[];
    content_kind: 'pdf' | 'epub' | 'text' | 'snapshot';
    /** Display previews of the returned matches, in rank order. */
    matches: AttachmentMatchSummary[];
    /** Short, user-facing reason the attachment could not be searched (status='error'). */
    error?: string;
}

/**
 * Find in attachments result summary.
 * Matches FindInAttachmentsResultSummary from backend.
 */
export interface FindInAttachmentsResultSummary {
    tool_name: string;
    query: string;
    total_matches: number;
    attachment_count: number;
    attachments: AttachmentSearchReference[];
}

// ========================
// External Search Results 
// ========================

/**
 * Reference result from content (ExternalReferenceResult from backend).
 * Contains basic bibliographic fields and external_id for matching with supplement.
 */
export interface ExternalReferenceResultContent {
    external_id: string;
    already_in_library?: boolean;
    title?: string;
    authors?: string[];
    year?: number;
    journal?: string;
    venue?: string;
    abstract?: string;
    publication_types?: string;
    fields_of_study?: string[];
    citation_count?: number;
    rank?: number;
}

/**
 * Supplement data from metadata.supplemental_data (ExternalReferenceResultSupplement from backend).
 * Contains additional fields to complete the ExternalReference.
 */
export interface ExternalReferenceResultSupplement {
    external_id?: string;
    source: "semantic_scholar" | "openalex";
    publication_date?: string;
    publication_url?: string;
    url?: string;
    identifiers?: {
        doi?: string;
        isbn?: string;
        issn?: string;
        pmid?: string;
        pmcid?: string;
        arXivID?: string;
        archiveID?: string;
    };
    is_open_access?: boolean;
    open_access_url?: string;
    reference_count?: number;
    // Full versions of truncated fields
    authors?: string[];
    journal?: {
        name?: string;
        volume?: string;
        issue?: string;
        pages?: string;
    };
    library_items?: Array<{
        library_id: number;
        zotero_key: string;
        item_id: string;
    }>;
}


// ============================================================================
// Type Guards
// ============================================================================

/** Valid tool names for chunk-based fulltext search results */
const FULLTEXT_SEARCH_TOOL_NAMES: readonly string[] = [
    // New pydantic-ai agent tools
    'fulltext_search',
    'fulltext_search_keywords',
] as const;

/** Valid tool names for chunk-based fulltext retrieval results */
const READ_PAGES_TOOL_NAMES: readonly string[] = [
    'read_pages',
    'read_attachment',
    // Unified `read` tool: paginated results reuse the read_pages frontend
    // summary shape; text results are handled by isReadTextResult below.
    'read',
] as const;

/** Valid tool names for line-based text read results */
const READ_TEXT_TOOL_NAMES: readonly string[] = [
    'read',
] as const;

/** Valid tool names for chunk-based fulltext retrieval results */
const VIEW_PAGE_IMAGES_TOOL_NAMES: readonly string[] = [
    'view_page_images',
] as const;

/** Valid tool names for unified view results */
const VIEW_TOOL_NAMES: readonly string[] = [
    'view',
] as const;

/** Valid tool names for chunk-based passage retrieval results */
const SEARCH_IN_DOCUMENTS_TOOL_NAMES: readonly string[] = [
    'search_in_documents',
] as const;

/** Valid tool names for keyword search in attachment results */
const SEARCH_IN_ATTACHMENT_TOOL_NAMES: readonly string[] = [
    'search_in_attachment',
] as const;

/** Valid tool names for find in attachments results */
const FIND_IN_ATTACHMENTS_TOOL_NAMES: readonly string[] = [
    'find_in_attachments',
] as const;

/**
 * Type guard for item search results.
 * Checks if metadata.summary is ItemSearchResultSummary.
 */
export function isItemSearchResult(
    _toolName: string,
    _content: unknown,
    metadata?: Record<string, unknown>
): metadata is { summary: ItemSearchResultSummary } {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return false;
    const summary = metadata.summary as Record<string, unknown>;
    
    return (
        typeof summary.tool_name === 'string' &&
        typeof summary.result_count === 'number' &&
        Array.isArray(summary.items) &&
        summary.items.every((item: unknown) => {
            if (!item || typeof item !== 'object') return false;
            const obj = item as Record<string, unknown>;
            return typeof obj.library_id === 'number' && typeof obj.zotero_key === 'string';
        })
    );
}

/**
 * Type guard for fulltext search results.
 * Checks if metadata.summary is FulltextSearchResultSummary.
 */
export function isFulltextSearchResult(
    toolName: string,
    _content: unknown,
    metadata?: Record<string, unknown>
): metadata is { summary: FulltextSearchResultSummary } {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return false;
    const summary = metadata.summary as Record<string, unknown>;

    // These chunk-based summaries share the same shape across search/retrieval,
    // so we disambiguate by tool name.
    const toolNameIsSearch = FULLTEXT_SEARCH_TOOL_NAMES.includes(toolName);
    const toolNameIsOtherKnownChunkTool =
        READ_PAGES_TOOL_NAMES.includes(toolName) ||
        SEARCH_IN_DOCUMENTS_TOOL_NAMES.includes(toolName);
    if (!toolNameIsSearch) {
        if (toolNameIsOtherKnownChunkTool) return false;
        const summaryToolName = typeof summary.tool_name === 'string' ? summary.tool_name : null;
        if (!summaryToolName || !FULLTEXT_SEARCH_TOOL_NAMES.includes(summaryToolName)) return false;
    }
    
    return (
        typeof summary.tool_name === 'string' &&
        typeof summary.result_count === 'number' &&
        Array.isArray(summary.chunks) &&
        summary.chunks.every((chunk: unknown) => {
            if (!chunk || typeof chunk !== 'object') return false;
            const obj = chunk as Record<string, unknown>;
            return typeof obj.library_id === 'number' && typeof obj.zotero_key === 'string';
        })
    );
}

/**
 * Type guard for read pages results.
 * Checks if metadata.summary is ReadPagesToolResultSummary.
 */
export function isReadPagesResult(
    toolName: string,
    _content: unknown,
    metadata?: Record<string, unknown>
): metadata is { summary: ReadPagesToolResultSummary } {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return false;
    const summary = metadata.summary as Record<string, unknown>;

    const toolNameIsReadPages = READ_PAGES_TOOL_NAMES.includes(toolName);
    const toolNameIsOtherKnownChunkTool =
        FULLTEXT_SEARCH_TOOL_NAMES.includes(toolName) ||
        SEARCH_IN_DOCUMENTS_TOOL_NAMES.includes(toolName);
    if (!toolNameIsReadPages) {
        if (toolNameIsOtherKnownChunkTool) return false;
        const summaryToolName = typeof summary.tool_name === 'string' ? summary.tool_name : null;
        if (!summaryToolName || !READ_PAGES_TOOL_NAMES.includes(summaryToolName)) return false;
    }
    
    return (
        typeof summary.tool_name === 'string' &&
        // typeof summary.result_count === 'number' &&
        Array.isArray(summary.chunks) &&
        summary.chunks.every((chunk: unknown) => {
            if (!chunk || typeof chunk !== 'object') return false;
            const obj = chunk as Record<string, unknown>;
            return typeof obj.library_id === 'number' && typeof obj.zotero_key === 'string';
        })
    );
}

/**
 * Type guard for read pages frontend results.
 * Checks if metadata.summary is ReadPagesFrontendResultSummary.
 */
export function isReadPagesFrontendResult(
    toolName: string,
    _content: unknown,
    metadata?: Record<string, unknown>
): metadata is { summary: ReadPagesFrontendResultSummary } {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return false;
    const summary = metadata.summary as Record<string, unknown>;

    const toolNameIsReadPages = READ_PAGES_TOOL_NAMES.includes(toolName);
    if (!toolNameIsReadPages) {
        const summaryToolName = typeof summary.tool_name === 'string' ? summary.tool_name : null;
        if (!summaryToolName || !READ_PAGES_TOOL_NAMES.includes(summaryToolName)) return false;
    }
    
    return (
        typeof summary.tool_name === 'string' &&
        typeof summary.result_count === 'number' &&
        Array.isArray(summary.pages) &&
        summary.pages.every((page: unknown) => {
            if (!page || typeof page !== 'object') return false;
            const obj = page as Record<string, unknown>;
            return (
                typeof obj.library_id === 'number' &&
                typeof obj.zotero_key === 'string' &&
                typeof obj.page_number === 'number'
            );
        })
    );
}

/**
 * Type guard for text/markdown read results (unified `read` tool).
 * Checks if metadata.summary is ReadTextResultSummary.
 */
export function isReadTextResult(
    toolName: string,
    _content: unknown,
    metadata?: Record<string, unknown>
): metadata is { summary: ReadTextResultSummary } {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return false;
    const summary = metadata.summary as Record<string, unknown>;

    const toolNameIsRead = READ_TEXT_TOOL_NAMES.includes(toolName);
    if (!toolNameIsRead) {
        const summaryToolName = typeof summary.tool_name === 'string' ? summary.tool_name : null;
        if (!summaryToolName || !READ_TEXT_TOOL_NAMES.includes(summaryToolName)) return false;
    }

    return (
        typeof summary.tool_name === 'string' &&
        typeof summary.result_count === 'number' &&
        Array.isArray(summary.lines) &&
        summary.lines.every((range: unknown) => {
            if (!range || typeof range !== 'object') return false;
            const obj = range as Record<string, unknown>;
            return (
                typeof obj.library_id === 'number' &&
                typeof obj.zotero_key === 'string' &&
                typeof obj.start_line === 'number' &&
                typeof obj.end_line === 'number'
            );
        })
    );
}

/**
 * Type guard for view page images results.
 * Checks if metadata.summary is ViewPageImagesResultSummary.
 */
export function isViewPageImagesResult(
    toolName: string,
    _content: unknown,
    metadata?: Record<string, unknown>
): metadata is { summary: ViewPageImagesResultSummary } {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return false;
    const summary = metadata.summary as Record<string, unknown>;

    const toolNameIsViewPages = VIEW_PAGE_IMAGES_TOOL_NAMES.includes(toolName);
    if (!toolNameIsViewPages) {
        const summaryToolName = typeof summary.tool_name === 'string' ? summary.tool_name : null;
        if (!summaryToolName || !VIEW_PAGE_IMAGES_TOOL_NAMES.includes(summaryToolName)) return false;
    }
    
    return (
        typeof summary.tool_name === 'string' &&
        typeof summary.result_count === 'number' &&
        Array.isArray(summary.pages) &&
        summary.pages.every((page: unknown) => {
            if (!page || typeof page !== 'object') return false;
            const obj = page as Record<string, unknown>;
            return (
                typeof obj.library_id === 'number' &&
                typeof obj.zotero_key === 'string' &&
                typeof obj.page_number === 'number' &&
                typeof obj.format === 'string' &&
                typeof obj.width === 'number' &&
                typeof obj.height === 'number'
            );
        })
    );
}

/**
 * Type guard for unified view tool results.
 * Checks if metadata.summary is ViewResultSummary.
 */
export function isViewToolResult(
    toolName: string,
    _content: unknown,
    metadata?: Record<string, unknown>
): metadata is { summary: ViewResultSummary } {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return false;
    const summary = metadata.summary as Record<string, unknown>;

    const toolNameIsView = VIEW_TOOL_NAMES.includes(toolName);
    if (!toolNameIsView) {
        const summaryToolName = typeof summary.tool_name === 'string' ? summary.tool_name : null;
        if (!summaryToolName || !VIEW_TOOL_NAMES.includes(summaryToolName)) return false;
    }

    return (
        typeof summary.tool_name === 'string' &&
        (summary.kind === 'pdf' || summary.kind === 'image') &&
        typeof summary.result_count === 'number' &&
        Array.isArray(summary.images) &&
        summary.images.every((image: unknown) => {
            if (!image || typeof image !== 'object') return false;
            const obj = image as Record<string, unknown>;
            return (
                typeof obj.library_id === 'number' &&
                typeof obj.zotero_key === 'string' &&
                (obj.page_number == null || typeof obj.page_number === 'number') &&
                typeof obj.format === 'string' &&
                typeof obj.width === 'number' &&
                typeof obj.height === 'number'
            );
        })
    );
}


/**
 * Type guard for find in attachments results (keyword search across attachments).
 * Checks if metadata.summary is FindInAttachmentsResultSummary.
 *
 * Deliberately lenient: only the discriminating shape is validated. Optional
 * fields (status, matches, content_kind, ...) are omitted by the backend when
 * absent and normalized by `extractFindInAttachmentsData`.
 */
export function isFindInAttachmentsResult(
    toolName: string,
    _content: unknown,
    metadata?: Record<string, unknown>
): metadata is { summary: FindInAttachmentsResultSummary } {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return false;
    const summary = metadata.summary as Record<string, unknown>;

    const toolNameIsFindInAttachments = FIND_IN_ATTACHMENTS_TOOL_NAMES.includes(toolName);
    if (!toolNameIsFindInAttachments) {
        const summaryToolName = typeof summary.tool_name === 'string' ? summary.tool_name : null;
        if (!summaryToolName || !FIND_IN_ATTACHMENTS_TOOL_NAMES.includes(summaryToolName)) return false;
    }

    return (
        typeof summary.tool_name === 'string' &&
        Array.isArray(summary.attachments) &&
        summary.attachments.every((att: unknown) => {
            if (!att || typeof att !== 'object') return false;
            const obj = att as Record<string, unknown>;
            return typeof obj.library_id === 'number' && typeof obj.zotero_key === 'string';
        })
    );
}

/** Valid tool names for lookup work results */
const LOOKUP_WORK_TOOL_NAMES: readonly string[] = [
    'lookup_work',
] as const;

/**
 * Type guard for external search results.
 * Checks content has references array with external_id, and optionally
 * metadata.supplemental_data has array with external_id.
 */
export function isExternalSearchResult(
    toolName: string,
    content: unknown,
    metadata?: Record<string, unknown>
): boolean {
    if (LOOKUP_WORK_TOOL_NAMES.includes(toolName)) return false;

    // Validate content has references array with external_id
    if (!content || typeof content !== 'object') return false;
    const contentObj = content as Record<string, unknown>;
    if (!Array.isArray(contentObj.references)) return false;
    if (!contentObj.references.every((ref: unknown) => {
        if (!ref || typeof ref !== 'object') return false;
        const obj = ref as Record<string, unknown>;
        return typeof obj.external_id === 'string';
    })) return false;

    // Validate supplemental_data if present (optional but must be valid if present)
    if (metadata?.supplemental_data != null) {
        if (!Array.isArray(metadata.supplemental_data)) return false;
        // Each supplement should have external_id for matching
        if (!metadata.supplemental_data.every((supp: unknown) => {
            if (!supp || typeof supp !== 'object') return false;
            const obj = supp as Record<string, unknown>;
            return typeof obj.external_id === 'string';
        })) return false;
    }

    return true;
}

function isExternalReferenceResultContent(ref: unknown): ref is ExternalReferenceResultContent {
    if (!ref || typeof ref !== 'object') return false;
    return typeof (ref as Record<string, unknown>).external_id === 'string';
}

/**
 * Type guard for lookup_work results.
 * Accepts the batch shape (`found_count`, `references`, …) and the legacy
 * single-result shape (`found`, `reference`).
 */
export function isLookupWorkResult(
    toolName: string,
    content: unknown,
    _metadata?: Record<string, unknown>
): boolean {
    if (!LOOKUP_WORK_TOOL_NAMES.includes(toolName)) return false;

    if (!content || typeof content !== 'object') return false;
    const contentObj = content as Record<string, unknown>;

    if (typeof contentObj.found_count === 'number') {
        if (contentObj.references != null && !Array.isArray(contentObj.references)) return false;
        if (Array.isArray(contentObj.references)) {
            return contentObj.references.every(isExternalReferenceResultContent);
        }
        return true;
    }

    if (typeof contentObj.found !== 'boolean') return false;

    if (contentObj.found === true) {
        if (!contentObj.reference || typeof contentObj.reference !== 'object') return false;
        return isExternalReferenceResultContent(contentObj.reference);
    }

    return true;
}

// ============================================================================
// Extraction Utilities
// ============================================================================

/**
 * Normalized item search data ready for rendering.
 */
export interface ItemSearchViewData {
    items: ZoteroItemReference[];
}

/**
 * Extract normalized item references from metadata.summary.
 * @returns ItemSearchViewData or null if summary is not available
 */
export function extractItemSearchData(
    _content: unknown,
    metadata?: Record<string, unknown>
): ItemSearchViewData | null {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return null;
    const summary = metadata.summary as ItemSearchResultSummary;
    
    if (!Array.isArray(summary.items)) return null;

    const items: ZoteroItemReference[] = summary.items.map(item => ({
        library_id: item.library_id,
        zotero_key: item.zotero_key,
    }));

    return { items };
}

/**
 * Normalized fulltext search data at chunk level.
 */
export interface FulltextSearchViewData {
    chunks: ChunkReference[];
}

/**
 * Extract chunk-level data from metadata.summary.
 * @returns FulltextSearchViewData or null if summary is not available
 */
export function extractFulltextSearchData(
    _content: unknown,
    metadata?: Record<string, unknown>
): FulltextSearchViewData | null {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return null;
    const summary = metadata.summary as FulltextSearchResultSummary;
    
    if (!Array.isArray(summary.chunks)) return null;

    return { chunks: summary.chunks };
}

/**
 * Normalized fulltext retrieval data - all chunks from read_pages.
 */
export interface ReadPagesViewData {
    pages: PageReference[];
}

/**
 * Extract all chunks from metadata.summary.
 * @returns ReadPagesViewData or null if summary is not available
 */
export function extractReadPagesData(
    _content: unknown,
    metadata?: Record<string, unknown>
): ReadPagesViewData | null {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return null;
    const summary = metadata.summary as ReadPagesToolResultSummary;
    
    if (!Array.isArray(summary.chunks)) return null;

    const pages: PageReference[] = [];
    for (const chunk of summary.chunks) {
        if (chunk.page !== undefined) {
            pages.push({
                library_id: chunk.library_id,
                zotero_key: chunk.zotero_key,
                page_number: chunk.page,
            });
        }
    }

    return { pages };
}

/**
 * Extract all chunks from metadata.summary.
 * @returns ReadPagesViewData or null if summary is not available
 */
export function extractReadPagesFrontendData(
    _content: unknown,
    metadata?: Record<string, unknown>
): ReadPagesViewData | null {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return null;
    const summary = metadata.summary as ReadPagesFrontendResultSummary;
    
    if (!Array.isArray(summary.pages)) return null;

    const pages: PageReference[] = [];
    for (const page of summary.pages) {
        if (page.page_number !== undefined) {
            pages.push({
                library_id: page.library_id,
                zotero_key: page.zotero_key,
                page_number: page.page_number,
            });
        }
    }

    return { pages };
}


/**
 * Normalized text read data - line ranges from the unified `read` tool.
 */
export interface ReadTextViewData {
    lines: LineReference[];
}

/**
 * Extract line range references from metadata.summary for text reads.
 * @returns ReadTextViewData or null if summary is not available
 */
export function extractReadTextData(
    _content: unknown,
    metadata?: Record<string, unknown>
): ReadTextViewData | null {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return null;
    const summary = metadata.summary as ReadTextResultSummary;

    if (!Array.isArray(summary.lines)) return null;

    return { lines: summary.lines };
}

/**
 * Build a human-readable line range label (e.g. "lines 1-120") from a
 * completed text read result. Returns null if the result is not a text read.
 */
export function extractReadTextLineRangeLabel(
    toolName: string,
    content: unknown,
    metadata?: Record<string, unknown>
): string | null {
    if (!isReadTextResult(toolName, content, metadata)) return null;
    const data = extractReadTextData(content, metadata);
    if (!data || data.lines.length === 0) return null;

    const start = Math.min(...data.lines.map(range => range.start_line));
    const end = Math.max(...data.lines.map(range => range.end_line));
    return start === end ? `line ${start}` : `lines ${start}-${end}`;
}

/**
 * Normalized page images data.
 */
export interface ViewPageImagesViewData {
    pages: PageImageReference[];
}

/**
 * Extract page image references from metadata.summary.
 * @returns ViewPageImagesViewData or null if summary is not available
 */
export function extractViewPageImagesData(
    _content: unknown,
    metadata?: Record<string, unknown>
): ViewPageImagesViewData | null {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return null;
    const summary = metadata.summary as ViewPageImagesResultSummary;
    
    if (!Array.isArray(summary.pages)) return null;

    return { pages: summary.pages };
}

/**
 * Normalized unified view tool data.
 */
export interface ViewToolViewData {
    kind: "pdf" | "image";
    images: ViewImageReference[];
}

/**
 * Extract image references from metadata.summary for the unified view tool.
 * @returns ViewToolViewData or null if summary is not available
 */
export function extractViewToolData(
    _content: unknown,
    metadata?: Record<string, unknown>
): ViewToolViewData | null {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return null;
    const summary = metadata.summary as ViewResultSummary;

    if (!Array.isArray(summary.images)) return null;

    return {
        kind: summary.kind === 'image' ? 'image' : 'pdf',
        images: summary.images,
    };
}

/**
 * Normalized passage retrieval data.
 */
export interface PassageRetrievalViewData {
    chunks: ChunkReference[];
}

/**
 * Normalized search in attachment data.
 */
export interface SearchInAttachmentViewData {
    pages: PageReference[];
}

/**
 * Normalized find in attachments data ready for rendering.
 */
export interface FindInAttachmentsViewData {
    query: string;
    totalMatches: number;
    attachmentCount: number;
    attachments: AttachmentSearchReference[];
}

/**
 * Extract per-attachment match data from metadata.summary for find_in_attachments.
 * Normalizes fields the backend omits when absent.
 * @returns FindInAttachmentsViewData or null if summary is not available
 */
export function extractFindInAttachmentsData(
    _content: unknown,
    metadata?: Record<string, unknown>
): FindInAttachmentsViewData | null {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return null;
    const summary = metadata.summary as FindInAttachmentsResultSummary;

    if (!Array.isArray(summary.attachments)) return null;

    const attachments: AttachmentSearchReference[] = summary.attachments.map(att => {
        const matches = Array.isArray(att.matches) ? att.matches : [];
        return {
            library_id: att.library_id,
            zotero_key: att.zotero_key,
            status: att.status ?? 'ok',
            match_count: typeof att.match_count === 'number' ? att.match_count : matches.length,
            pages: Array.isArray(att.pages) ? att.pages : [],
            content_kind: att.content_kind ?? 'pdf',
            matches,
            error: typeof att.error === 'string' ? att.error : undefined,
        };
    });

    return {
        query: summary.query ?? '',
        totalMatches: typeof summary.total_matches === 'number' ? summary.total_matches : 0,
        attachmentCount: typeof summary.attachment_count === 'number'
            ? summary.attachment_count
            : attachments.length,
        attachments,
    };
}

/**
 * Normalized external search data ready for rendering.
 */
export interface ExternalSearchViewData {
    references: ExternalReference[];
}

/**
 * Normalize supplemental reference metadata from current batch arrays or legacy single objects.
 */
function getExternalReferenceSupplements(metadata?: Record<string, unknown>): ExternalReferenceResultSupplement[] {
    const supplementalData = metadata?.supplemental_data;
    if (Array.isArray(supplementalData)) {
        return supplementalData as ExternalReferenceResultSupplement[];
    }

    if (supplementalData && typeof supplementalData === 'object') {
        return [supplementalData as ExternalReferenceResultSupplement];
    }

    return [];
}

/**
 * Merge ExternalReferenceResultContent rows with metadata.supplemental_data.
 */
export function mergeExternalReferenceContents(
    referenceContents: ExternalReferenceResultContent[],
    metadata?: Record<string, unknown>
): ExternalReference[] {
    const supplementMap = new Map<string, ExternalReferenceResultSupplement>();
    for (const supp of getExternalReferenceSupplements(metadata)) {
        if (supp.external_id) {
            supplementMap.set(supp.external_id, supp);
        }
    }

    return referenceContents.map(ref => {
        const supp = supplementMap.get(ref.external_id);

        return {
            source_id: ref.external_id,
            title: ref.title,
            authors: supp?.authors ?? ref.authors,
            year: ref.year,
            venue: ref.venue,
            abstract: ref.abstract,
            fields_of_study: ref.fields_of_study,
            citation_count: ref.citation_count,
            source: supp?.source ?? "openalex",
            id: supp?.external_id,
            publication_date: supp?.publication_date,
            publication_url: supp?.publication_url,
            url: supp?.url,
            identifiers: supp?.identifiers,
            is_open_access: supp?.is_open_access,
            open_access_url: supp?.open_access_url,
            reference_count: supp?.reference_count,
            journal: supp?.journal ?? (ref.journal ? { name: ref.journal } : undefined),
            library_items: supp?.library_items ?? [],
        };
    });
}

/**
 * Extract and merge external references from content and metadata.supplemental_data.
 * Combines ExternalReferenceResultContent with ExternalReferenceResultSupplement by external_id.
 */
export function extractExternalSearchData(
    content: unknown,
    metadata?: Record<string, unknown>
): ExternalSearchViewData | null {
    const contentObj = content as { references?: ExternalReferenceResultContent[] } | undefined;
    if (!contentObj || !Array.isArray(contentObj.references)) return null;

    return { references: mergeExternalReferenceContents(contentObj.references, metadata) };
}

/**
 * Normalized lookup work data ready for rendering.
 */
export interface LookupWorkViewData {
    foundCount: number;
    references: ExternalReference[];
    notFoundQueries: string[];
    temporarilyUncheckedQueries: string[];
    message?: string;
}

function stringArrayField(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Read the number of works found from a lookup_work tool return payload.
 */
export function extractLookupWorkFoundCount(content: unknown): number | null {
    if (!content || typeof content !== 'object') return null;
    const contentObj = content as Record<string, unknown>;

    if (typeof contentObj.found_count === 'number') {
        return contentObj.found_count;
    }

    if (typeof contentObj.found === 'boolean') {
        return contentObj.found ? 1 : 0;
    }

    if (Array.isArray(contentObj.references)) {
        return contentObj.references.length;
    }

    return null;
}

/**
 * Extract and merge lookup work data from content and metadata.supplemental_data.
 */
export function extractLookupWorkData(
    content: unknown,
    metadata?: Record<string, unknown>
): LookupWorkViewData | null {
    if (!content || typeof content !== 'object') return null;
    const contentObj = content as Record<string, unknown>;
    const message = typeof contentObj.message === 'string' ? contentObj.message : undefined;

    if (typeof contentObj.found_count === 'number') {
        const referenceContents = Array.isArray(contentObj.references)
            ? contentObj.references.filter(isExternalReferenceResultContent)
            : [];

        return {
            foundCount: contentObj.found_count,
            references: mergeExternalReferenceContents(referenceContents, metadata),
            notFoundQueries: stringArrayField(contentObj.not_found_queries),
            temporarilyUncheckedQueries: stringArrayField(contentObj.temporarily_unchecked_queries),
            message,
        };
    }

    if (typeof contentObj.found !== 'boolean') return null;

    if (!contentObj.found) {
        return {
            foundCount: 0,
            references: [],
            notFoundQueries: [],
            temporarilyUncheckedQueries: [],
            message,
        };
    }

    if (!isExternalReferenceResultContent(contentObj.reference)) return null;

    return {
        foundCount: 1,
        references: mergeExternalReferenceContents([contentObj.reference], metadata),
        notFoundQueries: [],
        temporarilyUncheckedQueries: [],
        message,
    };
}

// ============================================================================
// Extract Tool Results
// ============================================================================

/** Valid tool names for extract results */
const EXTRACT_TOOL_NAMES: readonly string[] = [
    'extract',
] as const;

/**
 * Per-item extraction reference with status.
 * Matches ItemExtractionReference from backend.
 */
export interface ItemExtractionReference {
    library_id: number;
    zotero_key: string;
    // "success" | "error" is the current backend vocabulary. "relevant" /
    // "not_relevant" are legacy values still present in older thread history.
    status: "success" | "error" | "relevant" | "not_relevant";
    title?: string | null;
    authors?: string | null;
    year?: number | null;
}

/**
 * Extract tool result summary.
 * Matches ExtractToolResultSummary from backend.
 */
export interface ExtractToolResultSummary {
    tool_name: string;
    total_items: number;
    items_processed: number;
    // Legacy field; the backend no longer requires it. Kept optional so older
    // history still type-checks and newer payloads that omit it are accepted.
    items_relevant?: number;
    items_failed: number;
    total_pages_processed: number;
    items: ItemExtractionReference[];
}

/**
 * Type guard for extract tool results.
 * Checks if metadata.summary is ExtractToolResultSummary.
 */
export function isExtractResult(
    toolName: string,
    _content: unknown,
    metadata?: Record<string, unknown>
): metadata is { summary: ExtractToolResultSummary } {
    if (!EXTRACT_TOOL_NAMES.includes(toolName)) {
        // Fall back to summary.tool_name
        if (!metadata?.summary || typeof metadata.summary !== 'object') return false;
        const summary = metadata.summary as Record<string, unknown>;
        if (summary.tool_name !== 'extract') return false;
    }

    if (!metadata?.summary || typeof metadata.summary !== 'object') return false;
    const summary = metadata.summary as Record<string, unknown>;

    return (
        typeof summary.tool_name === 'string' &&
        typeof summary.total_items === 'number' &&
        typeof summary.items_processed === 'number' &&
        // items_relevant is legacy/optional — don't require it so the guard
        // still matches once the backend stops sending it.
        typeof summary.items_failed === 'number' &&
        Array.isArray(summary.items) &&
        summary.items.every((item: unknown) => {
            if (!item || typeof item !== 'object') return false;
            const obj = item as Record<string, unknown>;
            return (
                typeof obj.library_id === 'number' &&
                typeof obj.zotero_key === 'string' &&
                typeof obj.status === 'string'
            );
        })
    );
}

/**
 * Normalized extract view data ready for rendering.
 */
export interface ExtractViewData {
    items: ItemExtractionReference[];
    totalItems: number;
    itemsRelevant: number;
    itemsProcessed: number;
    itemsFailed: number;
}

/**
 * Extract data from metadata.summary for extract tool results.
 */
export function extractExtractData(
    _content: unknown,
    metadata?: Record<string, unknown>
): ExtractViewData | null {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return null;
    const summary = metadata.summary as ExtractToolResultSummary;

    if (!Array.isArray(summary.items)) return null;

    return {
        items: summary.items,
        totalItems: summary.total_items,
        // Fall back to items_processed for newer payloads that omit the
        // legacy items_relevant field.
        itemsRelevant: summary.items_relevant ?? summary.items_processed,
        itemsProcessed: summary.items_processed,
        itemsFailed: summary.items_failed,
    };
}

// ============================================================================
// Read Note Tool Results
// ============================================================================

/** Valid tool names for read note results */
const READ_NOTE_TOOL_NAMES: readonly string[] = [
    'read_note',
] as const;

/**
 * View data for read_note results.
 */
export interface ReadNoteViewData {
    noteReference: { library_id: number; zotero_key: string };
    parentReference?: { library_id: number; zotero_key: string };
    totalLines?: number;
    linesReturned?: string;
}

function isZoteroItemReference(value: unknown): value is ZoteroItemReference {
    if (!value || typeof value !== 'object') return false;
    const obj = value as Record<string, unknown>;
    return typeof obj.library_id === 'number' && typeof obj.zotero_key === 'string';
}

function parseZoteroUniqueKey(uniqueKey: string): ZoteroItemReference | null {
    const [libraryIdStr, ...keyParts] = uniqueKey.split('-');
    const libraryId = parseInt(libraryIdStr, 10);
    const zoteroKey = keyParts.join('-');
    if (isNaN(libraryId) || !zoteroKey) return null;
    return { library_id: libraryId, zotero_key: zoteroKey };
}

/**
 * Type guard for read_note results.
 * Uses metadata.summary for dehydrated results and content for older hydrated results.
 */
export function isReadNoteResult(
    toolName: string,
    content: unknown,
    metadata?: Record<string, unknown>
): boolean {
    if (!READ_NOTE_TOOL_NAMES.includes(toolName)) return false;

    if (metadata?.summary && typeof metadata.summary === 'object') {
        const summary = metadata.summary as Record<string, unknown>;
        return (
            summary.tool_name === 'read_note' &&
            typeof summary.result_count === 'number' &&
            isZoteroItemReference(summary.note_item) &&
            (
                summary.parent_item === undefined ||
                summary.parent_item === null ||
                isZoteroItemReference(summary.parent_item)
            )
        );
    }

    if (!content || typeof content !== 'object') return false;
    const obj = content as Record<string, unknown>;
    return typeof obj.note_id === 'string' && typeof obj.content === 'string';
}

/**
 * Extract read note data from metadata.summary or legacy content.
 */
export function extractReadNoteData(
    content: unknown,
    metadata?: Record<string, unknown>
): ReadNoteViewData | null {
    if (metadata?.summary && typeof metadata.summary === 'object') {
        const summary = metadata.summary as ReadNoteResultSummary;
        if (!isZoteroItemReference(summary.note_item)) return null;
        if (
            summary.parent_item !== undefined &&
            summary.parent_item !== null &&
            !isZoteroItemReference(summary.parent_item)
        ) {
            return null;
        }
        return {
            noteReference: summary.note_item,
            parentReference: summary.parent_item ?? undefined,
        };
    }

    if (!content || typeof content !== 'object') return null;
    const obj = content as Record<string, unknown>;

    const noteId = obj.note_id as string | undefined;
    if (!noteId) return null;

    const noteReference = parseZoteroUniqueKey(noteId);
    if (!noteReference) return null;

    // Parse parent_item_id if present
    let parentReference: { library_id: number; zotero_key: string } | undefined;
    const parentItemId = obj.parent_item_id as string | undefined;
    if (parentItemId) {
        parentReference = parseZoteroUniqueKey(parentItemId) ?? undefined;
    }

    return {
        noteReference,
        parentReference,
        totalLines: typeof obj.total_lines === 'number' ? obj.total_lines : undefined,
        linesReturned: obj.lines_returned as string | undefined,
    };
}

// ============================================================================
// Unified Extraction
// ============================================================================

/**
 * Extract ZoteroItemReference list from a tool-return part.
 * Supports item search, fulltext search, fulltext retrieval, passage retrieval, and view page images results.
 * @param part Tool return part to extract references from
 * @returns Array of ZoteroItemReference, or empty array if not a supported tool result type
 */
export function extractZoteroReferences(part: ToolReturnPart): ZoteroItemReference[] {
    const { tool_name, content, metadata } = part;

    // Item search results
    if (isItemSearchResult(tool_name, content, metadata)) {
        const data = extractItemSearchData(content, metadata);
        return data?.items ?? [];
    }

    // Fulltext search results (chunks)
    if (isFulltextSearchResult(tool_name, content, metadata)) {
        const data = extractFulltextSearchData(content, metadata);
        return data?.chunks ?? [];
    }

    // Read pages results (pages)
    if (isReadPagesResult(tool_name, content, metadata)) {
        const data = extractReadPagesData(content, metadata);
        return data?.pages ?? [];
    }

    // Read pages frontend results (pages)
    if (isReadPagesFrontendResult(tool_name, content, metadata)) {
        const data = extractReadPagesFrontendData(content, metadata);
        return data?.pages ?? [];
    }

    // Text read results (line ranges from the unified `read` tool)
    if (isReadTextResult(tool_name, content, metadata)) {
        const data = extractReadTextData(content, metadata);
        return data?.lines.map(range => ({
            library_id: range.library_id,
            zotero_key: range.zotero_key,
        })) ?? [];
    }

    // View page images results
    if (isViewPageImagesResult(tool_name, content, metadata)) {
        const data = extractViewPageImagesData(content, metadata);
        return data?.pages ?? [];
    }

    // Find in attachments results (attachments)
    if (isFindInAttachmentsResult(tool_name, content, metadata)) {
        const data = extractFindInAttachmentsData(content, metadata);
        return data?.attachments.map(att => ({
            library_id: att.library_id,
            zotero_key: att.zotero_key,
        })) ?? [];
    }

    // Extract tool results
    if (isExtractResult(tool_name, content, metadata)) {
        const data = extractExtractData(content, metadata);
        return data?.items?.map(item => ({
            library_id: item.library_id,
            zotero_key: item.zotero_key,
        })) ?? [];
    }

    // Read note results
    if (isReadNoteResult(tool_name, content, metadata)) {
        const data = extractReadNoteData(content, metadata);
        return data?.noteReference ? [data.noteReference] : [];
    }

    return [];
}

// ============================================================================
// Library Management Tool Results
// ============================================================================

/** Valid tool names for zotero search results */
const ZOTERO_SEARCH_TOOL_NAMES: readonly string[] = [
    'zotero_search',
] as const;

/** Valid tool names for list items results */
const LIST_ITEMS_TOOL_NAMES: readonly string[] = [
    'list_items',
] as const;

/** Valid tool names for list collections results */
const LIST_COLLECTIONS_TOOL_NAMES: readonly string[] = [
    'list_collections',
] as const;

/** Valid tool names for list tags results */
const LIST_TAGS_TOOL_NAMES: readonly string[] = [
    'list_tags',
] as const;

/** Valid tool names for get metadata results */
const GET_METADATA_TOOL_NAMES: readonly string[] = [
    'get_metadata',
] as const;

// ============================================================================
// Library Management Summary Types (from backend)
// ============================================================================

/**
 * Collection reference as sent by the backend in list_collections summaries.
 *
 * The current backend omits library scope here; `extractListCollectionsData`
 * normalizes it into the canonical `CollectionReference`. The optional fields
 * forward-support a backend that later emits a per-collection `library_id` or
 * a compound `collection_key` ("<library_id>-<key>").
 */
export interface BackendCollectionRef {
    collection_key: string;
    name: string;
    /** Optional per-collection library scope (future backend format). */
    library_id?: number | null;
    /** Optional parent collection key (future backend format). */
    parent_key?: string | null;
}

/**
 * Tag reference for UI display.
 * Matches TagReference from backend.
 */
export interface TagReference {
    name: string;
    /** Number of top-level regular items carrying this tag. */
    item_count: number;
    /** Number of attachments carrying this tag. Omitted by older backends. */
    attachment_count?: number;
    /** Number of notes carrying this tag. Omitted by older backends. */
    note_count?: number;
    /** Number of annotations carrying this tag. Omitted by older backends. */
    annotation_count?: number;
}

/**
 * Zotero search result summary.
 * Matches ZoteroSearchResultSummary from backend.
 */
export interface ZoteroSearchResultSummary {
    tool_name: string;
    result_count: number;
    total_count: number;
    has_more: boolean;
    items: ZoteroItemReference[];
}

/**
 * List items result summary.
 * Matches ListItemsResultSummary from backend.
 */
export interface ListItemsResultSummary {
    tool_name: string;
    result_count: number;
    total_count: number;
    has_more: boolean;
    library_name?: string | null;
    collection_name?: string | null;
    tag?: string | null;
    items: ZoteroItemReference[];
}

/**
 * List collections result summary.
 * Matches ListCollectionsResultSummary from backend.
 */
export interface ListCollectionsResultSummary {
    tool_name: string;
    collection_count: number;
    total_count: number;
    has_more: boolean;
    library_id?: number | null;
    library_name?: string | null;
    collections: BackendCollectionRef[];
    /** Set on a failed list_collections response (no library scope in that case). */
    error?: string | null;
    error_code?: string | null;
}

/**
 * List tags result summary.
 * Matches ListTagsResultSummary from backend.
 */
export interface ListTagsResultSummary {
    tool_name: string;
    tag_count: number;
    total_count: number;
    has_more: boolean;
    library_id?: number | null;
    library_name?: string | null;
    tags: TagReference[];
}

/**
 * Get metadata result summary.
 * Matches GetMetadataResultSummary from backend.
 */
export interface GetMetadataResultSummary {
    tool_name: string;
    items_found: number;
    items_not_found: number;
    items: ZoteroItemReference[];
}

/**
 * Regular (non-note/attachment) result item from zotero_search.
 * Matches RegularSearchResultItem from agentProtocol.
 */
export interface RegularSearchResultItem {
    result_type: 'regular';
    item_id: string;
    item_type: string;
    title?: string | null;
    creators?: string | null;
    year?: number | null;
    extra_fields?: Record<string, unknown> | null;
}

/** Note result item from search/list results */
export interface NoteResultItem {
    result_type: 'note';
    item_id: string;
    title?: string | null;
    parent_item_id?: string | null;
    parent_title?: string | null;
    date_modified?: string | null;
}

/** Attachment result item from search/list results */
export type AttachmentResultItem = AttachmentInfo & {
    result_type: 'attachment';
    item_id?: string | null;
    parent_title?: string | null;
    date_modified?: string | null;
};

/** Result item from zotero_search (regular, note, or attachment) */
export type ZoteroSearchResultItem = RegularSearchResultItem | NoteResultItem | AttachmentResultItem;

/**
 * Regular (non-note/attachment) result item from list_items.
 * Matches RegularListResultItem from agentProtocol.
 */
export interface RegularListResultItem {
    result_type: 'regular';
    item_id: string;
    item_type: string;
    title?: string | null;
    creators?: string | null;
    year?: number | null;
    date_added?: string | null;
    date_modified?: string | null;
}

/** Result item from list_items (regular, note, or attachment) */
export type ListItemsResultItem = RegularListResultItem | NoteResultItem | AttachmentResultItem;

/**
 * Collection info from list_collections.
 * Matches CollectionInfo from backend.
 */
export interface CollectionInfo {
    collection_key: string;
    name: string;
    /** Optional per-collection library scope (future backend format). */
    library_id?: number | null;
    parent_key?: string | null;
    parent_name?: string | null;
    item_count: number;
    subcollection_count: number;
}

/**
 * Tag info from list_tags.
 * Matches TagInfo from backend.
 */
export interface TagInfo {
    name: string;
    /** Number of top-level regular items carrying this tag. */
    item_count: number;
    /** Number of attachments carrying this tag. Omitted by older frontends. */
    attachment_count?: number;
    /** Number of notes carrying this tag. Omitted by older frontends. */
    note_count?: number;
    /** Number of annotations carrying this tag. Omitted by older frontends. */
    annotation_count?: number;
    color?: string | null;
}

/**
 * Metadata item from get_metadata.
 * Contains item_id and metadata fields.
 */
export interface MetadataResultItem {
    item_id: string;
    [key: string]: unknown;
}

/**
 * Content structure for get_metadata results.
 */
export interface GetMetadataResultContent {
    items: MetadataResultItem[];
    not_found: string[];
}

/**
 * Content structure for zotero_search results.
 */
export interface ZoteroSearchResultContent {
    items: ZoteroSearchResultItem[];
    total_count: number;
}

/**
 * Content structure for list_items results.
 */
export interface ListItemsResultContent {
    items: ListItemsResultItem[];
    total_count: number;
    library_name?: string | null;
    collection_name?: string | null;
}

/**
 * Content structure for list_collections results.
 */
export interface ListCollectionsResultContent {
    collections: CollectionInfo[];
    total_count: number;
    library_id?: number | null;
    library_name?: string | null;
    /** Set on a failed list_collections response (no library scope in that case). */
    error?: string | null;
    error_code?: string | null;
}

/**
 * Content structure for list_tags results.
 */
export interface ListTagsResultContent {
    tags: TagInfo[];
    total_count: number;
    library_id?: number | null;
    library_name?: string | null;
}

/**
 * Type guard for zotero_search results.
 * Checks both content and metadata.summary for compatibility with dehydrated results.
 */
export function isZoteroSearchResult(
    toolName: string,
    content: unknown,
    metadata?: Record<string, unknown>
): boolean {
    if (!ZOTERO_SEARCH_TOOL_NAMES.includes(toolName)) return false;
    
    // Check content (non-dehydrated)
    if (content && typeof content === 'object') {
        const obj = content as Record<string, unknown>;
        if (Array.isArray(obj.items) && typeof obj.total_count === 'number') {
            return true;
        }
    }
    
    // Check metadata.summary (dehydrated)
    if (metadata?.summary && typeof metadata.summary === 'object') {
        const summary = metadata.summary as Record<string, unknown>;
        if (
            summary.tool_name === 'zotero_search' &&
            Array.isArray(summary.items) &&
            typeof summary.total_count === 'number'
        ) {
            return true;
        }
    }
    
    return false;
}

/**
 * Type guard for list_items results.
 * Checks both content and metadata.summary for compatibility with dehydrated results.
 */
export function isListItemsResult(
    toolName: string,
    content: unknown,
    metadata?: Record<string, unknown>
): boolean {
    if (!LIST_ITEMS_TOOL_NAMES.includes(toolName)) return false;
    
    // Check content (non-dehydrated)
    if (content && typeof content === 'object') {
        const obj = content as Record<string, unknown>;
        if (Array.isArray(obj.items) && typeof obj.total_count === 'number') {
            return true;
        }
    }
    
    // Check metadata.summary (dehydrated)
    if (metadata?.summary && typeof metadata.summary === 'object') {
        const summary = metadata.summary as Record<string, unknown>;
        if (
            summary.tool_name === 'list_items' &&
            Array.isArray(summary.items) &&
            typeof summary.total_count === 'number'
        ) {
            return true;
        }
    }
    
    return false;
}

/**
 * Type guard for list_collections results.
 * Checks both content and metadata.summary for compatibility with dehydrated results.
 */
export function isListCollectionsResult(
    toolName: string,
    content: unknown,
    metadata?: Record<string, unknown>
): boolean {
    if (!LIST_COLLECTIONS_TOOL_NAMES.includes(toolName)) return false;
    
    // Check content (non-dehydrated)
    if (content && typeof content === 'object') {
        const obj = content as Record<string, unknown>;
        if (Array.isArray(obj.collections) && typeof obj.total_count === 'number') {
            return true;
        }
    }
    
    // Check metadata.summary (dehydrated)
    if (metadata?.summary && typeof metadata.summary === 'object') {
        const summary = metadata.summary as Record<string, unknown>;
        if (
            summary.tool_name === 'list_collections' &&
            Array.isArray(summary.collections) &&
            typeof summary.total_count === 'number'
        ) {
            return true;
        }
    }
    
    return false;
}

/**
 * Type guard for list_tags results.
 * Checks both content and metadata.summary for compatibility with dehydrated results.
 */
export function isListTagsResult(
    toolName: string,
    content: unknown,
    metadata?: Record<string, unknown>
): boolean {
    if (!LIST_TAGS_TOOL_NAMES.includes(toolName)) return false;
    
    // Check content (non-dehydrated)
    if (content && typeof content === 'object') {
        const obj = content as Record<string, unknown>;
        if (Array.isArray(obj.tags) && typeof obj.total_count === 'number') {
            return true;
        }
    }
    
    // Check metadata.summary (dehydrated)
    if (metadata?.summary && typeof metadata.summary === 'object') {
        const summary = metadata.summary as Record<string, unknown>;
        if (
            summary.tool_name === 'list_tags' &&
            Array.isArray(summary.tags) &&
            typeof summary.total_count === 'number'
        ) {
            return true;
        }
    }
    
    return false;
}

/**
 * Type guard for get_metadata results.
 * Checks both content and metadata.summary for compatibility with dehydrated results.
 */
export function isGetMetadataResult(
    toolName: string,
    content: unknown,
    metadata?: Record<string, unknown>
): boolean {
    if (!GET_METADATA_TOOL_NAMES.includes(toolName)) return false;
    
    // Check content (non-dehydrated)
    if (content && typeof content === 'object') {
        const obj = content as Record<string, unknown>;
        if (Array.isArray(obj.items)) {
            return true;
        }
    }
    
    // Check metadata.summary (dehydrated)
    if (metadata?.summary && typeof metadata.summary === 'object') {
        const summary = metadata.summary as Record<string, unknown>;
        if (
            summary.tool_name === 'get_metadata' &&
            Array.isArray(summary.items)
        ) {
            return true;
        }
    }
    
    return false;
}

/**
 * Normalized zotero search view data.
 */
export interface ZoteroSearchViewData {
    items: ZoteroItemReference[];
    totalCount: number;
}

/**
 * Extract zotero search data from content or metadata.summary.
 * Uses metadata.summary (which contains ZoteroItemReference[]) for dehydrated results.
 */
export function extractZoteroSearchData(
    content: unknown,
    metadata?: Record<string, unknown>
): ZoteroSearchViewData | null {
    // Try content first (non-dehydrated)
    if (content && typeof content === 'object') {
        const obj = content as ZoteroSearchResultContent;
        if (Array.isArray(obj.items) && obj.items.length > 0) {
            // Convert item_ids to ZoteroItemReference
            const items: ZoteroItemReference[] = obj.items
                .map(item => {
                    const itemId = item.result_type === 'attachment'
                        ? (item.attachment_id ?? item.item_id)
                        : item.item_id;
                    if (!itemId) return null;
                    const parts = itemId.split('-');
                    if (parts.length < 2) return null;
                    const libraryId = parseInt(parts[0], 10);
                    const zoteroKey = parts.slice(1).join('-');
                    if (isNaN(libraryId) || !zoteroKey) return null;
                    return { library_id: libraryId, zotero_key: zoteroKey };
                })
                .filter((ref): ref is ZoteroItemReference => ref !== null);
            
            if (items.length > 0) {
                return { items, totalCount: obj.total_count };
            }
        }
    }
    
    // Fall back to metadata.summary (dehydrated)
    if (metadata?.summary && typeof metadata.summary === 'object') {
        const summary = metadata.summary as ZoteroSearchResultSummary;
        if (Array.isArray(summary.items)) {
            return { 
                items: summary.items.map(item => ({
                    library_id: item.library_id,
                    zotero_key: item.zotero_key,
                })),
                totalCount: summary.total_count 
            };
        }
    }
    
    return null;
}

/**
 * Normalized list items view data.
 */
export interface ListItemsViewData {
    items: ZoteroItemReference[];
    totalCount: number;
    libraryName?: string | null;
    collectionName?: string | null;
}

/**
 * Extract list items data from content or metadata.summary.
 * Uses metadata.summary (which contains ZoteroItemReference[]) for dehydrated results.
 */
export function extractListItemsData(
    content: unknown,
    metadata?: Record<string, unknown>
): ListItemsViewData | null {
    // Try content first (non-dehydrated)
    if (content && typeof content === 'object') {
        const obj = content as ListItemsResultContent;
        if (Array.isArray(obj.items) && obj.items.length > 0) {
            // Convert item_ids to ZoteroItemReference
            const items: ZoteroItemReference[] = obj.items
                .map(item => {
                    const itemId = item.result_type === 'attachment'
                        ? (item.attachment_id ?? item.item_id)
                        : item.item_id;
                    if (!itemId) return null;
                    const parts = itemId.split('-');
                    if (parts.length < 2) return null;
                    const libraryId = parseInt(parts[0], 10);
                    const zoteroKey = parts.slice(1).join('-');
                    if (isNaN(libraryId) || !zoteroKey) return null;
                    return { library_id: libraryId, zotero_key: zoteroKey };
                })
                .filter((ref): ref is ZoteroItemReference => ref !== null);
            
            if (items.length > 0) {
                return {
                    items,
                    totalCount: obj.total_count,
                    libraryName: obj.library_name,
                    collectionName: obj.collection_name,
                };
            }
        }
    }
    
    // Fall back to metadata.summary (dehydrated)
    if (metadata?.summary && typeof metadata.summary === 'object') {
        const summary = metadata.summary as ListItemsResultSummary;
        if (Array.isArray(summary.items)) {
            return { 
                items: summary.items.map(item => ({
                    library_id: item.library_id,
                    zotero_key: item.zotero_key,
                })),
                totalCount: summary.total_count,
                libraryName: summary.library_name,
                collectionName: summary.collection_name,
            };
        }
    }
    
    return null;
}

/**
 * Normalized list collections view data.
 * Collections are canonical `CollectionReference`, normalized from the backend
 * wire shape (content's `CollectionInfo` or summary's `BackendCollectionRef`).
 */
export interface ListCollectionsViewData {
    collections: CollectionReference[];
    totalCount: number;
    libraryId?: number | null;
    libraryName?: string | null;
}

/**
 * Parse a compound collection key of the form "<library_id>-<key>"
 * (e.g. "6-ABCD1234") into its parts. Returns null for a plain Zotero key, so
 * callers never pass a compound string to Zotero.Collections.getByLibraryAndKey.
 * Zotero object keys are 8-character uppercase alphanumeric strings.
 */
function parseCompoundCollectionKey(
    collectionKey: string
): { library_id: number; zotero_key: string } | null {
    const match = collectionKey.match(/^(\d+)-([A-Z0-9]{8})$/);
    if (!match) return null;
    return { library_id: parseInt(match[1], 10), zotero_key: match[2] };
}

/**
 * Normalize a backend collection ref into a canonical `CollectionReference`.
 *
 * The library scope is resolved, in priority order, from:
 *   1. a compound `collection_key` ("<library_id>-<key>") — authoritative,
 *      since the library is bound to the key;
 *   2. an explicit per-collection `library_id`;
 *   3. the container `library_id`.
 *
 * When a compound key disagrees with an explicit/container `library_id`, the
 * compound value wins (the mismatch is logged). Returns null when no library
 * scope can be determined, so the caller can drop the collection defensively.
 */
function normalizeBackendCollection(
    coll: BackendCollectionRef,
    containerLibraryId: number | null | undefined
): CollectionReference | null {
    const compound = parseCompoundCollectionKey(coll.collection_key);
    const zoteroKey = compound ? compound.zotero_key : coll.collection_key;

    let libraryId: number | null = null;
    if (compound) {
        libraryId = compound.library_id;
        const provided = coll.library_id ?? containerLibraryId;
        if (provided != null && provided !== compound.library_id) {
            logger(`normalizeBackendCollection: collection_key "${coll.collection_key}" embeds library ${compound.library_id} but library ${provided} was also provided; using ${compound.library_id}`, 1);
        }
    } else if (coll.library_id != null) {
        libraryId = coll.library_id;
    } else if (containerLibraryId != null) {
        libraryId = containerLibraryId;
    }

    if (libraryId == null) return null;

    return {
        library_id: libraryId,
        zotero_key: zoteroKey,
        name: coll.name,
        parent_key: coll.parent_key ?? null,
    };
}

/**
 * Normalize a backend collection list. Drops collections whose library scope
 * cannot be resolved. Returns null when there were collections to show but none
 * could be normalized, so the caller falls back to generic rendering instead of
 * a misleading "No collections found".
 */
function normalizeCollections(
    rawCollections: BackendCollectionRef[],
    containerLibraryId: number | null | undefined
): CollectionReference[] | null {
    const collections = rawCollections
        .map(coll => normalizeBackendCollection(coll, containerLibraryId))
        .filter((c): c is CollectionReference => c !== null);
    if (rawCollections.length > 0 && collections.length === 0) return null;
    return collections;
}

/**
 * A backend list_collections payload that carries an `error`/`error_code` is a
 * failure response, not a renderable result — even when it includes an empty
 * `collections` array (which list_collections error responses always do).
 */
function isListCollectionsError(obj: { error?: unknown; error_code?: unknown }): boolean {
    return obj.error != null || obj.error_code != null;
}

/**
 * Extract list collections data from content or metadata.summary.
 *
 * Normalizes backend collection refs into canonical `CollectionReference` via
 * `normalizeCollections`, resolving each collection's library scope from a
 * compound key, a per-collection `library_id`, or the result container.
 *
 * Returns null — so `ToolResultView` falls back to generic/error rendering —
 * when the payload is an error response, when collections were present but none
 * could be resolved to a library scope, or when an empty result lacks library
 * scope. An empty `collections` array only renders the "No collections found"
 * state when it is a genuine successful empty result (i.e. carries a container
 * `library_id`); a scopeless empty array is an error/non-result payload.
 */
export function extractListCollectionsData(
    content: unknown,
    metadata?: Record<string, unknown>
): ListCollectionsViewData | null {
    // Try content first (non-dehydrated)
    if (content && typeof content === 'object') {
        const obj = content as ListCollectionsResultContent;
        if (Array.isArray(obj.collections) && !isListCollectionsError(obj)) {
            const collections = normalizeCollections(obj.collections, obj.library_id);
            if (collections == null || (collections.length === 0 && obj.library_id == null)) {
                return null;
            }
            return {
                collections,
                totalCount: obj.total_count,
                libraryId: obj.library_id,
                libraryName: obj.library_name,
            };
        }
    }

    // Fall back to metadata.summary (dehydrated)
    if (metadata?.summary && typeof metadata.summary === 'object') {
        const summary = metadata.summary as ListCollectionsResultSummary;
        if (Array.isArray(summary.collections) && !isListCollectionsError(summary)) {
            const collections = normalizeCollections(summary.collections, summary.library_id);
            if (collections == null || (collections.length === 0 && summary.library_id == null)) {
                return null;
            }
            return {
                collections,
                totalCount: summary.total_count,
                libraryId: summary.library_id,
                libraryName: summary.library_name,
            };
        }
    }

    return null;
}

/**
 * Normalized list tags view data.
 * Uses TagReference (name, item_count) which is available in both content and summary.
 */
export interface ListTagsViewData {
    tags: TagReference[];
    totalCount: number;
    libraryId?: number | null;
    libraryName?: string | null;
}

/**
 * Extract list tags data from content or metadata.summary.
 * Uses metadata.summary (which contains TagReference[]) for dehydrated results.
 */
export function extractListTagsData(
    content: unknown,
    metadata?: Record<string, unknown>
): ListTagsViewData | null {
    // Try content first (non-dehydrated)
    if (content && typeof content === 'object') {
        const obj = content as ListTagsResultContent;
        if (Array.isArray(obj.tags) && obj.tags.length > 0) {
            // Convert TagInfo to TagReference (carry name + per-type counts)
            const tags: TagReference[] = obj.tags.map(tag => ({
                name: tag.name,
                item_count: tag.item_count,
                attachment_count: tag.attachment_count,
                note_count: tag.note_count,
                annotation_count: tag.annotation_count,
            }));

            return {
                tags,
                totalCount: obj.total_count,
                libraryId: obj.library_id,
                libraryName: obj.library_name,
            };
        }
    }

    // Fall back to metadata.summary (dehydrated)
    if (metadata?.summary && typeof metadata.summary === 'object') {
        const summary = metadata.summary as ListTagsResultSummary;
        if (Array.isArray(summary.tags)) {
            return {
                tags: summary.tags.map(tag => ({
                    name: tag.name,
                    item_count: tag.item_count,
                    attachment_count: tag.attachment_count,
                    note_count: tag.note_count,
                    annotation_count: tag.annotation_count,
                })),
                totalCount: summary.total_count,
                libraryId: summary.library_id,
                libraryName: summary.library_name,
            };
        }
    }
    
    return null;
}

/**
 * Normalized get metadata view data.
 * Uses ZoteroItemReference[] which is available in both content (via item_id) and summary.
 */
export interface GetMetadataViewData {
    items: ZoteroItemReference[];
    notFound: string[];
}

/**
 * Extract get metadata data from content or metadata.summary.
 * Uses metadata.summary (which contains ZoteroItemReference[]) for dehydrated results.
 */
export function extractGetMetadataData(
    content: unknown,
    metadata?: Record<string, unknown>
): GetMetadataViewData | null {
    // Try content first (non-dehydrated)
    if (content && typeof content === 'object') {
        const obj = content as GetMetadataResultContent;
        if (Array.isArray(obj.items) && obj.items.length > 0) {
            // Convert item_ids to ZoteroItemReference
            const items: ZoteroItemReference[] = obj.items
                .map(item => {
                    // Some results carry library_id/zotero_key directly instead of a composite item_id.
                    const libId = (item as Record<string, unknown>)?.library_id;
                    const key = (item as Record<string, unknown>)?.zotero_key;
                    if (typeof libId === 'number' && typeof key === 'string' && key) {
                        return { library_id: libId, zotero_key: key };
                    }
                    if (typeof item?.item_id !== 'string') return null;
                    const parts = item.item_id.split('-');
                    if (parts.length < 2) return null;
                    const libraryId = parseInt(parts[0], 10);
                    const zoteroKey = parts.slice(1).join('-');
                    if (isNaN(libraryId) || !zoteroKey) return null;
                    return { library_id: libraryId, zotero_key: zoteroKey };
                })
                .filter((ref): ref is ZoteroItemReference => ref !== null);
            
            if (items.length > 0) {
                return {
                    items,
                    notFound: obj.not_found ?? [],
                };
            }
        }
    }
    
    // Fall back to metadata.summary (dehydrated)
    if (metadata?.summary && typeof metadata.summary === 'object') {
        const summary = metadata.summary as GetMetadataResultSummary;
        if (Array.isArray(summary.items)) {
            return { 
                items: summary.items.map(item => ({
                    library_id: item.library_id,
                    zotero_key: item.zotero_key,
                })),
                notFound: [], // not_found list is not in summary
            };
        }
    }
    
    return null;
}

// ============================================================================
// Annotation Tool Results
// ============================================================================

/** Valid tool names for annotation results */
const ANNOTATION_TOOL_NAMES = [
    'add_highlight_annotations',
    'add_note_annotations',
    'add_annotations'
] as const;

/**
 * Type guard for annotation tool results.
 * Annotation tools don't return structured data through content/metadata.summary,
 * they create AgentActions that are stored separately.
 */
export function isAnnotationToolResult(toolName: string): boolean {
    return ANNOTATION_TOOL_NAMES.includes(toolName as typeof ANNOTATION_TOOL_NAMES[number]);
}

/**
 * Type guard for highlight annotation tool results.
 */
export function isHighlightAnnotationToolResult(toolName: string): boolean {
    return toolName === 'add_highlight_annotations';
}

/**
 * Type guard for note annotation tool results.
 */
export function isNoteAnnotationToolResult(toolName: string): boolean {
    return toolName === 'add_note_annotations';
}


/**
 * Extract attachment_id from annotation tool call arguments.
 * Returns null if not found or not parseable.
 */
export function extractAnnotationAttachmentId(args: string | Record<string, any> | null): string | null {
    if (!args) return null;

    try {
        const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
        return parsedArgs?.attachment_id ?? null;
    } catch {
        return null;
    }
}

// ============================================================================
// Annotation List Tool Results
// ============================================================================

/** Valid tool names for annotation-list results */
const GET_ANNOTATIONS_TOOL_NAMES: readonly string[] = [
    'get_annotations',
    'find_annotations',
] as const;

/**
 * Dehydrated summary for the get_annotations tool. The backend stores the
 * full tool result in GCS and ships only this summary inline, so the UI
 * renders directly from `metadata.summary` (the result `content` is replaced
 * by a storage_ref placeholder). Annotations are slim ZoteroItemReference
 * entries — the frontend resolves each one locally to read type, color,
 * text, comment, page label, and tags, matching the ItemSearchResultSummary
 * pattern.
 */
export interface GetAnnotationsResultSummary {
    tool_name: 'get_annotations' | 'find_annotations';
    result_count: number;
    total_count: number;
    has_more: boolean;
    annotations: ZoteroItemReference[];
}

/**
 * Type guard for get_annotations tool results. Reads from `metadata.summary`
 * because get_annotations is dehydrated — see `DEHYDRATABLE_TOOLS` on the
 * backend.
 */
export function isGetAnnotationsResult(
    toolName: string,
    _content: unknown,
    metadata?: Record<string, unknown>
): metadata is { summary: GetAnnotationsResultSummary } {
    if (!GET_ANNOTATIONS_TOOL_NAMES.includes(toolName)) return false;
    if (!metadata?.summary || typeof metadata.summary !== 'object') return false;
    const summary = metadata.summary as Record<string, unknown>;
    if (summary.tool_name !== toolName) return false;
    if (!Array.isArray(summary.annotations)) return false;
    return summary.annotations.every((a: unknown) => {
        if (!a || typeof a !== 'object') return false;
        const ref = a as Record<string, unknown>;
        return typeof ref.library_id === 'number' && typeof ref.zotero_key === 'string';
    });
}

/**
 * Normalized view data for the get_annotations result view.
 */
export interface GetAnnotationsViewData {
    annotations: ZoteroItemReference[];
    totalCount: number;
    toolName: 'get_annotations' | 'find_annotations';
}

/**
 * Extract annotation references from metadata.summary.
 */
export function extractGetAnnotationsData(
    _content: unknown,
    metadata?: Record<string, unknown>
): GetAnnotationsViewData | null {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return null;
    const summary = metadata.summary as GetAnnotationsResultSummary;
    if (!Array.isArray(summary.annotations)) return null;

    return {
        annotations: summary.annotations.map(ref => ({
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
        })),
        totalCount: typeof summary.total_count === 'number' ? summary.total_count : summary.annotations.length,
        toolName: summary.tool_name,
    };
}
