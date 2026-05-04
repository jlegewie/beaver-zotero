/**
 * Unit tests for MCP tool handlers defined in react/hooks/useMcpServer.ts
 *
 * Tests the tool handler logic, response formatting, argument validation,
 * pagination, and error handling for each MCP tool.
 *
 * Strategy: Mock all backend handler functions, then trigger the useMcpServer
 * hook's useEffect to register tools on a real MCPService. We intercept the
 * MCPService via the Zotero.Server.Endpoints mock and call tools via JSON-RPC.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must come before imports (vi.mock is hoisted)
// ---------------------------------------------------------------------------

const mockHandleItemSearchByTopicRequest = vi.fn();
const mockHandleItemSearchByMetadataRequest = vi.fn();
const mockHandleZoteroAttachmentPagesRequest = vi.fn();
const mockHandleGetMetadataRequest = vi.fn();
const mockHandleListCollectionsRequest = vi.fn();
const mockHandleListTagsRequest = vi.fn();
const mockHandleListItemsRequest = vi.fn();

vi.mock('../../../src/services/agentDataProvider', () => ({
    handleItemSearchByTopicRequest: (...args: any[]) => mockHandleItemSearchByTopicRequest(...args),
    handleItemSearchByMetadataRequest: (...args: any[]) => mockHandleItemSearchByMetadataRequest(...args),
    handleZoteroAttachmentPagesRequest: (...args: any[]) => mockHandleZoteroAttachmentPagesRequest(...args),
    handleGetMetadataRequest: (...args: any[]) => mockHandleGetMetadataRequest(...args),
    handleListCollectionsRequest: (...args: any[]) => mockHandleListCollectionsRequest(...args),
    handleListTagsRequest: (...args: any[]) => mockHandleListTagsRequest(...args),
    handleListItemsRequest: (...args: any[]) => mockHandleListItemsRequest(...args),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    getZoteroSelectURI: vi.fn((libraryId: number, key: string) => `zotero://select/library/items/${key}`),
    getCitationKeyFromItem: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

vi.mock('../../../react/atoms/auth', () => ({
    isAuthenticatedAtom: { toString: () => 'isAuthenticatedAtom' },
}));

vi.mock('../../../react/atoms/ui', () => ({
    mcpServerEnabledAtom: { toString: () => 'mcpServerEnabledAtom' },
}));

vi.mock('../../../react/store', () => ({
    store: { get: vi.fn().mockReturnValue(true), set: vi.fn(), sub: vi.fn() },
}));

// Capture the useEffect callback so we can call it manually
let capturedEffect: (() => (() => void) | void) | null = null;

vi.mock('react', () => ({
    useEffect: vi.fn((cb: any) => { capturedEffect = cb; }),
    useState: vi.fn(() => [null, vi.fn()]),
}));

vi.mock('jotai', () => ({
    useAtomValue: vi.fn(() => true), // MCP enabled
}));

// ---------------------------------------------------------------------------
// Zotero globals
// ---------------------------------------------------------------------------

const zotero = (globalThis as any).Zotero;

beforeEach(() => {
    zotero.Utilities = { randomString: vi.fn(() => 'test-request-id') };
    zotero.DataDirectory = { dir: '/mock/data' };
    zotero.Server = { Endpoints: {} };
    zotero.Items = { getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(null) };
    zotero.Libraries = { get: vi.fn(() => ({ libraryType: 'user' })) };
});

// ---------------------------------------------------------------------------
// Import useMcpServer — mocks are already wired
// ---------------------------------------------------------------------------

import { useMcpServer, getMcpBridgeScriptPath, ensureMcpBridgeScript } from '../../../react/hooks/useMcpServer';

// ---------------------------------------------------------------------------
// Helper: set up the MCP endpoint by triggering the hook's useEffect
// ---------------------------------------------------------------------------

type Endpoint = { init: (data: any) => Promise<[number, string, string]> };

function setupMcpEndpoint(): Endpoint {
    capturedEffect = null;

    // Call the hook — this triggers our mock useEffect, capturing the callback
    useMcpServer();

    if (!capturedEffect) {
        throw new Error('useEffect callback was not captured');
    }

    // Execute the effect — registers the MCP endpoint on Zotero.Server.Endpoints
    capturedEffect();

    const EndpointCtor = zotero.Server.Endpoints['/beaver/mcp'];
    if (!EndpointCtor) {
        throw new Error('/beaver/mcp endpoint was not registered');
    }

    return new EndpointCtor();
}

/** Send a tools/call JSON-RPC request and return the parsed result. */
async function callTool(endpoint: Endpoint, toolName: string, args: any = {}) {
    const [, , body] = await endpoint.init({
        method: 'POST',
        pathname: '/beaver/mcp',
        pathParams: {},
        searchParams: new URLSearchParams(),
        headers: new Headers(),
        data: {
            jsonrpc: '2.0',
            method: 'tools/call',
            params: { name: toolName, arguments: args },
            id: 1,
        },
    });
    const parsed = JSON.parse(body);
    return parsed.result ?? { _error: parsed.error };
}

/** Send a tools/list request. */
async function listTools(endpoint: Endpoint) {
    const [, , body] = await endpoint.init({
        method: 'POST',
        pathname: '/beaver/mcp',
        pathParams: {},
        searchParams: new URLSearchParams(),
        headers: new Headers(),
        data: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });
    return JSON.parse(body).result;
}

// ---------------------------------------------------------------------------
// Helpers for test data
// ---------------------------------------------------------------------------

function makeSearchResultItem(overrides: any = {}) {
    return {
        item: {
            library_id: 1,
            zotero_key: 'ABC12345',
            item_type: 'journalArticle',
            title: 'Test Paper',
            creators: [{ first_name: 'John', last_name: 'Smith' }],
            year: 2023,
            publication_title: 'Test Journal',
            abstract: 'A test abstract for a paper.',
            citation_key: 'smith2023',
            tags: [{ tag: 'methods' }, { tag: 'review' }],
            ...overrides.item,
        },
        attachments: overrides.attachments ?? [{
            attachment: {
                library_id: 1,
                zotero_key: 'ATT00001',
                filename: 'paper.pdf',
            },
            file_status: {
                status: 'available',
                page_count: 25,
            },
        }],
        similarity: overrides.similarity ?? 0.95,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP Tool Handlers (via useMcpServer)', () => {
    let endpoint: Endpoint;

    beforeEach(() => {
        vi.clearAllMocks();
        // Re-setup Zotero globals
        zotero.Utilities = { randomString: vi.fn(() => 'test-request-id') };
        zotero.Server = { Endpoints: {} };
        zotero.Items = { getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(null) };
        zotero.Libraries = { get: vi.fn(() => ({ libraryType: 'user' })) };

        endpoint = setupMcpEndpoint();
    });

    // =====================================================================
    // Tool registration
    // =====================================================================

    describe('tool registration', () => {
        it('registers all 7 tools', async () => {
            const result = await listTools(endpoint);
            const names = result.tools.map((t: any) => t.name);

            expect(names).toContain('search_by_topic');
            expect(names).toContain('search_by_metadata');
            expect(names).toContain('read_attachment');
            expect(names).toContain('get_item_details');
            expect(names).toContain('list_collections');
            expect(names).toContain('list_tags');
            expect(names).toContain('list_items');
            expect(result.tools).toHaveLength(7);
        });

        it('each tool has name, description, and inputSchema', async () => {
            const result = await listTools(endpoint);

            for (const tool of result.tools) {
                expect(tool.name).toBeTypeOf('string');
                expect(tool.description).toBeTypeOf('string');
                expect(tool.description.length).toBeGreaterThan(20);
                expect(tool.inputSchema).toBeDefined();
                expect(tool.inputSchema.type).toBe('object');
            }
        });
    });

    // =====================================================================
    // search_by_topic
    // =====================================================================

    describe('search_by_topic', () => {
        it('passes topic_query to handler', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [],
            });

            await callTool(endpoint, 'search_by_topic', { topic_query: 'machine learning' });

            expect(mockHandleItemSearchByTopicRequest).toHaveBeenCalledOnce();
            const req = mockHandleItemSearchByTopicRequest.mock.calls[0][0];
            expect(req.topic_query).toBe('machine learning');
            expect(req.event).toBe('item_search_by_topic_request');
        });

        it('passes author_filter to handler', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [],
            });

            await callTool(endpoint, 'search_by_topic', {
                topic_query: 'NLP',
                author_filter: ['Smith', 'Jones'],
            });

            const req = mockHandleItemSearchByTopicRequest.mock.calls[0][0];
            expect(req.author_filter).toEqual(['Smith', 'Jones']);
        });

        it('passes min_year and max_year as year_min and year_max', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [],
            });

            await callTool(endpoint, 'search_by_topic', {
                topic_query: 'economics',
                min_year: 2020,
                max_year: 2024,
            });

            const req = mockHandleItemSearchByTopicRequest.mock.calls[0][0];
            expect(req.year_min).toBe(2020);
            expect(req.year_max).toBe(2024);
        });

        it('passes libraries_filter', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [],
            });

            await callTool(endpoint, 'search_by_topic', {
                topic_query: 'test',
                libraries_filter: ['My Library'],
            });

            const req = mockHandleItemSearchByTopicRequest.mock.calls[0][0];
            expect(req.libraries_filter).toEqual(['My Library']);
        });

        it('passes tags_filter', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [],
            });

            await callTool(endpoint, 'search_by_topic', {
                topic_query: 'test',
                tags_filter: ['important', 'review'],
            });

            const req = mockHandleItemSearchByTopicRequest.mock.calls[0][0];
            expect(req.tags_filter).toEqual(['important', 'review']);
        });

        it('passes collections_filter', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [],
            });

            await callTool(endpoint, 'search_by_topic', {
                topic_query: 'test',
                collections_filter: ['COLL001'],
            });

            const req = mockHandleItemSearchByTopicRequest.mock.calls[0][0];
            expect(req.collections_filter).toEqual(['COLL001']);
        });

        it('defaults limit to 5 and requests limit+1 for pagination', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [],
            });

            await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });

            const req = mockHandleItemSearchByTopicRequest.mock.calls[0][0];
            expect(req.limit).toBe(6); // 5 + 1
            expect(req.offset).toBe(0);
        });

        it('respects custom limit and offset', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [],
            });

            await callTool(endpoint, 'search_by_topic', {
                topic_query: 'test',
                limit: 10,
                offset: 20,
            });

            const req = mockHandleItemSearchByTopicRequest.mock.calls[0][0];
            expect(req.limit).toBe(11); // 10 + 1
            expect(req.offset).toBe(20);
        });

        it('caps limit at 25', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [],
            });

            await callTool(endpoint, 'search_by_topic', {
                topic_query: 'test',
                limit: 100,
            });

            const req = mockHandleItemSearchByTopicRequest.mock.calls[0][0];
            expect(req.limit).toBe(26); // min(100, 25) + 1
        });

        it('enforces minimum limit of 1', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [],
            });

            await callTool(endpoint, 'search_by_topic', {
                topic_query: 'test',
                limit: -5,
            });

            const req = mockHandleItemSearchByTopicRequest.mock.calls[0][0];
            expect(req.limit).toBe(2); // max(1, -5) = 1, then +1 = 2
        });

        it('enforces minimum offset of 0', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [],
            });

            await callTool(endpoint, 'search_by_topic', {
                topic_query: 'test',
                offset: -10,
            });

            const req = mockHandleItemSearchByTopicRequest.mock.calls[0][0];
            expect(req.offset).toBe(0);
        });

        it('returns formatted results with similarity', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [makeSearchResultItem({ similarity: 0.876 })],
            });

            const result = await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });
            const data = JSON.parse(result.content[0].text);

            expect(data.results).toHaveLength(1);
            expect(data.results[0].item_id).toBe('1-ABC12345');
            expect(data.results[0].title).toBe('Test Paper');
            expect(data.results[0].authors).toBe('Smith');
            expect(data.results[0].year).toBe(2023);
            expect(data.results[0].publication).toBe('Test Journal');
            expect(data.results[0].similarity).toBe(0.88); // rounded to 2 decimals
            expect(data.results[0].citation_key).toBe('smith2023');
            expect(data.results[0].zotero_uri).toContain('ABC12345');
        });

        it('includes attachment info in results', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [makeSearchResultItem()],
            });

            const result = await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });
            const data = JSON.parse(result.content[0].text);
            const att = data.results[0].attachments[0];

            expect(att.attachment_id).toBe('1-ATT00001');
            expect(att.filename).toBe('paper.pdf');
            expect(att.page_count).toBe(25);
            expect(att.status).toBe('available');
        });

        it('includes tags in results', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [makeSearchResultItem()],
            });

            const result = await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });
            const data = JSON.parse(result.content[0].text);

            expect(data.results[0].tags).toEqual(['methods', 'review']);
        });

        it('truncates abstract to 300 chars', async () => {
            const longAbstract = 'A'.repeat(400);
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [makeSearchResultItem({ item: { abstract: longAbstract } })],
            });

            const result = await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });
            const data = JSON.parse(result.content[0].text);

            expect(data.results[0].abstract).toHaveLength(303); // 300 + '...'
            expect(data.results[0].abstract).toMatch(/\.\.\.$/);
        });

        it('does not truncate short abstracts', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [makeSearchResultItem({ item: { abstract: 'Short abstract' } })],
            });

            const result = await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });
            const data = JSON.parse(result.content[0].text);

            expect(data.results[0].abstract).toBe('Short abstract');
        });

        it('sets has_more=true when more results exist', async () => {
            const items = Array.from({ length: 6 }, (_, i) =>
                makeSearchResultItem({ item: { zotero_key: `KEY${i}` } }),
            );
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items,
            });

            const result = await callTool(endpoint, 'search_by_topic', {
                topic_query: 'test',
                limit: 5,
            });
            const data = JSON.parse(result.content[0].text);

            expect(data.has_more).toBe(true);
            expect(data.next_offset).toBe(5);
            expect(data.results).toHaveLength(5);
        });

        it('sets has_more=false when no more results', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [makeSearchResultItem()],
            });

            const result = await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });
            const data = JSON.parse(result.content[0].text);

            expect(data.has_more).toBe(false);
            expect(data.next_offset).toBeNull();
        });

        it('returns error when search fails', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [],
                error: 'Embedding service unavailable',
            });

            const result = await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Search failed');
            expect(result.content[0].text).toContain('Embedding service unavailable');
        });

        it('omits attachments key when no attachments', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [makeSearchResultItem({ attachments: [] })],
            });

            const result = await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });
            const data = JSON.parse(result.content[0].text);

            expect(data.results[0].attachments).toBeUndefined();
        });

        it('omits tags key when no tags', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [makeSearchResultItem({ item: { tags: [] } })],
            });

            const result = await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });
            const data = JSON.parse(result.content[0].text);

            expect(data.results[0].tags).toBeUndefined();
        });

        it('omits citation_key when not present', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [makeSearchResultItem({ item: { citation_key: undefined } })],
            });

            const result = await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });
            const data = JSON.parse(result.content[0].text);

            expect(data.results[0].citation_key).toBeUndefined();
        });

        it('shows Untitled for null title', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [makeSearchResultItem({ item: { title: null } })],
            });

            const result = await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });
            const data = JSON.parse(result.content[0].text);

            expect(data.results[0].title).toBe('Untitled');
        });
    });

    // =====================================================================
    // search_by_metadata
    // =====================================================================

    describe('search_by_metadata', () => {
        it('passes author_query to handler', async () => {
            mockHandleItemSearchByMetadataRequest.mockResolvedValue({
                type: 'item_search_by_metadata',
                items: [],
            });

            await callTool(endpoint, 'search_by_metadata', { author_query: 'Smith' });

            const req = mockHandleItemSearchByMetadataRequest.mock.calls[0][0];
            expect(req.author_query).toBe('Smith');
        });

        it('passes title_query to handler', async () => {
            mockHandleItemSearchByMetadataRequest.mockResolvedValue({
                type: 'item_search_by_metadata',
                items: [],
            });

            await callTool(endpoint, 'search_by_metadata', { title_query: 'colonial origins' });

            const req = mockHandleItemSearchByMetadataRequest.mock.calls[0][0];
            expect(req.title_query).toBe('colonial origins');
        });

        it('passes publication_query to handler', async () => {
            mockHandleItemSearchByMetadataRequest.mockResolvedValue({
                type: 'item_search_by_metadata',
                items: [],
            });

            await callTool(endpoint, 'search_by_metadata', { publication_query: 'American Economic Review' });

            const req = mockHandleItemSearchByMetadataRequest.mock.calls[0][0];
            expect(req.publication_query).toBe('American Economic Review');
        });

        it('returns error when no search fields provided', async () => {
            const result = await callTool(endpoint, 'search_by_metadata', {});

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('At least one search field');
        });

        it('passes combined search fields', async () => {
            mockHandleItemSearchByMetadataRequest.mockResolvedValue({
                type: 'item_search_by_metadata',
                items: [],
            });

            await callTool(endpoint, 'search_by_metadata', {
                author_query: 'Smith',
                title_query: 'origins',
                publication_query: 'AER',
            });

            const req = mockHandleItemSearchByMetadataRequest.mock.calls[0][0];
            expect(req.author_query).toBe('Smith');
            expect(req.title_query).toBe('origins');
            expect(req.publication_query).toBe('AER');
        });

        it('passes min_year and max_year', async () => {
            mockHandleItemSearchByMetadataRequest.mockResolvedValue({
                type: 'item_search_by_metadata',
                items: [],
            });

            await callTool(endpoint, 'search_by_metadata', {
                author_query: 'Smith',
                min_year: 2010,
                max_year: 2020,
            });

            const req = mockHandleItemSearchByMetadataRequest.mock.calls[0][0];
            expect(req.year_min).toBe(2010);
            expect(req.year_max).toBe(2020);
        });

        it('passes libraries_filter', async () => {
            mockHandleItemSearchByMetadataRequest.mockResolvedValue({
                type: 'item_search_by_metadata',
                items: [],
            });

            await callTool(endpoint, 'search_by_metadata', {
                author_query: 'Smith',
                libraries_filter: ['lib1'],
            });

            const req = mockHandleItemSearchByMetadataRequest.mock.calls[0][0];
            expect(req.libraries_filter).toEqual(['lib1']);
        });

        it('passes tags_filter', async () => {
            mockHandleItemSearchByMetadataRequest.mockResolvedValue({
                type: 'item_search_by_metadata',
                items: [],
            });

            await callTool(endpoint, 'search_by_metadata', {
                title_query: 'test',
                tags_filter: ['important'],
            });

            const req = mockHandleItemSearchByMetadataRequest.mock.calls[0][0];
            expect(req.tags_filter).toEqual(['important']);
        });

        it('passes collections_filter', async () => {
            mockHandleItemSearchByMetadataRequest.mockResolvedValue({
                type: 'item_search_by_metadata',
                items: [],
            });

            await callTool(endpoint, 'search_by_metadata', {
                author_query: 'Jones',
                collections_filter: ['COL1'],
            });

            const req = mockHandleItemSearchByMetadataRequest.mock.calls[0][0];
            expect(req.collections_filter).toEqual(['COL1']);
        });

        it('defaults limit to 5 and offset to 0', async () => {
            mockHandleItemSearchByMetadataRequest.mockResolvedValue({
                type: 'item_search_by_metadata',
                items: [],
            });

            await callTool(endpoint, 'search_by_metadata', { author_query: 'Smith' });

            const req = mockHandleItemSearchByMetadataRequest.mock.calls[0][0];
            expect(req.limit).toBe(6); // 5 + 1
            expect(req.offset).toBe(0);
        });

        it('caps limit at 25', async () => {
            mockHandleItemSearchByMetadataRequest.mockResolvedValue({
                type: 'item_search_by_metadata',
                items: [],
            });

            await callTool(endpoint, 'search_by_metadata', {
                author_query: 'Smith',
                limit: 50,
            });

            const req = mockHandleItemSearchByMetadataRequest.mock.calls[0][0];
            expect(req.limit).toBe(26); // 25 + 1
        });

        it('returns results without similarity scores', async () => {
            mockHandleItemSearchByMetadataRequest.mockResolvedValue({
                type: 'item_search_by_metadata',
                items: [makeSearchResultItem({ similarity: 0.9 })],
            });

            const result = await callTool(endpoint, 'search_by_metadata', { author_query: 'Smith' });
            const data = JSON.parse(result.content[0].text);

            expect(data.results[0].similarity).toBeUndefined();
        });

        it('returns error on backend failure', async () => {
            mockHandleItemSearchByMetadataRequest.mockResolvedValue({
                type: 'item_search_by_metadata',
                items: [],
                error: 'DB connection failed',
            });

            const result = await callTool(endpoint, 'search_by_metadata', { author_query: 'Smith' });

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Search failed');
        });

        it('handles has_more pagination correctly', async () => {
            const items = Array.from({ length: 4 }, () => makeSearchResultItem());
            mockHandleItemSearchByMetadataRequest.mockResolvedValue({
                type: 'item_search_by_metadata',
                items,
            });

            const result = await callTool(endpoint, 'search_by_metadata', {
                author_query: 'Smith',
                limit: 3,
            });
            const data = JSON.parse(result.content[0].text);

            expect(data.has_more).toBe(true);
            expect(data.next_offset).toBe(3);
            expect(data.results).toHaveLength(3);
        });
    });

    // =====================================================================
    // read_attachment
    // =====================================================================

    describe('read_attachment', () => {
        it('parses attachment_id correctly', async () => {
            mockHandleZoteroAttachmentPagesRequest.mockResolvedValue({
                type: 'zotero_attachment_pages',
                pages: [{ page_number: 1, content: 'Hello' }],
                total_pages: 10,
            });

            await callTool(endpoint, 'read_attachment', { attachment_id: '1-ABC12345' });

            const req = mockHandleZoteroAttachmentPagesRequest.mock.calls[0][0];
            expect(req.attachment).toEqual({ library_id: 1, zotero_key: 'ABC12345' });
        });

        it('returns error for invalid attachment_id format (no dash)', async () => {
            const result = await callTool(endpoint, 'read_attachment', { attachment_id: 'invalid' });

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Invalid attachment_id format');
        });

        it('returns error for empty key after dash', async () => {
            const result = await callTool(endpoint, 'read_attachment', { attachment_id: '1-' });

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Invalid attachment_id format');
        });

        it('returns error for non-numeric library_id', async () => {
            const result = await callTool(endpoint, 'read_attachment', { attachment_id: 'abc-KEY' });

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Invalid attachment_id format');
        });

        it('defaults to page 1 with 30-page range', async () => {
            mockHandleZoteroAttachmentPagesRequest.mockResolvedValue({
                type: 'zotero_attachment_pages',
                pages: [{ page_number: 1, content: 'page 1' }],
                total_pages: 5,
            });

            await callTool(endpoint, 'read_attachment', { attachment_id: '1-KEY' });

            const req = mockHandleZoteroAttachmentPagesRequest.mock.calls[0][0];
            expect(req.start_page).toBe(1);
            expect(req.end_page).toBe(30);
        });

        it('respects start_page argument', async () => {
            mockHandleZoteroAttachmentPagesRequest.mockResolvedValue({
                type: 'zotero_attachment_pages',
                pages: [{ page_number: 5, content: 'page 5' }],
                total_pages: 50,
            });

            await callTool(endpoint, 'read_attachment', {
                attachment_id: '1-KEY',
                start_page: 5,
            });

            const req = mockHandleZoteroAttachmentPagesRequest.mock.calls[0][0];
            expect(req.start_page).toBe(5);
            expect(req.end_page).toBe(34); // 5 + 30 - 1
        });

        it('respects end_page argument', async () => {
            mockHandleZoteroAttachmentPagesRequest.mockResolvedValue({
                type: 'zotero_attachment_pages',
                pages: [{ page_number: 1, content: 'p1' }],
                total_pages: 10,
            });

            await callTool(endpoint, 'read_attachment', {
                attachment_id: '1-KEY',
                start_page: 1,
                end_page: 5,
            });

            const req = mockHandleZoteroAttachmentPagesRequest.mock.calls[0][0];
            expect(req.start_page).toBe(1);
            expect(req.end_page).toBe(5);
        });

        it('caps page range to 30 pages max', async () => {
            mockHandleZoteroAttachmentPagesRequest.mockResolvedValue({
                type: 'zotero_attachment_pages',
                pages: [],
                total_pages: 100,
            });

            await callTool(endpoint, 'read_attachment', {
                attachment_id: '1-KEY',
                start_page: 10,
                end_page: 100,
            });

            const req = mockHandleZoteroAttachmentPagesRequest.mock.calls[0][0];
            expect(req.end_page).toBe(39); // min(100, 10+30-1) = 39
        });

        it('returns formatted page text with XML tags', async () => {
            mockHandleZoteroAttachmentPagesRequest.mockResolvedValue({
                type: 'zotero_attachment_pages',
                pages: [
                    { page_number: 1, content: 'Introduction text' },
                    { page_number: 2, content: 'Methods section' },
                ],
                total_pages: 20,
            });

            const result = await callTool(endpoint, 'read_attachment', { attachment_id: '1-KEY' });
            const text = result.content[0].text;

            expect(text).toContain('Attachment: 1-KEY');
            expect(text).toContain('Total pages: 20');
            expect(text).toContain('Showing pages 1-2');
            expect(text).toContain('<page1>');
            expect(text).toContain('Introduction text');
            expect(text).toContain('</page1>');
            expect(text).toContain('<page2>');
            expect(text).toContain('Methods section');
            expect(text).toContain('</page2>');
        });

        it('returns error on backend failure', async () => {
            mockHandleZoteroAttachmentPagesRequest.mockResolvedValue({
                type: 'zotero_attachment_pages',
                pages: [],
                error: 'File not found',
            });

            const result = await callTool(endpoint, 'read_attachment', { attachment_id: '1-KEY' });

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('File not found');
        });

        it('handles unknown total_pages', async () => {
            mockHandleZoteroAttachmentPagesRequest.mockResolvedValue({
                type: 'zotero_attachment_pages',
                pages: [{ page_number: 1, content: 'text' }],
                total_pages: null,
            });

            const result = await callTool(endpoint, 'read_attachment', { attachment_id: '1-KEY' });
            const text = result.content[0].text;

            expect(text).toContain('Total pages: unknown');
        });

        it('handles library_id with multiple digits', async () => {
            mockHandleZoteroAttachmentPagesRequest.mockResolvedValue({
                type: 'zotero_attachment_pages',
                pages: [],
                total_pages: 0,
            });

            await callTool(endpoint, 'read_attachment', { attachment_id: '12345-LONGKEY' });

            const req = mockHandleZoteroAttachmentPagesRequest.mock.calls[0][0];
            expect(req.attachment).toEqual({ library_id: 12345, zotero_key: 'LONGKEY' });
        });
    });

    // =====================================================================
    // get_item_details
    // =====================================================================

    describe('get_item_details', () => {
        it('passes item_ids to handler', async () => {
            mockHandleGetMetadataRequest.mockResolvedValue({
                type: 'get_metadata',
                items: [],
                not_found: [],
            });

            await callTool(endpoint, 'get_item_details', {
                item_ids: ['1-KEY1', '1-KEY2'],
            });

            const req = mockHandleGetMetadataRequest.mock.calls[0][0];
            expect(req.item_ids).toEqual(['1-KEY1', '1-KEY2']);
        });

        it('defaults include_attachments to false', async () => {
            mockHandleGetMetadataRequest.mockResolvedValue({
                type: 'get_metadata',
                items: [],
                not_found: [],
            });

            await callTool(endpoint, 'get_item_details', { item_ids: ['1-KEY'] });

            const req = mockHandleGetMetadataRequest.mock.calls[0][0];
            expect(req.include_attachments).toBe(false);
        });

        it('passes include_attachments=true', async () => {
            mockHandleGetMetadataRequest.mockResolvedValue({
                type: 'get_metadata',
                items: [],
                not_found: [],
            });

            await callTool(endpoint, 'get_item_details', {
                item_ids: ['1-KEY'],
                include_attachments: true,
            });

            const req = mockHandleGetMetadataRequest.mock.calls[0][0];
            expect(req.include_attachments).toBe(true);
        });

        it('always sets include_notes to false', async () => {
            mockHandleGetMetadataRequest.mockResolvedValue({
                type: 'get_metadata',
                items: [],
                not_found: [],
            });

            await callTool(endpoint, 'get_item_details', { item_ids: ['1-KEY'] });

            const req = mockHandleGetMetadataRequest.mock.calls[0][0];
            expect(req.include_notes).toBe(false);
        });

        it('returns error for empty item_ids', async () => {
            const result = await callTool(endpoint, 'get_item_details', { item_ids: [] });

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('non-empty array');
        });

        it('returns error for missing item_ids', async () => {
            const result = await callTool(endpoint, 'get_item_details', {});

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('non-empty array');
        });

        it('returns error for too many items (>25)', async () => {
            const ids = Array.from({ length: 26 }, (_, i) => `1-KEY${i}`);
            const result = await callTool(endpoint, 'get_item_details', { item_ids: ids });

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Too many items');
            expect(result.content[0].text).toContain('26');
        });

        it('enriches items with zotero_uri', async () => {
            mockHandleGetMetadataRequest.mockResolvedValue({
                type: 'get_metadata',
                items: [{ item_id: '1-KEY1' }],
                not_found: [],
            });

            const result = await callTool(endpoint, 'get_item_details', { item_ids: ['1-KEY1'] });
            const data = JSON.parse(result.content[0].text);

            expect(data.items[0].zotero_uri).toContain('KEY1');
        });

        it('removes internal fields from response', async () => {
            mockHandleGetMetadataRequest.mockResolvedValue({
                type: 'get_metadata',
                items: [{
                    item_id: '1-KEY1',
                    item_metadata_hash: 'abc123',
                    zotero_version: 42,
                    zotero_synced: true,
                    item_json: '{}',
                }],
                not_found: [],
            });

            const result = await callTool(endpoint, 'get_item_details', { item_ids: ['1-KEY1'] });
            const data = JSON.parse(result.content[0].text);

            expect(data.items[0].item_metadata_hash).toBeUndefined();
            expect(data.items[0].zotero_version).toBeUndefined();
            expect(data.items[0].zotero_synced).toBeUndefined();
            expect(data.items[0].item_json).toBeUndefined();
        });

        it('transforms attachment format with available status', async () => {
            mockHandleGetMetadataRequest.mockResolvedValue({
                type: 'get_metadata',
                items: [{
                    item_id: '1-KEY1',
                    attachments: [{
                        attachment_id: '1-ATT1',
                        filename: 'paper.pdf',
                        contentType: 'application/pdf',
                        path: '/some/path/paper.pdf',
                    }],
                }],
                not_found: [],
            });

            const result = await callTool(endpoint, 'get_item_details', { item_ids: ['1-KEY1'] });
            const data = JSON.parse(result.content[0].text);
            const att = data.items[0].attachments[0];

            expect(att.attachment_id).toBe('1-ATT1');
            expect(att.filename).toBe('paper.pdf');
            expect(att.content_type).toBe('application/pdf');
            expect(att.status).toBe('available');
            expect(att.page_count).toBeNull();
        });

        it('marks attachment as unavailable when path is missing', async () => {
            mockHandleGetMetadataRequest.mockResolvedValue({
                type: 'get_metadata',
                items: [{
                    item_id: '1-KEY1',
                    attachments: [{
                        attachment_id: '1-ATT1',
                        filename: 'paper.pdf',
                        contentType: 'application/pdf',
                        path: null,
                    }],
                }],
                not_found: [],
            });

            const result = await callTool(endpoint, 'get_item_details', { item_ids: ['1-KEY1'] });
            const data = JSON.parse(result.content[0].text);

            expect(data.items[0].attachments[0].status).toBe('unavailable');
        });

        it('includes not_found in response', async () => {
            mockHandleGetMetadataRequest.mockResolvedValue({
                type: 'get_metadata',
                items: [],
                not_found: ['1-MISSING'],
            });

            const result = await callTool(endpoint, 'get_item_details', { item_ids: ['1-MISSING'] });
            const data = JSON.parse(result.content[0].text);

            expect(data.not_found).toEqual(['1-MISSING']);
        });

        it('returns error on backend failure', async () => {
            mockHandleGetMetadataRequest.mockResolvedValue({
                type: 'get_metadata',
                items: [],
                not_found: [],
                error: 'DB error',
            });

            const result = await callTool(endpoint, 'get_item_details', { item_ids: ['1-KEY'] });

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Failed to get item details');
        });

        it('attempts to add citation key via Zotero lookup', async () => {
            const mockItem = { id: 1, key: 'KEY1', libraryID: 1 };
            zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(mockItem);

            // getCitationKeyFromItem is already mocked to return null by default
            mockHandleGetMetadataRequest.mockResolvedValue({
                type: 'get_metadata',
                items: [{ item_id: '1-KEY1' }],
                not_found: [],
            });

            await callTool(endpoint, 'get_item_details', { item_ids: ['1-KEY1'] });

            expect(zotero.Items.getByLibraryAndKeyAsync).toHaveBeenCalledWith(1, 'KEY1');
        });
    });

    // =====================================================================
    // list_collections
    // =====================================================================

    describe('list_collections', () => {
        it('defaults limit to 50 and offset to 0', async () => {
            mockHandleListCollectionsRequest.mockResolvedValue({
                type: 'list_collections',
                collections: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_collections', {});

            const req = mockHandleListCollectionsRequest.mock.calls[0][0];
            expect(req.limit).toBe(50);
            expect(req.offset).toBe(0);
        });

        it('caps limit at 100', async () => {
            mockHandleListCollectionsRequest.mockResolvedValue({
                type: 'list_collections',
                collections: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_collections', { limit: 200 });

            const req = mockHandleListCollectionsRequest.mock.calls[0][0];
            expect(req.limit).toBe(100);
        });

        it('passes library as numeric ID when parseable', async () => {
            mockHandleListCollectionsRequest.mockResolvedValue({
                type: 'list_collections',
                collections: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_collections', { library: '42' });

            const req = mockHandleListCollectionsRequest.mock.calls[0][0];
            expect(req.library_id).toBe(42);
        });

        it('passes library as string when not numeric', async () => {
            mockHandleListCollectionsRequest.mockResolvedValue({
                type: 'list_collections',
                collections: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_collections', { library: 'My Library' });

            const req = mockHandleListCollectionsRequest.mock.calls[0][0];
            expect(req.library_id).toBe('My Library');
        });

        it('passes null library_id when not specified', async () => {
            mockHandleListCollectionsRequest.mockResolvedValue({
                type: 'list_collections',
                collections: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_collections', {});

            const req = mockHandleListCollectionsRequest.mock.calls[0][0];
            expect(req.library_id).toBeNull();
        });

        it('passes parent_collection', async () => {
            mockHandleListCollectionsRequest.mockResolvedValue({
                type: 'list_collections',
                collections: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_collections', { parent_collection: 'PARENT01' });

            const req = mockHandleListCollectionsRequest.mock.calls[0][0];
            expect(req.parent_collection_key).toBe('PARENT01');
        });

        it('defaults include_item_counts to true', async () => {
            mockHandleListCollectionsRequest.mockResolvedValue({
                type: 'list_collections',
                collections: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_collections', {});

            const req = mockHandleListCollectionsRequest.mock.calls[0][0];
            expect(req.include_item_counts).toBe(true);
        });

        it('passes include_item_counts=false', async () => {
            mockHandleListCollectionsRequest.mockResolvedValue({
                type: 'list_collections',
                collections: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_collections', { include_item_counts: false });

            const req = mockHandleListCollectionsRequest.mock.calls[0][0];
            expect(req.include_item_counts).toBe(false);
        });

        it('returns formatted collections', async () => {
            mockHandleListCollectionsRequest.mockResolvedValue({
                type: 'list_collections',
                collections: [{
                    collection_key: 'COL1',
                    name: 'Machine Learning',
                    item_count: 42,
                    subcollection_count: 3,
                }],
                total_count: 1,
            });

            const result = await callTool(endpoint, 'list_collections', {});
            const data = JSON.parse(result.content[0].text);

            expect(data.total_count).toBe(1);
            expect(data.collections[0]).toEqual({
                collection_key: 'COL1',
                name: 'Machine Learning',
                item_count: 42,
                subcollection_count: 3,
            });
        });

        it('sets has_more=true when more collections exist', async () => {
            mockHandleListCollectionsRequest.mockResolvedValue({
                type: 'list_collections',
                collections: Array.from({ length: 50 }, (_, i) => ({
                    collection_key: `COL${i}`,
                    name: `Collection ${i}`,
                    item_count: 0,
                    subcollection_count: 0,
                })),
                total_count: 100,
            });

            const result = await callTool(endpoint, 'list_collections', {});
            const data = JSON.parse(result.content[0].text);

            expect(data.has_more).toBe(true);
            expect(data.next_offset).toBe(50);
        });

        it('sets has_more=false when all collections returned', async () => {
            mockHandleListCollectionsRequest.mockResolvedValue({
                type: 'list_collections',
                collections: [{ collection_key: 'COL1', name: 'Only One', item_count: 5, subcollection_count: 0 }],
                total_count: 1,
            });

            const result = await callTool(endpoint, 'list_collections', {});
            const data = JSON.parse(result.content[0].text);

            expect(data.has_more).toBe(false);
            expect(data.next_offset).toBeNull();
        });

        it('returns error on backend failure', async () => {
            mockHandleListCollectionsRequest.mockResolvedValue({
                type: 'list_collections',
                collections: [],
                total_count: 0,
                error: 'Library not found',
            });

            const result = await callTool(endpoint, 'list_collections', {});

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Failed to list collections');
        });
    });

    // =====================================================================
    // list_tags
    // =====================================================================

    describe('list_tags', () => {
        it('defaults limit to 50 and offset to 0', async () => {
            mockHandleListTagsRequest.mockResolvedValue({
                type: 'list_tags',
                tags: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_tags', {});

            const req = mockHandleListTagsRequest.mock.calls[0][0];
            expect(req.limit).toBe(50);
            expect(req.offset).toBe(0);
        });

        it('caps limit at 100', async () => {
            mockHandleListTagsRequest.mockResolvedValue({
                type: 'list_tags',
                tags: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_tags', { limit: 500 });

            const req = mockHandleListTagsRequest.mock.calls[0][0];
            expect(req.limit).toBe(100);
        });

        it('passes library as numeric ID', async () => {
            mockHandleListTagsRequest.mockResolvedValue({
                type: 'list_tags',
                tags: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_tags', { library: '7' });

            const req = mockHandleListTagsRequest.mock.calls[0][0];
            expect(req.library_id).toBe(7);
        });

        it('passes library as string name', async () => {
            mockHandleListTagsRequest.mockResolvedValue({
                type: 'list_tags',
                tags: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_tags', { library: 'Group Library' });

            const req = mockHandleListTagsRequest.mock.calls[0][0];
            expect(req.library_id).toBe('Group Library');
        });

        it('passes collection key', async () => {
            mockHandleListTagsRequest.mockResolvedValue({
                type: 'list_tags',
                tags: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_tags', { collection: 'COL1' });

            const req = mockHandleListTagsRequest.mock.calls[0][0];
            expect(req.collection_key).toBe('COL1');
        });

        it('defaults null for collection_key when not specified', async () => {
            mockHandleListTagsRequest.mockResolvedValue({
                type: 'list_tags',
                tags: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_tags', {});

            const req = mockHandleListTagsRequest.mock.calls[0][0];
            expect(req.collection_key).toBeNull();
        });

        it('defaults min_item_count to 1', async () => {
            mockHandleListTagsRequest.mockResolvedValue({
                type: 'list_tags',
                tags: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_tags', {});

            const req = mockHandleListTagsRequest.mock.calls[0][0];
            expect(req.min_item_count).toBe(1);
        });

        it('passes custom min_item_count', async () => {
            mockHandleListTagsRequest.mockResolvedValue({
                type: 'list_tags',
                tags: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_tags', { min_item_count: 5 });

            const req = mockHandleListTagsRequest.mock.calls[0][0];
            expect(req.min_item_count).toBe(5);
        });

        it('returns formatted tags with color', async () => {
            mockHandleListTagsRequest.mockResolvedValue({
                type: 'list_tags',
                tags: [
                    { name: 'important', item_count: 15, color: '#ff0000' },
                    { name: 'review', item_count: 8, color: null },
                ],
                total_count: 2,
            });

            const result = await callTool(endpoint, 'list_tags', {});
            const data = JSON.parse(result.content[0].text);

            expect(data.total_count).toBe(2);
            expect(data.tags[0].name).toBe('important');
            expect(data.tags[0].item_count).toBe(15);
            expect(data.tags[0].color).toBe('#ff0000');
            // Null color should be excluded
            expect(data.tags[1].name).toBe('review');
            expect(data.tags[1].color).toBeUndefined();
        });

        it('calculates pagination', async () => {
            mockHandleListTagsRequest.mockResolvedValue({
                type: 'list_tags',
                tags: Array.from({ length: 10 }, (_, i) => ({
                    name: `tag${i}`,
                    item_count: 1,
                })),
                total_count: 30,
            });

            const result = await callTool(endpoint, 'list_tags', { limit: 10 });
            const data = JSON.parse(result.content[0].text);

            expect(data.has_more).toBe(true);
            expect(data.next_offset).toBe(10);
        });

        it('returns error on backend failure', async () => {
            mockHandleListTagsRequest.mockResolvedValue({
                type: 'list_tags',
                tags: [],
                total_count: 0,
                error: 'Failed',
            });

            const result = await callTool(endpoint, 'list_tags', {});

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Failed to list tags');
        });
    });

    // =====================================================================
    // list_items
    // =====================================================================

    describe('list_items', () => {
        it('defaults to dateModified desc sort', async () => {
            mockHandleListItemsRequest.mockResolvedValue({
                type: 'list_items',
                items: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_items', {});

            const req = mockHandleListItemsRequest.mock.calls[0][0];
            expect(req.sort_by).toBe('dateModified');
            expect(req.sort_order).toBe('desc');
        });

        it('defaults limit to 20 and offset to 0', async () => {
            mockHandleListItemsRequest.mockResolvedValue({
                type: 'list_items',
                items: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_items', {});

            const req = mockHandleListItemsRequest.mock.calls[0][0];
            expect(req.limit).toBe(20);
            expect(req.offset).toBe(0);
        });

        it('caps limit at 100', async () => {
            mockHandleListItemsRequest.mockResolvedValue({
                type: 'list_items',
                items: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_items', { limit: 500 });

            const req = mockHandleListItemsRequest.mock.calls[0][0];
            expect(req.limit).toBe(100);
        });

        it('passes library as numeric ID', async () => {
            mockHandleListItemsRequest.mockResolvedValue({
                type: 'list_items',
                items: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_items', { library: '1' });

            const req = mockHandleListItemsRequest.mock.calls[0][0];
            expect(req.library_id).toBe(1);
        });

        it('passes library as string name', async () => {
            mockHandleListItemsRequest.mockResolvedValue({
                type: 'list_items',
                items: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_items', { library: 'Lab Group' });

            const req = mockHandleListItemsRequest.mock.calls[0][0];
            expect(req.library_id).toBe('Lab Group');
        });

        it('passes collection key', async () => {
            mockHandleListItemsRequest.mockResolvedValue({
                type: 'list_items',
                items: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_items', { collection: 'COL123' });

            const req = mockHandleListItemsRequest.mock.calls[0][0];
            expect(req.collection_key).toBe('COL123');
        });

        it('passes tag filter', async () => {
            mockHandleListItemsRequest.mockResolvedValue({
                type: 'list_items',
                items: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_items', { tag: 'important' });

            const req = mockHandleListItemsRequest.mock.calls[0][0];
            expect(req.tag).toBe('important');
        });

        it('defaults recursive to true', async () => {
            mockHandleListItemsRequest.mockResolvedValue({
                type: 'list_items',
                items: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_items', {});

            const req = mockHandleListItemsRequest.mock.calls[0][0];
            expect(req.recursive).toBe(true);
        });

        it('passes recursive=false', async () => {
            mockHandleListItemsRequest.mockResolvedValue({
                type: 'list_items',
                items: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_items', { recursive: false });

            const req = mockHandleListItemsRequest.mock.calls[0][0];
            expect(req.recursive).toBe(false);
        });

        it('accepts all valid sort_by values', async () => {
            for (const sortBy of ['dateAdded', 'dateModified', 'title', 'creator', 'year']) {
                vi.clearAllMocks();
                zotero.Server = { Endpoints: {} };
                endpoint = setupMcpEndpoint();

                mockHandleListItemsRequest.mockResolvedValue({
                    type: 'list_items',
                    items: [],
                    total_count: 0,
                });

                await callTool(endpoint, 'list_items', { sort_by: sortBy });

                const req = mockHandleListItemsRequest.mock.calls[0][0];
                expect(req.sort_by).toBe(sortBy);
            }
        });

        it('falls back to dateModified for invalid sort_by', async () => {
            mockHandleListItemsRequest.mockResolvedValue({
                type: 'list_items',
                items: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_items', { sort_by: 'invalidField' });

            const req = mockHandleListItemsRequest.mock.calls[0][0];
            expect(req.sort_by).toBe('dateModified');
        });

        it('accepts asc sort_order', async () => {
            mockHandleListItemsRequest.mockResolvedValue({
                type: 'list_items',
                items: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_items', { sort_order: 'asc' });

            const req = mockHandleListItemsRequest.mock.calls[0][0];
            expect(req.sort_order).toBe('asc');
        });

        it('defaults invalid sort_order to desc', async () => {
            mockHandleListItemsRequest.mockResolvedValue({
                type: 'list_items',
                items: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_items', { sort_order: 'random' });

            const req = mockHandleListItemsRequest.mock.calls[0][0];
            expect(req.sort_order).toBe('desc');
        });

        it('always sets item_category to regular', async () => {
            mockHandleListItemsRequest.mockResolvedValue({
                type: 'list_items',
                items: [],
                total_count: 0,
            });

            await callTool(endpoint, 'list_items', {});

            const req = mockHandleListItemsRequest.mock.calls[0][0];
            expect(req.item_category).toBe('regular');
        });

        it('returns formatted item list with zotero_uri', async () => {
            mockHandleListItemsRequest.mockResolvedValue({
                type: 'list_items',
                items: [{
                    item_id: '1-KEY1',
                    result_type: 'regular',
                    item_type: 'journalArticle',
                    title: 'A Great Paper',
                    creators: 'Smith & Jones',
                    year: 2022,
                    date_added: '2022-01-15',
                    date_modified: '2022-06-20',
                }],
                total_count: 1,
            });

            const result = await callTool(endpoint, 'list_items', {});
            const data = JSON.parse(result.content[0].text);

            expect(data.total_count).toBe(1);
            expect(data.items[0].item_id).toBe('1-KEY1');
            expect(data.items[0].item_type).toBe('journalArticle');
            expect(data.items[0].title).toBe('A Great Paper');
            expect(data.items[0].authors).toBe('Smith & Jones');
            expect(data.items[0].year).toBe(2022);
            expect(data.items[0].date_added).toBe('2022-01-15');
            expect(data.items[0].date_modified).toBe('2022-06-20');
            expect(data.items[0].zotero_uri).toContain('KEY1');
        });

        it('calculates pagination', async () => {
            mockHandleListItemsRequest.mockResolvedValue({
                type: 'list_items',
                items: Array.from({ length: 20 }, (_, i) => ({
                    item_id: `1-KEY${i}`,
                    result_type: 'regular',
                    item_type: 'journalArticle',
                    title: `Paper ${i}`,
                })),
                total_count: 50,
            });

            const result = await callTool(endpoint, 'list_items', {});
            const data = JSON.parse(result.content[0].text);

            expect(data.has_more).toBe(true);
            expect(data.next_offset).toBe(20);
        });

        it('handles last page with no more items', async () => {
            mockHandleListItemsRequest.mockResolvedValue({
                type: 'list_items',
                items: [{ item_id: '1-KEY1', result_type: 'regular', item_type: 'book', title: 'Book' }],
                total_count: 1,
            });

            const result = await callTool(endpoint, 'list_items', {});
            const data = JSON.parse(result.content[0].text);

            expect(data.has_more).toBe(false);
            expect(data.next_offset).toBeNull();
        });

        it('returns error on backend failure', async () => {
            mockHandleListItemsRequest.mockResolvedValue({
                type: 'list_items',
                items: [],
                total_count: 0,
                error: 'Query failed',
            });

            const result = await callTool(endpoint, 'list_items', {});

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Failed to list items');
        });
    });

    // =====================================================================
    // Author formatting (via search results)
    // =====================================================================

    describe('author formatting', () => {
        it('formats single author by last name', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [makeSearchResultItem({
                    item: { creators: [{ first_name: 'John', last_name: 'Smith' }] },
                })],
            });

            const result = await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });
            const data = JSON.parse(result.content[0].text);

            expect(data.results[0].authors).toBe('Smith');
        });

        it('formats two authors with ampersand', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [makeSearchResultItem({
                    item: {
                        creators: [
                            { first_name: 'Alice', last_name: 'Smith' },
                            { first_name: 'Bob', last_name: 'Jones' },
                        ],
                    },
                })],
            });

            const result = await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });
            const data = JSON.parse(result.content[0].text);

            expect(data.results[0].authors).toBe('Smith & Jones');
        });

        it('formats three+ authors with commas and ampersand', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [makeSearchResultItem({
                    item: {
                        creators: [
                            { first_name: 'A', last_name: 'Smith' },
                            { first_name: 'B', last_name: 'Jones' },
                            { first_name: 'C', last_name: 'Lee' },
                        ],
                    },
                })],
            });

            const result = await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });
            const data = JSON.parse(result.content[0].text);

            expect(data.results[0].authors).toBe('Smith, Jones & Lee');
        });

        it('returns Unknown for empty creators', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [makeSearchResultItem({ item: { creators: [] } })],
            });

            const result = await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });
            const data = JSON.parse(result.content[0].text);

            expect(data.results[0].authors).toBe('Unknown');
        });

        it('returns Unknown for null creators', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [makeSearchResultItem({ item: { creators: null } })],
            });

            const result = await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });
            const data = JSON.parse(result.content[0].text);

            expect(data.results[0].authors).toBe('Unknown');
        });

        it('uses first_name when last_name is null', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [makeSearchResultItem({
                    item: { creators: [{ first_name: 'Madonna', last_name: null }] },
                })],
            });

            const result = await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });
            const data = JSON.parse(result.content[0].text);

            expect(data.results[0].authors).toBe('Madonna');
        });
    });

    // =====================================================================
    // Tag normalization (via search results)
    // =====================================================================

    describe('tag normalization', () => {
        it('normalizes string tags', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [makeSearchResultItem({
                    item: { tags: ['tag1', 'tag2'] },
                })],
            });

            const result = await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });
            const data = JSON.parse(result.content[0].text);

            expect(data.results[0].tags).toEqual(['tag1', 'tag2']);
        });

        it('normalizes object tags with tag property', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [makeSearchResultItem({
                    item: { tags: [{ tag: 'important' }, { tag: 'review' }] },
                })],
            });

            const result = await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });
            const data = JSON.parse(result.content[0].text);

            expect(data.results[0].tags).toEqual(['important', 'review']);
        });

        it('normalizes object tags with name property', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [makeSearchResultItem({
                    item: { tags: [{ name: 'tag1' }] },
                })],
            });

            const result = await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });
            const data = JSON.parse(result.content[0].text);

            expect(data.results[0].tags).toEqual(['tag1']);
        });

        it('filters out empty tags', async () => {
            mockHandleItemSearchByTopicRequest.mockResolvedValue({
                type: 'item_search_by_topic',
                items: [makeSearchResultItem({
                    item: { tags: ['good', '', { tag: '' }, { name: 'also-good' }] },
                })],
            });

            const result = await callTool(endpoint, 'search_by_topic', { topic_query: 'test' });
            const data = JSON.parse(result.content[0].text);

            expect(data.results[0].tags).toEqual(['good', 'also-good']);
        });
    });
});

// =============================================================================
// Bridge script utilities
// =============================================================================

describe('MCP bridge script utilities', () => {
    it('getMcpBridgeScriptPath returns path in Zotero data directory', () => {
        const path = getMcpBridgeScriptPath();
        expect(path).toContain('beaver-mcp-stdio.mjs');
    });

    it('ensureMcpBridgeScript writes script and returns path', async () => {
        const mockIOUtils = (globalThis as any).IOUtils as { writeUTF8: ReturnType<typeof vi.fn> };
        mockIOUtils.writeUTF8.mockClear();
        mockIOUtils.writeUTF8.mockResolvedValue(undefined);

        const path = await ensureMcpBridgeScript();

        expect(path).toContain('beaver-mcp-stdio.mjs');
        expect(mockIOUtils.writeUTF8).toHaveBeenCalledOnce();

        const writtenContent = mockIOUtils.writeUTF8.mock.calls[0][1];
        expect(writtenContent).toContain('#!/usr/bin/env node');
        expect(writtenContent).toContain('/beaver/mcp');
        expect(writtenContent).toContain('JSON.parse');
    });
});
