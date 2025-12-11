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
// Search External References Results
// ============================================================================

export interface ExternalReferenceResult extends ExternalReference {
    rank?: number;
    similarity?: number;
}

export interface SearchExternalReferencesResult {
    tool_name: "search_external_references";
    total_available: number;
    returned_count: number;
    count_in_library: number;
    count_not_in_library: number;
    references: ExternalReferenceResult[];
    params: Record<string, unknown>;
    total_cost?: number;
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

export function isSearchExternalReferencesResult(content: unknown): content is SearchExternalReferencesResult {
    if (!content || typeof content !== 'object') return false;
    const obj = content as Record<string, unknown>;
    return (
        obj.tool_name === 'search_external_references' &&
        typeof obj.total_available === 'number' &&
        typeof obj.returned_count === 'number' &&
        Array.isArray(obj.references)
    );
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
