/**
 * Types for tool result payloads from the agent.
 * These match the backend pydantic models.
 * 
 * Data source:
 * - `metadata.summary`: Summary data for frontend rendering (required)
 */

import { ExternalReference } from "../types/externalReferences";
import { ZoteroItemReference } from "../types/zotero";
import { ToolReturnPart } from "./types";

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
 */
export interface ReadPagesFrontendResultSummary {
    tool_name: string;
    result_count: number;
    pages: PageReference[];
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
] as const;

/** Valid tool names for chunk-based fulltext retrieval results */
const VIEW_PAGE_IMAGES_TOOL_NAMES: readonly string[] = [
    'view_page_images',
] as const;

/** Valid tool names for chunk-based passage retrieval results */
const SEARCH_IN_DOCUMENTS_TOOL_NAMES: readonly string[] = [
    'search_in_documents',
] as const;

/** Valid tool names for keyword search in attachment results */
const SEARCH_IN_ATTACHMENT_TOOL_NAMES: readonly string[] = [
    'search_in_attachment',
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
 * Type guard for passage retrieval results.
 * Checks if metadata.summary is SearchInDocumentsToolResultSummary.
 */
export function isSearchInDocumentsResult(
    toolName: string,
    _content: unknown,
    metadata?: Record<string, unknown>
): metadata is { summary: SearchInDocumentsToolResultSummary } {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return false;
    const summary = metadata.summary as Record<string, unknown>;

    const toolNameIsPassageRetrieval = SEARCH_IN_DOCUMENTS_TOOL_NAMES.includes(toolName);
    const toolNameIsOtherKnownChunkTool =
        FULLTEXT_SEARCH_TOOL_NAMES.includes(toolName) ||
        READ_PAGES_TOOL_NAMES.includes(toolName);
    if (!toolNameIsPassageRetrieval) {
        if (toolNameIsOtherKnownChunkTool) return false;
        const summaryToolName = typeof summary.tool_name === 'string' ? summary.tool_name : null;
        if (!summaryToolName || !SEARCH_IN_DOCUMENTS_TOOL_NAMES.includes(summaryToolName)) return false;
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
 * Type guard for search in attachment results (keyword search).
 * Checks if metadata.summary is SearchInAttachmentResultSummary.
 */
export function isSearchInAttachmentResult(
    toolName: string,
    _content: unknown,
    metadata?: Record<string, unknown>
): metadata is { summary: SearchInAttachmentResultSummary } {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return false;
    const summary = metadata.summary as Record<string, unknown>;

    const toolNameIsSearchInAttachment = SEARCH_IN_ATTACHMENT_TOOL_NAMES.includes(toolName);
    if (!toolNameIsSearchInAttachment) {
        const summaryToolName = typeof summary.tool_name === 'string' ? summary.tool_name : null;
        if (!summaryToolName || !SEARCH_IN_ATTACHMENT_TOOL_NAMES.includes(summaryToolName)) return false;
    }
    
    return (
        typeof summary.tool_name === 'string' &&
        typeof summary.total_matches === 'number' &&
        typeof summary.pages_with_matches === 'number' &&
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
 * Type guard for external search results.
 * Checks content has references array with external_id, and optionally
 * metadata.supplemental_data has array with external_id.
 */
export function isExternalSearchResult(
    _toolName: string,
    content: unknown,
    metadata?: Record<string, unknown>
): boolean {
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
 * Normalized passage retrieval data.
 */
export interface PassageRetrievalViewData {
    chunks: ChunkReference[];
}

/**
 * Extract chunk-level data from metadata.summary for passage retrieval.
 * @returns PassageRetrievalViewData or null if summary is not available
 */
export function extractSearchInDocumentsData(
    _content: unknown,
    metadata?: Record<string, unknown>
): PassageRetrievalViewData | null {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return null;
    const summary = metadata.summary as SearchInDocumentsToolResultSummary;
    
    if (!Array.isArray(summary.chunks)) return null;

    return { chunks: summary.chunks };
}

/**
 * Normalized search in attachment data.
 */
export interface SearchInAttachmentViewData {
    pages: PageReference[];
}

/**
 * Extract page-level data from metadata.summary for search in attachment.
 * @returns SearchInAttachmentViewData or null if summary is not available
 */
export function extractSearchInAttachmentData(
    _content: unknown,
    metadata?: Record<string, unknown>
): SearchInAttachmentViewData | null {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return null;
    const summary = metadata.summary as SearchInAttachmentResultSummary;
    
    if (!Array.isArray(summary.pages)) return null;

    const pages: PageReference[] = summary.pages.map(page => ({
        library_id: page.library_id,
        zotero_key: page.zotero_key,
        page_number: page.page_number,
    }));

    return { pages };
}

/**
 * Normalized external search data ready for rendering.
 */
export interface ExternalSearchViewData {
    references: ExternalReference[];
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

    // Build lookup map from supplemental data
    const supplementMap = new Map<string, ExternalReferenceResultSupplement>();
    if (Array.isArray(metadata?.supplemental_data)) {
        for (const supp of metadata.supplemental_data as ExternalReferenceResultSupplement[]) {
            if (supp.external_id) {
                supplementMap.set(supp.external_id, supp);
            }
        }
    }

    // Merge content references with supplements
    const references: ExternalReference[] = contentObj.references.map(ref => {
        const supp = supplementMap.get(ref.external_id);
        
        return {
            // From content
            source_id: ref.external_id,
            title: ref.title,
            authors: supp?.authors ?? ref.authors,
            year: ref.year,
            venue: ref.venue,
            abstract: ref.abstract,
            fields_of_study: ref.fields_of_study,
            citation_count: ref.citation_count,
            
            // From supplement (or defaults)
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

    return { references };
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

    // View page images results
    if (isViewPageImagesResult(tool_name, content, metadata)) {
        const data = extractViewPageImagesData(content, metadata);
        return data?.pages ?? [];
    }

    // Passage retrieval results (chunks)
    if (isSearchInDocumentsResult(tool_name, content, metadata)) {
        const data = extractSearchInDocumentsData(content, metadata);
        return data?.chunks ?? [];
    }

    // Search in attachment results (pages)
    if (isSearchInAttachmentResult(tool_name, content, metadata)) {
        const data = extractSearchInAttachmentData(content, metadata);
        return data?.pages ?? [];
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
 * Collection reference for UI display.
 * Matches CollectionReference from backend.
 */
export interface CollectionReference {
    collection_key: string;
    name: string;
}

/**
 * Tag reference for UI display.
 * Matches TagReference from backend.
 */
export interface TagReference {
    name: string;
    item_count: number;
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
    collections: CollectionReference[];
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
 * Result item from zotero_search.
 * Matches ZoteroSearchResultItem from backend.
 */
export interface ZoteroSearchResultItem {
    item_id: string;
    item_type: string;
    title?: string | null;
    creators?: string | null;
    year?: number | null;
    extra_fields?: Record<string, unknown> | null;
}

/**
 * Result item from list_items.
 * Matches ListItemsResultItem from backend.
 */
export interface ListItemsResultItem {
    item_id: string;
    item_type: string;
    title?: string | null;
    creators?: string | null;
    year?: number | null;
    date_added?: string | null;
    date_modified?: string | null;
}

/**
 * Collection info from list_collections.
 * Matches CollectionInfo from backend.
 */
export interface CollectionInfo {
    collection_key: string;
    name: string;
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
    item_count: number;
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
                    const parts = item.item_id.split('-');
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
 * Uses CollectionReference (collection_key, name) which is available in both content and summary.
 */
export interface ListCollectionsViewData {
    collections: CollectionReference[];
    totalCount: number;
    libraryId?: number | null;
    libraryName?: string | null;
}

/**
 * Extract list collections data from content or metadata.summary.
 * Uses metadata.summary (which contains CollectionReference[]) for dehydrated results.
 */
export function extractListCollectionsData(
    content: unknown,
    metadata?: Record<string, unknown>
): ListCollectionsViewData | null {
    // Try content first (non-dehydrated)
    if (content && typeof content === 'object') {
        const obj = content as ListCollectionsResultContent;
        if (Array.isArray(obj.collections) && obj.collections.length > 0) {
            // Convert CollectionInfo to CollectionReference (keep key and name)
            const collections: CollectionReference[] = obj.collections.map(coll => ({
                collection_key: coll.collection_key,
                name: coll.name,
            }));
            
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
        if (Array.isArray(summary.collections)) {
            return { 
                collections: summary.collections.map(coll => ({
                    collection_key: coll.collection_key,
                    name: coll.name,
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
            // Convert TagInfo to TagReference (keep name and item_count)
            const tags: TagReference[] = obj.tags.map(tag => ({
                name: tag.name,
                item_count: tag.item_count,
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
