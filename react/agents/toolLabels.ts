import { ToolCallPart } from './types';

/**
 * Base labels for tool calls (display names).
 * Maps tool_name to a human-readable base label.
 */
const TOOL_BASE_LABELS: Record<string, string> = {
    // New pydantic-ai agent tools
    search_by_metadata: 'Metadata search',
    search_by_topic: 'Item search',
    search_library_fulltext: 'Fulltext search',
    search_library_fulltext_keywords: 'Keyword search',
    retrieve_fulltext: 'Reading',
    retrieve_passages: 'Reading',

    // Legacy tools (for backwards compatibility)
    search_references_by_topic: 'Item search',
    search_references_by_metadata: 'Metadata search',
    search_fulltext: 'Fulltext search',
    search_fulltext_keywords: 'Keyword search',
    read_passages: 'Reading',
    read_fulltext: 'Reading',
    search_attachments_content: 'Document search',
    search_attachments_content_keyword: 'Document search',
    view_page_images: 'View page images',

    // Annotations
    add_highlight_annotations: 'Highlight annotations',
    add_note_annotations: 'Note annotations',

    // External search
    search_external_references: 'Web search',
    create_zotero_item: 'Add item',
    external_search: 'Web search',

    // Obsolete
    rag_search: 'Fulltext search',
};

/**
 * Truncate a string to a maximum length, adding ellipsis if needed.
 */
function truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.slice(0, maxLength) + '...';
}

/**
 * Parse args from ToolCallPart - handles both string and object formats.
 */
function parseArgs(part: ToolCallPart): Record<string, unknown> {
    if (!part.args) return {};
    if (typeof part.args === 'string') {
        try {
            return JSON.parse(part.args);
        } catch {
            return {};
        }
    }
    return part.args as Record<string, unknown>;
}

/**
 * Build year filter label from year_filter object.
 */
function formatYearFilter(yearFilter: unknown): string | null {
    if (!yearFilter || typeof yearFilter !== 'object') return null;
    const filter = yearFilter as { exact?: number; min?: number; max?: number };

    if (filter.exact !== undefined) {
        return `(${filter.exact})`;
    }
    if (filter.min !== undefined && filter.max !== undefined) {
        return `(${filter.min}-${filter.max})`;
    }
    if (filter.min !== undefined) {
        return `(>=${filter.min})`;
    }
    if (filter.max !== undefined) {
        return `(<=${filter.max})`;
    }
    return null;
}

/**
 * Generate a display label for a tool call.
 *
 * Creates human-readable labels like:
 * - "Fulltext search: social capital"
 * - "Metadata search: Smith (2020)"
 * - "Reading: p5-10"
 */
export function getToolCallLabel(part: ToolCallPart): string {
    const toolName = part.tool_name;
    const baseLabel = TOOL_BASE_LABELS[toolName] ?? 'Calling function';
    const args = parseArgs(part);

    switch (toolName) {
        // === Fulltext search tools ===
        case 'search_library_fulltext':
        case 'search_fulltext': {
            const query = args.query_semantic as string | undefined;
            if (query) {
                return `${baseLabel}: "${truncate(query, 40)}"`;
            }
            return baseLabel;
        }

        case 'search_library_fulltext_keywords':
        case 'search_fulltext_keywords': {
            const queries = args.query_primary as string[] | undefined;
            if (queries && queries.length > 0) {
                return `${baseLabel}: "${truncate(queries[0], 40)}"`;
            }
            return baseLabel;
        }

        // === Item search tools ===
        case 'search_by_topic':
        case 'search_references_by_topic': {
            const topic = args.topic_query as string | undefined;
            if (topic) {
                return `${baseLabel}: "${truncate(topic, 40)}"`;
            }
            return baseLabel;
        }

        case 'search_by_metadata':
        case 'search_references_by_metadata': {
            const parts: string[] = [];
            if (args.author_query) parts.push(args.author_query as string);
            if (args.title_query) parts.push(args.title_query as string);
            if (args.publication_query) parts.push(`in ${args.publication_query}`);
            const yearLabel = formatYearFilter(args.year_filter);
            if (yearLabel) parts.push(yearLabel);

            if (parts.length > 0) {
                return `${baseLabel}: ${truncate(parts.join(' '), 50)}`;
            }
            return baseLabel;
        }

        // === Reading tools ===
        case 'retrieve_passages':
        case 'read_passages': {
            const description = args.description as string | undefined;
            const query = args.query as string | undefined;
            const label = description || (query ? truncate(query, 50) : null);
            if (label) {
                return `${baseLabel}: ${label}`;
            }
            return baseLabel;
        }

        case 'retrieve_fulltext':
        case 'read_fulltext': {
            const startPage = args.start_page as number | undefined;
            const endPage = args.end_page as number | undefined;

            if (startPage !== undefined && endPage !== undefined) {
                if (startPage === endPage) {
                    return `${baseLabel}: p${startPage}`;
                }
                return `${baseLabel}: p${startPage}-${endPage}`;
            }
            if (startPage !== undefined) {
                return `${baseLabel}: p${startPage}-`;
            }
            if (endPage !== undefined) {
                return `${baseLabel}: p1-${endPage}`;
            }
            return baseLabel;
        }

        // === Document content search ===
        case 'search_attachments_content': {
            const query = args.search_query as string | undefined;
            if (query) {
                return `${baseLabel}: "${truncate(query, 40)}"`;
            }
            return baseLabel;
        }

        // === External search tools ===
        case 'search_external_references':
        case 'external_search': {
            const searchLabel = args.search_label as string | undefined;
            const query = args.query as string | undefined;
            const label = searchLabel || (query ? truncate(query, 40) : null);
            if (label) {
                return `${baseLabel}: ${label}`;
            }
            return baseLabel;
        }

        // === Tools without dynamic labels ===
        case 'view_page_images':
        case 'add_highlight_annotations':
        case 'add_note_annotations':
        case 'create_zotero_item':
        default:
            return baseLabel;
    }
}

