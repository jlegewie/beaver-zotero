/**
 * Types for tool result payloads from the agent.
 * These match the backend pydantic models but may be "dehydrated" versions.
 * 
 * Two data sources:
 * - `content`: Full tool result from LLM response
 * - `metadata.storage`: Dehydrated version for frontend rendering
 * 
 * Both use the same item_id format: '<library_id>-<zotero_key>'
 */

import { ExternalReference } from "../types/externalReferences";
import { ZoteroItemReference, createZoteroItemReference } from "../types/zotero";

// ============================================================================
// Item Search Results (search_references_by_topic, search_references_by_metadata)
// ============================================================================

/**
 * Item result with item_id in format '<library_id>-<zotero_key>'.
 */
export interface ItemResultDehydrated {
    /** Unique Zotero identifier in the form '<library_id>-<zotero_key>' */
    item_id: string;
    /** Rank assigned by the search algorithm (lower is better) */
    rank?: number;
    /** Similarity score from semantic search */
    similarity?: number;
}

/**
 * Dehydrated attachment result from the backend.
 * Contains attachment_id in format '<library_id>-<zotero_key>'.
 */
export interface AttachmentResultDehydrated {
    /** Unique Zotero identifier in the form '<library_id>-<zotero_key>' */
    attachment_id: string;
}

/**
 * Dehydrated chunk result from the backend.
 * Contains attachment_id and optional page number.
 */
export interface ChunkResultDehydrated {
    /** Chunk id in format 'CHUNK_<seq_number + 1>' */
    chunk_id: string;
    /** Attachment id in format '<library_id>-<zotero_key>' */
    attachment_id: string;
    /** Page number of the chunk */
    page?: number;
    /** Rank assigned by the search algorithm (lower is better) */
    rank?: number;
    /** Similarity score from semantic search */
    similarity?: number;
}

// ============================================================================
// External Search Results
// ============================================================================

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

/** Valid tool names for item search results */
const ITEM_SEARCH_TOOL_NAMES = [
    'search_references_by_topic',
    'search_references_by_metadata',
    'search_by_topic',
    'search_by_metadata'
] as const;

/**
 * Check if an item has a valid item_id that can be parsed.
 */
function hasValidItemId(item: unknown): boolean {
    if (!item || typeof item !== 'object') return false;
    const obj = item as Record<string, unknown>;
    return typeof obj.item_id === 'string' && createZoteroItemReference(obj.item_id) !== null;
}

/**
 * Type guard for item search results.
 * Checks if we can render from either metadata.storage or content.
 */
export function isItemSearchResult(
    toolName: string,
    content: unknown,
    metadata?: Record<string, unknown>
): boolean {
    if (!ITEM_SEARCH_TOOL_NAMES.includes(toolName as typeof ITEM_SEARCH_TOOL_NAMES[number])) {
        return false;
    }

    // Try storage first, then content
    const source = (metadata?.storage || content) as Record<string, unknown> | undefined;
    if (!source || typeof source !== 'object') return false;

    return Array.isArray(source.items) && source.items.every(hasValidItemId);
}

/** Valid tool names for fulltext search results */
const FULLTEXT_SEARCH_TOOL_NAMES = [
    'search_fulltext',
    'search_fulltext_keywords',
    'search_library_fulltext',
    'search_library_fulltext_keywords',
    'read_passages',
    'retrieve_passages'
] as const;

/**
 * Check if a chunk has a valid attachment_id that can be parsed.
 */
function hasValidAttachmentId(chunk: unknown): boolean {
    if (!chunk || typeof chunk !== 'object') return false;
    const obj = chunk as Record<string, unknown>;
    return typeof obj.attachment_id === 'string' && createZoteroItemReference(obj.attachment_id) !== null;
}

/**
 * Type guard for fulltext search results.
 * Checks if we can render from either metadata.storage or content.
 */
export function isFulltextSearchResult(
    toolName: string,
    content: unknown,
    metadata?: Record<string, unknown>
): boolean {
    if (!FULLTEXT_SEARCH_TOOL_NAMES.includes(toolName as typeof FULLTEXT_SEARCH_TOOL_NAMES[number])) {
        return false;
    }

    // Try storage first, then content
    const source = (metadata?.storage || content) as Record<string, unknown> | undefined;
    if (!source || typeof source !== 'object') return false;

    return Array.isArray(source.chunks) && source.chunks.every(hasValidAttachmentId);
}

/** Valid tool names for fulltext retrieval results */
const FULLTEXT_RETRIEVAL_TOOL_NAMES = [
    'read_fulltext',
    'retrieve_fulltext'
] as const;

/**
 * Type guard for fulltext retrieval results.
 * Requires attachment_id and chunks array.
 */
export function isFulltextRetrievalResult(
    toolName: string,
    content: unknown,
    metadata?: Record<string, unknown>
): boolean {
    if (!FULLTEXT_RETRIEVAL_TOOL_NAMES.includes(toolName as typeof FULLTEXT_RETRIEVAL_TOOL_NAMES[number])) {
        return false;
    }

    const source = (metadata?.storage || content) as Record<string, unknown> | undefined;
    if (!source || typeof source !== 'object') return false;

    // Require valid attachment_id and chunks array
    return (
        typeof source.attachment_id === 'string' &&
        createZoteroItemReference(source.attachment_id) !== null &&
        Array.isArray(source.chunks)
    );
}

/** Valid tool names for external search results */
const EXTERNAL_SEARCH_TOOL_NAMES = [
    'external_search',
    'search_external_references'
] as const;

/**
 * Check if a reference has a valid external_id.
 */
function hasExternalId(ref: unknown): boolean {
    if (!ref || typeof ref !== 'object') return false;
    const obj = ref as Record<string, unknown>;
    return typeof obj.external_id === 'string';
}

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
    if (!EXTERNAL_SEARCH_TOOL_NAMES.includes(toolName as typeof EXTERNAL_SEARCH_TOOL_NAMES[number])) {
        return false;
    }

    // Validate content has references array with external_id
    if (!content || typeof content !== 'object') return false;
    const contentObj = content as Record<string, unknown>;
    if (!Array.isArray(contentObj.references)) return false;
    if (!contentObj.references.every(hasExternalId)) return false;

    // Validate supplemental_data if present (optional but must be valid if present)
    if (metadata?.supplemental_data != null) {
        if (!Array.isArray(metadata.supplemental_data)) return false;
        // Each supplement should have external_id for matching
        if (!metadata.supplemental_data.every(hasExternalId)) return false;
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
 * Extract normalized item references from either content or metadata.storage.
 * Prefers metadata.storage if available, falls back to content.
 */
export function extractItemSearchData(
    content: unknown,
    metadata?: Record<string, unknown>
): ItemSearchViewData | null {
    const source = (metadata?.storage || content) as { items?: ItemResultDehydrated[] } | undefined;
    if (!source || !Array.isArray(source.items)) return null;

    const items = source.items
        .map(item => createZoteroItemReference(item.item_id))
        .filter((ref): ref is ZoteroItemReference => ref !== null);

    return { items };
}

/**
 * Chunk reference with ZoteroItemReference and optional page.
 */
export interface ChunkReference extends ZoteroItemReference {
    page?: number;
}

/**
 * Normalized fulltext search data at chunk level.
 */
export interface FulltextSearchViewData {
    chunks: ChunkReference[];
}

/**
 * Extract chunk-level data from fulltext search results.
 * Prefers metadata.storage if available, falls back to content.
 */
export function extractFulltextSearchData(
    content: unknown,
    metadata?: Record<string, unknown>
): FulltextSearchViewData | null {
    const source = (metadata?.storage || content) as { chunks?: ChunkResultDehydrated[] } | undefined;
    if (!source || !Array.isArray(source.chunks)) return null;

    const chunks: ChunkReference[] = [];
    for (const chunk of source.chunks) {
        const ref = createZoteroItemReference(chunk.attachment_id);
        if (ref) {
            chunks.push({ ...ref, page: chunk.page });
        }
    }

    return { chunks };
}

/**
 * Normalized fulltext retrieval data - single chunk reference with lowest page.
 */
export interface FulltextRetrievalViewData {
    attachment: ChunkReference;
}

/**
 * Extract attachment reference with lowest page from fulltext retrieval results.
 * Prefers metadata.storage if available, falls back to content.
 */
export function extractFulltextRetrievalData(
    content: unknown,
    metadata?: Record<string, unknown>
): FulltextRetrievalViewData | null {
    const source = (metadata?.storage || content) as { 
        attachment_id?: string;
        chunks?: Array<{ page?: number }>;
    } | undefined;
    if (!source || typeof source.attachment_id !== 'string') return null;

    const ref = createZoteroItemReference(source.attachment_id);
    if (!ref) return null;

    // Find the lowest page number from chunks
    let lowestPage: number | undefined;
    if (Array.isArray(source.chunks)) {
        for (const chunk of source.chunks) {
            if (chunk.page != null && (lowestPage == null || chunk.page < lowestPage)) {
                lowestPage = chunk.page;
            }
        }
    }

    return { attachment: { ...ref, page: lowestPage } };
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
