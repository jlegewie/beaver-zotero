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
 * Result from search_references_by_topic and search_references_by_metadata tools.
 */
export interface ItemSearchResult {
    tool_name: "search_references_by_topic" | "search_references_by_metadata";
    total_items: number;
    items: ItemResultDehydrated[];
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

// ============================================================================
// Future Tool Result Types
// ============================================================================

// Add other tool result types here as needed:
// - FulltextContentResult
// - ReadAttachmentsResult
// - etc.
