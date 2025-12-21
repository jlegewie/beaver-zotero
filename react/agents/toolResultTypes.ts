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
 * Fulltext retrieval result summary.
 * Matches ReadPagesToolResultSummary from backend.
 */
export interface ReadPagesToolResultSummary {
    tool_name: string;
    result_count: number;
    chunks: ChunkReference[];
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

/** Valid tool names for chunk-based passage retrieval results */
const SEARCH_IN_DOCUMENTS_TOOL_NAMES: readonly string[] = [
    'search_in_documents',
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
 * Type guard for fulltext retrieval results.
 * Checks if metadata.summary is ReadPagesToolResultSummary.
 */
export function isReadPagesResult(
    toolName: string,
    _content: unknown,
    metadata?: Record<string, unknown>
): metadata is { summary: ReadPagesToolResultSummary } {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return false;
    const summary = metadata.summary as Record<string, unknown>;

    const toolNameIsRetrieval = READ_PAGES_TOOL_NAMES.includes(toolName);
    const toolNameIsOtherKnownChunkTool =
        FULLTEXT_SEARCH_TOOL_NAMES.includes(toolName) ||
        SEARCH_IN_DOCUMENTS_TOOL_NAMES.includes(toolName);
    if (!toolNameIsRetrieval) {
        if (toolNameIsOtherKnownChunkTool) return false;
        const summaryToolName = typeof summary.tool_name === 'string' ? summary.tool_name : null;
        if (!summaryToolName || !READ_PAGES_TOOL_NAMES.includes(summaryToolName)) return false;
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
 * Normalized fulltext retrieval data - single chunk reference with lowest page.
 */
export interface FulltextRetrievalViewData {
    attachment: ChunkReference;
}

/**
 * Extract attachment reference with lowest page from metadata.summary.
 * @returns FulltextRetrievalViewData or null if summary is not available
 */
export function extractReadPagesData(
    _content: unknown,
    metadata?: Record<string, unknown>
): FulltextRetrievalViewData | null {
    if (!metadata?.summary || typeof metadata.summary !== 'object') return null;
    const summary = metadata.summary as ReadPagesToolResultSummary;
    
    if (!Array.isArray(summary.chunks) || summary.chunks.length === 0) return null;

    // Find chunk with lowest page number
    let attachmentChunk = summary.chunks[0];
    
    for (const chunk of summary.chunks) {
        if (chunk.page != null && (attachmentChunk.page == null || chunk.page < attachmentChunk.page)) {
            attachmentChunk = chunk;
        }
    }

    return { attachment: attachmentChunk };
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
 * Supports item search, fulltext search, fulltext retrieval, and passage retrieval results.
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

    // Fulltext retrieval results (single attachment)
    if (isReadPagesResult(tool_name, content, metadata)) {
        const data = extractReadPagesData(content, metadata);
        return data?.attachment ? [data.attachment] : [];
    }

    // Passage retrieval results (chunks)
    if (isSearchInDocumentsResult(tool_name, content, metadata)) {
        const data = extractSearchInDocumentsData(content, metadata);
        return data?.chunks ?? [];
    }

    return [];
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
