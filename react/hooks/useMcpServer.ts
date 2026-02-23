/**
 * Hook to register an MCP (Model Context Protocol) server on Zotero's HTTP server.
 *
 * When the `mcpServerEnabled` preference is true, this hook creates an MCPService,
 * registers all tools, and mounts the /beaver/mcp endpoint.
 * The endpoint speaks JSON-RPC 2.0 (MCP Streamable HTTP transport), so any MCP
 * client (Claude Code, Claude Desktop via mcp-remote, Cursor) can call the tools.
 *
 * Tools: search_by_topic, search_by_metadata, read_attachment, get_item_details,
 *        list_collections, list_tags, list_items
 */

import { useEffect } from 'react';
import { MCPService } from '../../src/services/mcpService';
import {
    handleItemSearchByTopicRequest,
    handleItemSearchByMetadataRequest,
    handleZoteroAttachmentPagesRequest,
    handleGetMetadataRequest,
    handleListCollectionsRequest,
    handleListTagsRequest,
    handleListItemsRequest,
} from '../../src/services/agentDataProvider';
import { logger } from '../../src/utils/logger';
import { getPref } from '../../src/utils/prefs';
import { isAuthenticatedAtom } from '../atoms/auth';
import { store } from '../store';
import type {
    WSItemSearchByTopicRequest,
    WSItemSearchByTopicResponse,
    WSItemSearchByMetadataRequest,
    WSItemSearchByMetadataResponse,
    WSZoteroAttachmentPagesRequest,
    WSZoteroAttachmentPagesResponse,
    WSGetMetadataRequest,
    WSGetMetadataResponse,
    WSListCollectionsRequest,
    WSListCollectionsResponse,
    WSListTagsRequest,
    WSListTagsResponse,
    WSListItemsRequest,
    WSListItemsResponse,
    ItemSearchFrontendResultItem,
} from '../../src/services/agentProtocol';

// =============================================================================
// Tool definitions
// =============================================================================

const SEARCH_BY_TOPIC_TOOL = {
    name: 'search_by_topic',
    description:
        "Search the user's Zotero reference library by research topic using semantic similarity. " +
        'Returns papers whose content is conceptually related to the query, ranked by relevance. ' +
        'Use this to explore what the user has collected on a subject, build literature reviews, or find relevant background reading. ' +
        'Each result includes an item ID and attachment IDs that can be used with `read_attachment` to read full-text content. ' +
        'Only attachments with `status: "available"` can be read.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            topic_query: {
                type: 'string',
                description:
                    'A concise topic phrase (2–8 words) describing the research concept. Use canonical academic terms. ' +
                    'Examples: "gender gap in STEM", "institutions and economic development", "climate-induced migration".',
            },
            author_filter: {
                type: 'array',
                items: { type: 'string' },
                description: 'Author last names to filter results (OR logic). Example: ["Acemoglu", "Robinson"].',
            },
            min_year: {
                type: 'integer',
                description: 'Earliest publication year (inclusive).',
            },
            max_year: {
                type: 'integer',
                description: 'Latest publication year (inclusive).',
            },
            libraries_filter: {
                type: 'array',
                items: { type: 'string' },
                description: 'Library names or IDs to restrict the search scope.',
            },
            tags_filter: {
                type: 'array',
                items: { type: 'string' },
                description: 'Zotero tags to filter results (OR logic).',
            },
            collections_filter: {
                type: 'array',
                items: { type: 'string' },
                description: 'Collection names or keys to filter results (OR logic).',
            },
            limit: {
                type: 'integer',
                description: 'Max results per page (default 5, max 25).',
                default: 5,
            },
            offset: {
                type: 'integer',
                description: 'Results to skip for pagination (default 0).',
                default: 0,
            },
        },
        required: ['topic_query'],
    },
};

const SEARCH_BY_METADATA_TOOL = {
    name: 'search_by_metadata',
    description:
        "Search the user's Zotero reference library by bibliographic metadata: author name, title keywords, " +
        'or publication/journal name. At least one search field must be provided. Use this when you know specific ' +
        'details about the paper(s) you\'re looking for, such as an author name or title fragment. ' +
        'For conceptual/topic-based discovery, use `search_by_topic` instead. ' +
        'Each result includes attachment IDs that can be used with `read_attachment` to read full-text content. ' +
        'Only attachments with `status: "available"` can be read.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            author_query: {
                type: 'string',
                description: 'Author\'s last name to search for (e.g., "Acemoglu").',
            },
            title_query: {
                type: 'string',
                description: 'Keyword or phrase from the title (e.g., "colonial origins").',
            },
            publication_query: {
                type: 'string',
                description: 'Journal or publication name (e.g., "American Economic Review").',
            },
            min_year: {
                type: 'integer',
                description: 'Earliest publication year (inclusive).',
            },
            max_year: {
                type: 'integer',
                description: 'Latest publication year (inclusive).',
            },
            libraries_filter: {
                type: 'array',
                items: { type: 'string' },
                description: 'Library names or IDs to restrict the search scope.',
            },
            tags_filter: {
                type: 'array',
                items: { type: 'string' },
                description: 'Zotero tags to filter results (OR logic).',
            },
            collections_filter: {
                type: 'array',
                items: { type: 'string' },
                description: 'Collection names or keys to filter results (OR logic).',
            },
            limit: {
                type: 'integer',
                description: 'Max results per page (default 5, max 25).',
                default: 5,
            },
            offset: {
                type: 'integer',
                description: 'Results to skip for pagination (default 0).',
                default: 0,
            },
        },
        required: [],
    },
};

const READ_ATTACHMENT_TOOL = {
    name: 'read_attachment',
    description:
        "Read the text content of a PDF attachment from the user's Zotero library. " +
        'Extracts and returns the text from specified pages (or the first 30 pages if no page range is given). ' +
        'The `attachment_id` must be obtained from another tool: use `search_by_topic` or `search_by_metadata` ' +
        '(which include attachment IDs in results), or call `get_item_details` with `include_attachments: true`. ' +
        'For long documents, read progressively by specifying page ranges. ' +
        'Only PDF attachments with `status: "available"` are supported.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            attachment_id: {
                type: 'string',
                description:
                    'The attachment ID in format `<library_id>-<zotero_key>` (e.g., "1-ABC12345"). Obtain this from search results.',
            },
            start_page: {
                type: 'integer',
                description: 'Starting page number (1-indexed). Defaults to page 1.',
            },
            end_page: {
                type: 'integer',
                description: 'Ending page number (inclusive). Defaults to the last page. Maximum 30 pages per request.',
            },
        },
        required: ['attachment_id'],
    },
};

const GET_ITEM_DETAILS_TOOL = {
    name: 'get_item_details',
    description:
        "Get complete bibliographic metadata for specific items in the user's Zotero library. " +
        'Returns all Zotero fields for each item (title, authors, abstract, DOI, journal, volume, issue, pages, date, etc.), ' +
        'along with tags and collection memberships. Use this to get detailed metadata after finding items via search, ' +
        'or to look up specific fields like DOI or abstract. ' +
        'Set `include_attachments` to true to also see which files (PDFs) are attached and their availability status.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            item_ids: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Item IDs in format `<library_id>-<zotero_key>` (e.g., ["1-ABC12345"]). Maximum 25 items.',
            },
            include_attachments: {
                type: 'boolean',
                description: 'Whether to include attachment metadata (filenames, types, availability). Default: false.',
                default: false,
            },
        },
        required: ['item_ids'],
    },
};

const LIST_COLLECTIONS_TOOL = {
    name: 'list_collections',
    description:
        "List collections (folders) in the user's Zotero library to understand how their references are organized. " +
        'Returns collection names, keys, item counts, and subcollection counts. ' +
        'Use the collection keys or names as filters in search tools (`collections_filter`), ' +
        'or set `parent_collection` to explore nested subcollections. ' +
        'Useful for understanding the scope and organization of the library before searching.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            library: {
                type: 'string',
                description: "Library name or ID. Omit to use the user's default library.",
            },
            parent_collection: {
                type: 'string',
                description: 'Collection key to list subcollections within. Omit for top-level collections.',
            },
            include_item_counts: {
                type: 'boolean',
                description: 'Whether to include the number of items in each collection. Default: true.',
                default: true,
            },
            limit: {
                type: 'integer',
                description: 'Max results per page (default 50, max 100).',
                default: 50,
            },
            offset: {
                type: 'integer',
                description: 'Results to skip for pagination (default 0).',
                default: 0,
            },
        },
        required: [],
    },
};

const LIST_TAGS_TOOL = {
    name: 'list_tags',
    description:
        "List tags in the user's Zotero library. " +
        'Tags are user-defined labels attached to references (e.g., "to-read", "methods", "key-paper"). ' +
        'Returns tag names and how many items use each tag. ' +
        'Use this to discover available tags before using them as filters in `search_by_topic` or `search_by_metadata` (`tags_filter`). ' +
        'Set `min_item_count` to filter out rarely-used tags.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            library: {
                type: 'string',
                description: "Library name or ID. Omit to use the user's default library.",
            },
            collection: {
                type: 'string',
                description: 'Collection key to list tags within that collection only.',
            },
            min_item_count: {
                type: 'integer',
                description: 'Minimum number of items a tag must have to be included. Default: 1.',
                default: 1,
            },
            limit: {
                type: 'integer',
                description: 'Max results per page (default 50, max 100).',
                default: 50,
            },
            offset: {
                type: 'integer',
                description: 'Results to skip for pagination (default 0).',
                default: 0,
            },
        },
        required: [],
    },
};

const LIST_ITEMS_TOOL = {
    name: 'list_items',
    description:
        "Browse items in the user's Zotero library, optionally filtered by collection and/or tag. " +
        'Unlike the search tools, this does not require a query — it simply lists items matching the given filters, ' +
        'sorted by the specified field. Use this to enumerate what\'s in a specific collection, find recently added items, ' +
        'or get an overview of items with a particular tag. ' +
        'Filters are cumulative: specifying both collection and tag returns only items matching both criteria. ' +
        'Note: this tool returns lightweight item metadata without attachment IDs. ' +
        'To read an item\'s PDF, first call `get_item_details` with `include_attachments: true` to obtain the attachment ID, ' +
        'then call `read_attachment`.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            library: {
                type: 'string',
                description: "Library name or ID. Omit to use the user's default library.",
            },
            collection: {
                type: 'string',
                description: 'Collection name or key to list items from.',
            },
            tag: {
                type: 'string',
                description: 'Tag to filter items by.',
            },
            recursive: {
                type: 'boolean',
                description: 'Include items from subcollections. Default: true.',
                default: true,
            },
            sort_by: {
                type: 'string',
                description:
                    'Sort field: "dateAdded", "dateModified", "title", "creator", or "year". Default: "dateModified".',
                default: 'dateModified',
            },
            sort_order: {
                type: 'string',
                description: '"asc" or "desc". Default: "desc".',
                default: 'desc',
            },
            limit: {
                type: 'integer',
                description: 'Max results per page (default 20, max 100).',
                default: 20,
            },
            offset: {
                type: 'integer',
                description: 'Results to skip for pagination (default 0).',
                default: 0,
            },
        },
        required: [],
    },
};

// =============================================================================
// Utilities
// =============================================================================

function generateRequestId(): string {
    if (typeof Zotero !== 'undefined' && Zotero.Utilities?.randomString) {
        return Zotero.Utilities.randomString(16);
    }
    return `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}

function parseItemId(itemId: string): { libraryId: number; key: string } | null {
    const dashIndex = itemId.indexOf('-');
    if (dashIndex === -1) return null;
    const libraryId = parseInt(itemId.substring(0, dashIndex), 10);
    const key = itemId.substring(dashIndex + 1);
    if (isNaN(libraryId) || !key) return null;
    return { libraryId, key };
}

function mcpError(message: string) {
    return {
        content: [{ type: 'text', text: message }],
        isError: true,
    };
}

// =============================================================================
// Response formatting: search results
// =============================================================================

/**
 * Format authors from serialized ItemData creators into "LastName, LastName & LastName".
 */
function formatAuthors(
    creators?: { first_name?: string | null; last_name?: string | null }[] | null,
): string {
    if (!creators || creators.length === 0) return 'Unknown';
    const names = creators
        .map((c) => c.last_name || c.first_name || null)
        .filter((n): n is string => n !== null);
    if (names.length === 0) return 'Unknown';
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} & ${names[1]}`;
    return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/**
 * Normalize tags from various formats to a string array.
 */
function normalizeTags(tags: any[] | null | undefined): string[] {
    if (!tags || tags.length === 0) return [];
    return tags
        .map((t: any) => (typeof t === 'string' ? t : t.tag ?? t.name ?? ''))
        .filter(Boolean);
}

/**
 * Transform an ItemSearchFrontendResultItem to the compact MCP search result format.
 */
function formatSearchResultItem(entry: ItemSearchFrontendResultItem, includeSimilarity: boolean): any {
    const item = entry.item;
    const result: any = {
        item_id: `${item.library_id}-${item.zotero_key}`,
        item_type: item.item_type,
        title: item.title ?? 'Untitled',
        authors: formatAuthors(item.creators),
        year: item.year ?? null,
        publication: item.publication_title ?? null,
    };

    if (includeSimilarity && entry.similarity != null) {
        result.similarity = Math.round(entry.similarity * 100) / 100;
    }

    // Abstract truncated to ~300 chars
    if (item.abstract) {
        result.abstract = item.abstract.length > 300
            ? item.abstract.slice(0, 300) + '...'
            : item.abstract;
    }

    const tags = normalizeTags(item.tags);
    if (tags.length > 0) result.tags = tags;

    // Compact attachment format
    if (entry.attachments && entry.attachments.length > 0) {
        result.attachments = entry.attachments.map((a) => ({
            attachment_id: `${a.attachment.library_id}-${a.attachment.zotero_key}`,
            filename: a.attachment.filename || null,
            page_count: a.file_status?.page_count ?? null,
            status: a.file_status?.status ?? 'unavailable',
        }));
    }

    return result;
}

// =============================================================================
// Tool handlers
// =============================================================================

async function handleSearchByTopic(args: any): Promise<any> {
    const limit = Math.min(Math.max(1, args.limit ?? 5), 25);
    const offset = Math.max(0, args.offset ?? 0);

    const wsRequest: WSItemSearchByTopicRequest = {
        event: 'item_search_by_topic_request',
        request_id: generateRequestId(),
        topic_query: args.topic_query,
        author_filter: args.author_filter,
        year_min: args.min_year,
        year_max: args.max_year,
        libraries_filter: args.libraries_filter,
        tags_filter: args.tags_filter,
        collections_filter: args.collections_filter,
        limit: limit + 1,
        offset,
    };

    const response: WSItemSearchByTopicResponse = await handleItemSearchByTopicRequest(wsRequest);

    if (response.error) {
        return mcpError(`Search failed: ${response.error}`);
    }

    const hasMore = response.items.length > limit;
    const items = hasMore ? response.items.slice(0, limit) : response.items;

    return {
        has_more: hasMore,
        next_offset: hasMore ? offset + limit : null,
        results: items.map((item) => formatSearchResultItem(item, true)),
    };
}

async function handleSearchByMetadata(args: any): Promise<any> {
    const hasQuery = !!args.author_query || !!args.title_query || !!args.publication_query;
    if (!hasQuery) {
        return mcpError(
            'At least one search field must be provided: author_query, title_query, or publication_query.',
        );
    }

    const limit = Math.min(Math.max(1, args.limit ?? 5), 25);
    const offset = Math.max(0, args.offset ?? 0);

    const wsRequest: WSItemSearchByMetadataRequest = {
        event: 'item_search_by_metadata_request',
        request_id: generateRequestId(),
        title_query: args.title_query,
        author_query: args.author_query,
        publication_query: args.publication_query,
        year_min: args.min_year,
        year_max: args.max_year,
        libraries_filter: args.libraries_filter,
        tags_filter: args.tags_filter,
        collections_filter: args.collections_filter,
        limit: limit + 1,
        offset,
    };

    const response: WSItemSearchByMetadataResponse = await handleItemSearchByMetadataRequest(wsRequest);

    if (response.error) {
        return mcpError(`Search failed: ${response.error}`);
    }

    const hasMore = response.items.length > limit;
    const items = hasMore ? response.items.slice(0, limit) : response.items;

    return {
        has_more: hasMore,
        next_offset: hasMore ? offset + limit : null,
        results: items.map((item) => formatSearchResultItem(item, false)),
    };
}

async function handleReadAttachment(args: any): Promise<any> {
    const MAX_PAGES = 30;

    const parsed = parseItemId(args.attachment_id);
    if (!parsed) {
        return mcpError(
            `Invalid attachment_id format: "${args.attachment_id}". Expected format: <library_id>-<zotero_key> (e.g., "1-ABC12345").`,
        );
    }

    const startPage = args.start_page ?? 1;
    const endPage = args.end_page != null
        ? Math.min(args.end_page, startPage + MAX_PAGES - 1)
        : startPage + MAX_PAGES - 1;

    const wsRequest: WSZoteroAttachmentPagesRequest = {
        event: 'zotero_attachment_pages_request',
        request_id: generateRequestId(),
        attachment: { library_id: parsed.libraryId, zotero_key: parsed.key },
        start_page: startPage,
        end_page: endPage,
    };

    let response: WSZoteroAttachmentPagesResponse = await handleZoteroAttachmentPagesRequest(wsRequest);

    // If our defaulted end_page exceeds the document length, retry with the actual total
    if (response.error_code === 'page_out_of_range' && response.total_pages != null && args.end_page == null) {
        wsRequest.end_page = Math.min(response.total_pages, startPage + MAX_PAGES - 1);
        wsRequest.request_id = generateRequestId();
        response = await handleZoteroAttachmentPagesRequest(wsRequest);
    }

    if (response.error) {
        return mcpError(response.error);
    }

    // Build plain text response with <pageN> tags
    const actualEnd = response.pages.length > 0
        ? response.pages[response.pages.length - 1].page_number
        : startPage;
    const header = `Attachment: ${args.attachment_id} | Total pages: ${response.total_pages ?? 'unknown'} | Showing pages ${startPage}-${actualEnd}`;
    const pageTexts = response.pages.map(
        (p) => `<page${p.page_number}>\n${p.content}\n</page${p.page_number}>`,
    );

    return [header, '', ...pageTexts].join('\n');
}

async function handleGetItemDetails(args: any): Promise<any> {
    const itemIds: string[] = args.item_ids;
    if (!itemIds || itemIds.length === 0) {
        return mcpError('item_ids must be a non-empty array.');
    }
    if (itemIds.length > 25) {
        return mcpError(`Too many items requested (${itemIds.length}). Maximum is 25.`);
    }

    const wsRequest: WSGetMetadataRequest = {
        event: 'get_metadata_request',
        request_id: generateRequestId(),
        item_ids: itemIds,
        include_attachments: args.include_attachments ?? false,
        include_notes: false,
    };

    const response: WSGetMetadataResponse = await handleGetMetadataRequest(wsRequest);

    if (response.error) {
        return mcpError(`Failed to get item details: ${response.error}`);
    }

    // Transform attachment data to match the MCP format when present
    const items = response.items.map((item) => {
        if (item.attachments && Array.isArray(item.attachments)) {
            item.attachments = item.attachments.map((a: any) => ({
                attachment_id: a.attachment_id,
                filename: a.filename || null,
                content_type: a.contentType || null,
                page_count: null,
                status: a.path ? 'available' : 'unavailable',
            }));
        }
        // Remove internal fields not useful for MCP consumers
        delete item.item_metadata_hash;
        delete item.zotero_version;
        delete item.zotero_synced;
        delete item.item_json;
        return item;
    });

    return {
        items,
        not_found: response.not_found,
    };
}

async function handleListCollections(args: any): Promise<any> {
    const limit = Math.min(Math.max(1, args.limit ?? 50), 100);
    const offset = Math.max(0, args.offset ?? 0);

    // Parse library parameter — can be a name or ID string
    let libraryId: number | string | null = null;
    if (args.library != null) {
        const parsed = parseInt(args.library, 10);
        libraryId = isNaN(parsed) ? args.library : parsed;
    }

    const wsRequest: WSListCollectionsRequest = {
        event: 'list_collections_request',
        request_id: generateRequestId(),
        library_id: libraryId,
        parent_collection_key: args.parent_collection ?? null,
        include_item_counts: args.include_item_counts ?? true,
        limit,
        offset,
    };

    const response: WSListCollectionsResponse = await handleListCollectionsRequest(wsRequest);

    if (response.error) {
        return mcpError(`Failed to list collections: ${response.error}`);
    }

    const hasMore = offset + limit < response.total_count;

    return {
        total_count: response.total_count,
        has_more: hasMore,
        next_offset: hasMore ? offset + limit : null,
        collections: response.collections.map((c) => ({
            collection_key: c.collection_key,
            name: c.name,
            item_count: c.item_count,
            subcollection_count: c.subcollection_count,
        })),
    };
}

async function handleListTags(args: any): Promise<any> {
    const limit = Math.min(Math.max(1, args.limit ?? 50), 100);
    const offset = Math.max(0, args.offset ?? 0);

    let libraryId: number | string | null = null;
    if (args.library != null) {
        const parsed = parseInt(args.library, 10);
        libraryId = isNaN(parsed) ? args.library : parsed;
    }

    const wsRequest: WSListTagsRequest = {
        event: 'list_tags_request',
        request_id: generateRequestId(),
        library_id: libraryId,
        collection_key: args.collection ?? null,
        min_item_count: args.min_item_count ?? 1,
        limit,
        offset,
    };

    const response: WSListTagsResponse = await handleListTagsRequest(wsRequest);

    if (response.error) {
        return mcpError(`Failed to list tags: ${response.error}`);
    }

    const hasMore = offset + limit < response.total_count;

    return {
        total_count: response.total_count,
        has_more: hasMore,
        next_offset: hasMore ? offset + limit : null,
        tags: response.tags.map((t) => {
            const tag: any = { name: t.name, item_count: t.item_count };
            if (t.color) tag.color = t.color;
            return tag;
        }),
    };
}

async function handleListItems(args: any): Promise<any> {
    const limit = Math.min(Math.max(1, args.limit ?? 20), 100);
    const offset = Math.max(0, args.offset ?? 0);

    let libraryId: number | string | null = null;
    if (args.library != null) {
        const parsed = parseInt(args.library, 10);
        libraryId = isNaN(parsed) ? args.library : parsed;
    }

    const validSortFields = ['dateAdded', 'dateModified', 'title', 'creator', 'year'];
    const sortBy = validSortFields.includes(args.sort_by) ? args.sort_by : 'dateModified';
    const sortOrder = args.sort_order === 'asc' ? 'asc' : 'desc';

    const wsRequest: WSListItemsRequest = {
        event: 'list_items_request',
        request_id: generateRequestId(),
        library_id: libraryId,
        collection_key: args.collection ?? null,
        tag: args.tag ?? null,
        item_category: 'regular',
        recursive: args.recursive ?? true,
        sort_by: sortBy,
        sort_order: sortOrder,
        limit,
        offset,
    };

    const response: WSListItemsResponse = await handleListItemsRequest(wsRequest);

    if (response.error) {
        return mcpError(`Failed to list items: ${response.error}`);
    }

    const hasMore = offset + limit < response.total_count;

    return {
        total_count: response.total_count,
        has_more: hasMore,
        next_offset: hasMore ? offset + limit : null,
        items: response.items.map((item) => ({
            item_id: item.item_id,
            item_type: item.item_type,
            title: item.title ?? null,
            authors: item.creators ?? null,
            year: item.year ?? null,
            date_added: item.date_added ?? null,
            date_modified: item.date_modified ?? null,
        })),
    };
}

// =============================================================================
// Hook
// =============================================================================

export function useMcpServer() {
    useEffect(() => {
        const enabled = getPref('mcpServerEnabled');
        if (!enabled) {
            return;
        }

        logger('useMcpServer: MCP server enabled, registering endpoint', 3);

        const service = new MCPService();
        service.setAuthCheck(() => store.get(isAuthenticatedAtom));

        const tools = [
            { def: SEARCH_BY_TOPIC_TOOL, handler: handleSearchByTopic },
            { def: SEARCH_BY_METADATA_TOOL, handler: handleSearchByMetadata },
            { def: READ_ATTACHMENT_TOOL, handler: handleReadAttachment },
            { def: GET_ITEM_DETAILS_TOOL, handler: handleGetItemDetails },
            { def: LIST_COLLECTIONS_TOOL, handler: handleListCollections },
            { def: LIST_TAGS_TOOL, handler: handleListTags },
            { def: LIST_ITEMS_TOOL, handler: handleListItems },
        ];

        for (const { def, handler } of tools) {
            service.registerTool(def.name, def, handler);
        }

        const registered = service.register();

        return () => {
            if (registered) {
                logger('useMcpServer: Cleaning up MCP endpoint', 3);
                service.unregister();
            }
        };
    }, []);
}
