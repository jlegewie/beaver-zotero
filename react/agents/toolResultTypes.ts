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
    /** Attachment id in format '<library_id>-<zotero_key>' */
    attachment_id: string;
    /** Page number of the chunk */
    page?: number;
}

// ============================================================================
// Fulltext Search Results
// ============================================================================

/**
 * Result from fulltext search tools (search_fulltext, search_fulltext_keywords, read_passages).
 */
export interface FulltextSearchResult {
    tool_name: "search_fulltext" | "search_fulltext_keywords" | "read_passages";
    total_chunks: number;
    total_attachments: number;
    total_items: number;
    chunks: ChunkResultDehydrated[];
    params?: Record<string, unknown>;
}

/**
 * Result from read_fulltext tool.
 */
export interface FulltextRetrievalResult {
    tool_name: "read_fulltext";
    attachment: AttachmentResultDehydrated;
    chunks: ChunkResultDehydrated[];
    params?: Record<string, unknown>;
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

export function isFulltextSearchResult(content: unknown): content is FulltextSearchResult {
    if (!content || typeof content !== 'object') return false;
    const obj = content as Record<string, unknown>;
    return (
        (obj.tool_name === 'search_fulltext' ||
         obj.tool_name === 'search_fulltext_keywords' ||
         obj.tool_name === 'read_passages') &&
        typeof obj.total_chunks === 'number' &&
        Array.isArray(obj.chunks)
    );
}

export function isFulltextRetrievalResult(content: unknown): content is FulltextRetrievalResult {
    if (!content || typeof content !== 'object') return false;
    const obj = content as Record<string, unknown>;
    return (
        obj.tool_name === 'read_fulltext' &&
        obj.attachment !== null &&
        typeof obj.attachment === 'object' &&
        Array.isArray(obj.chunks)
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
 * 
 * @param content - The content of the tool result
 * @param metadata - Optional metadata containing storage
 * @returns Normalized data with ZoteroItemReference[] or null if extraction fails
 */
export function extractItemSearchData(
    content: unknown,
    metadata?: Record<string, unknown>
): ItemSearchViewData | null {
    // Prefer storage, fall back to content
    const source = (metadata?.storage || content) as { items?: ItemResultDehydrated[] } | undefined;
    if (!source || !Array.isArray(source.items)) return null;

    const items = source.items
        .map(item => createZoteroItemReference(item.item_id))
        .filter((ref): ref is ZoteroItemReference => ref !== null);

    return { items };
}
