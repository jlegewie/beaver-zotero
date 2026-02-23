/**
 * Hook to register an MCP (Model Context Protocol) server on Zotero's HTTP server.
 *
 * When the `mcpServerEnabled` preference is true, this hook creates an MCPService,
 * registers the `item_search_by_topic` tool, and mounts the /beaver/mcp endpoint.
 * The endpoint speaks JSON-RPC 2.0 (MCP Streamable HTTP transport), so any MCP
 * client (Claude Code, Claude Desktop via mcp-remote, Cursor) can call the tools.
 *
 * Follows the same lifecycle pattern as useHttpEndpoints.ts.
 */

import { useEffect } from 'react';
import { MCPService } from '../../src/services/mcpService';
import { handleItemSearchByTopicRequest } from '../../src/services/agentDataProvider';
import { logger } from '../../src/utils/logger';
import { getPref } from '../../src/utils/prefs';
import { isAuthenticatedAtom } from '../atoms/auth';
import { store } from '../store';
import type {
    WSItemSearchByTopicRequest,
    WSItemSearchByTopicResponse,
    ItemSearchFrontendResultItem,
} from '../../src/services/agentProtocol';

// =============================================================================
// Tool definition
// =============================================================================

const ITEM_SEARCH_BY_TOPIC_TOOL = {
    name: 'item_search_by_topic',
    description:
        "Find papers about a research concept using semantic search across the user's Zotero library. " +
        'Use for exploring topics like "institutions and economic development" or "gender gap in STEM". ' +
        'Returns matching references sorted by similarity.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            topic_query: {
                type: 'string',
                description:
                    'A concise topic phrase (2-8 words) naming the core concept. Use canonical academic terms.',
            },
            author_filter: {
                type: 'array',
                items: { type: 'string' },
                description: 'Author last names to filter results (OR logic).',
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
                description: 'Library names or IDs to filter results.',
            },
            tags_filter: {
                type: 'array',
                items: { type: 'string' },
                description: 'Tags to filter results (OR logic).',
            },
            collections_filter: {
                type: 'array',
                items: { type: 'string' },
                description: 'Collection names or keys to filter results.',
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

// =============================================================================
// Response formatting
// =============================================================================

function generateRequestId(): string {
    if (typeof Zotero !== 'undefined' && Zotero.Utilities?.randomString) {
        return Zotero.Utilities.randomString(16);
    }
    return `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}

function formatCreators(
    creators?: { first_name?: string | null; last_name?: string | null }[] | null,
): string {
    if (!creators || creators.length === 0) return 'Unknown';
    return creators
        .map((c) => [c.last_name, c.first_name].filter(Boolean).join(', '))
        .join('; ');
}

function formatSearchResults(response: WSItemSearchByTopicResponse): string {
    if (!response.items || response.items.length === 0) {
        return 'No results found.';
    }

    const lines: string[] = [`Found ${response.items.length} result(s):\n`];

    response.items.forEach((entry: ItemSearchFrontendResultItem, idx: number) => {
        const item = entry.item;
        const num = idx + 1;
        const year = item.year ?? item.date ?? 'n.d.';
        const title = item.title ?? 'Untitled';
        const authors = formatCreators(item.creators);
        const pub = item.publication_title ?? '';
        const similarity =
            entry.similarity != null
                ? `Similarity: ${entry.similarity.toFixed(2)}`
                : '';

        lines.push(`${num}. ${title} (${year})`);
        lines.push(`   Authors: ${authors}`);
        if (pub) lines.push(`   Publication: ${pub}`);
        if (similarity) lines.push(`   ${similarity}`);
        if (item.abstract) {
            // Truncate long abstracts
            const abs =
                item.abstract.length > 300
                    ? item.abstract.slice(0, 300) + '...'
                    : item.abstract;
            lines.push(`   Abstract: ${abs}`);
        }
        if (item.tags && item.tags.length > 0) {
            const tagNames = item.tags
                .map((t: any) => (typeof t === 'string' ? t : t.tag ?? t.name ?? ''))
                .filter(Boolean);
            if (tagNames.length > 0) lines.push(`   Tags: ${tagNames.join(', ')}`);
        }
        lines.push(
            `   Zotero Key: ${item.zotero_key} | Library ID: ${item.library_id}`,
        );

        // Attachment summary
        if (entry.attachments && entry.attachments.length > 0) {
            const pdfCount = entry.attachments.filter(
                (a) => a.attachment.mime_type === 'application/pdf',
            ).length;
            const pages = entry.attachments
                .map((a) => a.file_status?.page_count)
                .filter((p): p is number => p != null)
                .reduce((sum, p) => sum + p, 0);
            const parts: string[] = [];
            if (pdfCount > 0) parts.push(`${pdfCount} PDF${pdfCount > 1 ? 's' : ''}`);
            if (pages > 0) parts.push(`${pages} pages`);
            if (parts.length > 0) lines.push(`   Attachments: ${parts.join(', ')}`);
        }

        lines.push('');
    });

    return lines.join('\n');
}

// =============================================================================
// Tool handler
// =============================================================================

async function handleTopicSearch(args: any): Promise<string> {
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
        limit,
        offset,
    };

    const response = await handleItemSearchByTopicRequest(wsRequest);
    return formatSearchResults(response);
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
        service.registerTool(
            ITEM_SEARCH_BY_TOPIC_TOOL.name,
            ITEM_SEARCH_BY_TOPIC_TOOL,
            handleTopicSearch,
        );
        const registered = service.register();

        return () => {
            if (registered) {
                logger('useMcpServer: Cleaning up MCP endpoint', 3);
                service.unregister();
            }
        };
    }, []);
}
