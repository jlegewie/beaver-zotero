/**
 * Types for tool result payloads from the agent.
 * These match the backend pydantic models but may be "dehydrated" versions.
 */

// ============================================================================
// Item Search Results (search_references_by_topic, search_references_by_metadata)
// ============================================================================

/**
 * Dehydrated item result from the backend.
 * Contains item_id in format '<library_id>-<zotero_key>' which can be parsed
 * using createZoteroItemReference() to get a ZoteroItemReference.
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

/**
 * Result from search_references_by_topic and search_references_by_metadata tools.
 */
export interface ItemSearchResult {
    tool_name: "search_references_by_topic" | "search_references_by_metadata";
    total_items: number;
    items: ItemResultDehydrated[];
    params?: Record<string, unknown>;
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
// Type Guards
// ============================================================================

export function isItemSearchResult(content: unknown): content is ItemSearchResult {
    if (!content || typeof content !== 'object') return false;
    const obj = content as Record<string, unknown>;
    return (
        (obj.tool_name === 'search_references_by_topic' ||
        obj.tool_name === 'search_references_by_metadata' ||
         obj.tool_name === 'search_by_topic' ||
         obj.tool_name === 'search_by_metadata') &&
        typeof obj.total_items === 'number' &&
        Array.isArray(obj.items)
    );
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
