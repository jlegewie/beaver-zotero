import { ToolCallStatus } from './atoms';
import { ToolCallPart } from './types';

/**
 * Get display name from a Zotero item (Author Year format).
 * For attachments, uses the parent item's metadata.
 */
function getItemDisplayName(item: Zotero.Item): string {
    // For attachments, get the parent item
    const targetItem = item.isAttachment() ? item.parentItem || item : item;
    
    const firstCreator = targetItem.firstCreator || 'Unknown';
    const year = targetItem.getField('date')?.match(/\d{4}/)?.[0] || '';
    
    return `${firstCreator}${year ? ` ${year}` : ''}`;
}

/**
 * Parse attachment_id format '<library_id>-<zotero_key>' and get the Zotero item.
 */
function getItemFromAttachmentId(attachmentId: string): Zotero.Item | null {
    const [libraryIdStr, zoteroKey] = attachmentId.split('-');
    if (!libraryIdStr || !zoteroKey) return null;
    
    const libraryId = parseInt(libraryIdStr, 10);
    if (isNaN(libraryId)) return null;
    
    return Zotero.Items.getByLibraryAndKey(libraryId, zoteroKey) || null;
}

/**
 * Base labels for tool calls (display names).
 * Maps tool_name to a human-readable base label.
 */
const TOOL_BASE_LABELS: Record<string, string> = {
    // Search tools
    item_search: 'Item search',
    item_search_by_topic: 'Item search',
    item_search_by_metadata: 'Item search',
    fulltext_search: 'Fulltext search',
    fulltext_search_keywords: 'Keyword search',

    // Reading tools
    read_pages: 'Reading',
    search_in_documents: 'Document search',

    // Annotations
    add_highlight_annotations: 'Highlight annotations',
    add_note_annotations: 'Note annotations',

    // External search
    search_external_references: 'Web search',
    create_zotero_item: 'Add item',
    external_search: 'Web search',
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
 * - "Reading: Smith 2020, p. 5-10"
 * 
 * If the tool has a progress message, it takes precedence over the default label.
 */
export function getToolCallLabel(part: ToolCallPart, status: ToolCallStatus): string {
    const toolName = part.tool_name;
    const baseLabel = TOOL_BASE_LABELS[toolName] ?? 'Calling function';
    
    // Progress messages take precedence when present
    if (status === 'in_progress' && part.progress) {
        return `${baseLabel}: ${part.progress}`;
    }
    
    const args = parseArgs(part);

    switch (toolName) {
        // === Fulltext search tools ===
        case 'fulltext_search': {
            const query = args.query_semantic as string | undefined;
            if (query) {
                return `${baseLabel}: "${truncate(query, 40)}"`;
            }
            return baseLabel;
        }

        case 'fulltext_search_keywords': {
            const queries = args.query_primary as string[] | undefined;
            if (queries && queries.length > 0) {
                return `${baseLabel}: "${truncate(queries[0], 40)}"`;
            }
            return baseLabel;
        }

        // === Item search tools ===
        case 'item_search':
        case 'item_search_by_topic': {
            const topic = args.topic_query as string | undefined;
            if (topic) {
                return `${baseLabel}: "${truncate(topic, 40)}"`;
            }
            return baseLabel;
        }

        case 'item_search_by_metadata': {
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
        case 'search_in_documents': {
            const description = args.description as string | undefined;
            const query = args.query as string | undefined;
            const label = description || (query ? truncate(query, 50) : null);
            if (label) {
                return `${baseLabel}: ${label}`;
            }
            return baseLabel;
        }
        
        case 'read_tool_result':
            return 'Reading previous context';

        case 'read_pages': {
            const attachmentId = args.attachment_id as string | undefined;
            const startPage = args.start_page as number | undefined;
            const endPage = args.end_page as number | undefined;

            // Build page range string
            let pageRange = '';
            if (startPage !== undefined && endPage !== undefined) {
                pageRange = startPage === endPage ? `p. ${startPage}` : `p. ${startPage}-${endPage}`;
            } else if (startPage !== undefined) {
                pageRange = `p. ${startPage}+`;
            } else if (endPage !== undefined) {
                pageRange = `p. 1-${endPage}`;
            }

            // Get item display name from attachment_id
            if (attachmentId) {
                const item = getItemFromAttachmentId(attachmentId);
                if (item) {
                    const displayName = getItemDisplayName(item);
                    if (pageRange) {
                        return `${baseLabel}: ${displayName}, ${pageRange}`;
                    }
                    return `${baseLabel}: ${displayName}`;
                }
            }

            // Fallback: just show page range or base label
            if (pageRange) {
                return `${baseLabel}: ${pageRange}`;
            }
            return baseLabel;
        }

        // === External search tools ===
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

