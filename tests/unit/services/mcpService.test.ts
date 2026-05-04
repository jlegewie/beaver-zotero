/**
 * Unit tests for MCPService (src/services/mcpService.ts)
 *
 * Tests the JSON-RPC 2.0 dispatch, tool registration, auth gating,
 * and MCP protocol responses (initialize, tools/list, tools/call, ping).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MCPService } from '../../../src/services/mcpService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Zotero-style requestData wrapping a JSON-RPC body. */
function makeRequest(body: any): any {
    return {
        method: 'POST',
        pathname: '/beaver/mcp',
        pathParams: {},
        searchParams: new URLSearchParams(),
        headers: new Headers(),
        data: body,
    };
}

/** Parse the JSON-RPC response tuple [status, contentType, body]. */
function parseResponse(tuple: [number, string, string]) {
    const [status, contentType, body] = tuple;
    return { status, contentType, body: body ? JSON.parse(body) : null };
}

/** Convenience: send a JSON-RPC request and parse the response. */
async function rpc(service: MCPService, body: any) {
    // Access the private handleRequest method via the register + endpoint pattern
    // Instead, we expose it via the Zotero endpoint. Let's call it directly.
    const result = await (service as any).handleRequest(makeRequest(body));
    return parseResponse(result);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCPService', () => {
    let service: MCPService;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new MCPService();
    });

    // =====================================================================
    // Tool registration
    // =====================================================================

    describe('registerTool', () => {
        it('registers a tool that appears in tools/list', async () => {
            const handler = vi.fn().mockResolvedValue('ok');
            service.registerTool('my_tool', {
                name: 'my_tool',
                description: 'A test tool',
                inputSchema: { type: 'object', properties: {} },
            }, handler);

            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'tools/list',
                id: 1,
            });

            expect(res.status).toBe(200);
            expect(res.body.result.tools).toHaveLength(1);
            expect(res.body.result.tools[0]).toEqual({
                name: 'my_tool',
                description: 'A test tool',
                inputSchema: { type: 'object', properties: {} },
            });
        });

        it('overwrites a tool with the same name', async () => {
            service.registerTool('t', {
                name: 't',
                description: 'v1',
                inputSchema: {},
            }, vi.fn());

            service.registerTool('t', {
                name: 't',
                description: 'v2',
                inputSchema: {},
            }, vi.fn());

            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'tools/list',
                id: 1,
            });

            expect(res.body.result.tools).toHaveLength(1);
            expect(res.body.result.tools[0].description).toBe('v2');
        });

        it('supports multiple registered tools', async () => {
            for (let i = 0; i < 5; i++) {
                service.registerTool(`tool_${i}`, {
                    name: `tool_${i}`,
                    description: `Tool ${i}`,
                    inputSchema: {},
                }, vi.fn());
            }

            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'tools/list',
                id: 1,
            });

            expect(res.body.result.tools).toHaveLength(5);
            const names = res.body.result.tools.map((t: any) => t.name);
            expect(names).toEqual(['tool_0', 'tool_1', 'tool_2', 'tool_3', 'tool_4']);
        });
    });

    // =====================================================================
    // JSON-RPC parsing & validation
    // =====================================================================

    describe('JSON-RPC parsing', () => {
        it('returns parse error for invalid JSON string', async () => {
            const result = await (service as any).handleRequest({
                ...makeRequest(null),
                data: 'not json{',
            });
            const res = parseResponse(result);

            expect(res.status).toBe(200);
            expect(res.body.error.code).toBe(-32700);
            expect(res.body.error.message).toBe('Parse error');
        });

        it('returns invalid request when jsonrpc is not 2.0', async () => {
            const res = await rpc(service, {
                jsonrpc: '1.0',
                method: 'ping',
                id: 1,
            });

            expect(res.body.error.code).toBe(-32600);
            expect(res.body.error.message).toBe('Invalid Request');
        });

        it('returns invalid request when method is missing', async () => {
            const res = await rpc(service, {
                jsonrpc: '2.0',
                id: 1,
            });

            expect(res.body.error.code).toBe(-32600);
        });

        it('handles pre-parsed object data (not string)', async () => {
            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'ping',
                id: 1,
            });

            expect(res.status).toBe(200);
            expect(res.body.result).toEqual({});
        });

        it('handles string data that is valid JSON', async () => {
            const result = await (service as any).handleRequest({
                ...makeRequest(null),
                data: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 42 }),
            });
            const res = parseResponse(result);

            expect(res.body.id).toBe(42);
            expect(res.body.result).toEqual({});
        });
    });

    // =====================================================================
    // Notifications (no id)
    // =====================================================================

    describe('notifications', () => {
        it('returns 202 for notification with no id field', async () => {
            const result = await (service as any).handleRequest(
                makeRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }),
            );

            expect(result[0]).toBe(202);
            expect(result[2]).toBe('');
        });

        it('returns 202 for notification with null id', async () => {
            const result = await (service as any).handleRequest(
                makeRequest({ jsonrpc: '2.0', method: 'notifications/initialized', id: null }),
            );

            expect(result[0]).toBe(202);
        });
    });

    // =====================================================================
    // initialize
    // =====================================================================

    describe('initialize', () => {
        it('returns protocol version, capabilities, and server info', async () => {
            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'initialize',
                id: 1,
            });

            expect(res.status).toBe(200);
            expect(res.body.id).toBe(1);
            expect(res.body.result.protocolVersion).toBe('2024-11-05');
            expect(res.body.result.capabilities).toEqual({ tools: {} });
            expect(res.body.result.serverInfo.name).toBe('beaver-zotero');
            expect(res.body.result.serverInfo.version).toBe('1.0.0');
        });

        it('returns instructions string', async () => {
            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'initialize',
                id: 1,
            });

            expect(res.body.result.instructions).toContain('Zotero reference library');
            expect(res.body.result.instructions).toContain('search_by_topic');
            expect(res.body.result.instructions).toContain('Citations');
        });
    });

    // =====================================================================
    // ping
    // =====================================================================

    describe('ping', () => {
        it('returns empty object', async () => {
            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'ping',
                id: 'abc',
            });

            expect(res.body.result).toEqual({});
            expect(res.body.id).toBe('abc');
        });

        it('preserves numeric id', async () => {
            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'ping',
                id: 99,
            });

            expect(res.body.id).toBe(99);
        });
    });

    // =====================================================================
    // tools/list
    // =====================================================================

    describe('tools/list', () => {
        it('returns empty tools array when no tools registered', async () => {
            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'tools/list',
                id: 1,
            });

            expect(res.body.result.tools).toEqual([]);
        });

        it('returns tool definitions without handler details', async () => {
            service.registerTool('search', {
                name: 'search',
                description: 'Search things',
                inputSchema: {
                    type: 'object',
                    properties: { query: { type: 'string' } },
                    required: ['query'],
                },
            }, vi.fn());

            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'tools/list',
                id: 1,
            });

            const tool = res.body.result.tools[0];
            expect(tool.name).toBe('search');
            expect(tool.inputSchema.required).toEqual(['query']);
            // handler should NOT leak into the response
            expect(tool.handler).toBeUndefined();
        });
    });

    // =====================================================================
    // tools/call
    // =====================================================================

    describe('tools/call', () => {
        it('calls the registered handler with arguments', async () => {
            const handler = vi.fn().mockResolvedValue('hello world');
            service.registerTool('greet', {
                name: 'greet',
                description: 'Greet',
                inputSchema: {},
            }, handler);

            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 'greet', arguments: { name: 'Alice' } },
                id: 1,
            });

            expect(handler).toHaveBeenCalledWith({ name: 'Alice' });
            expect(res.body.result.content[0].text).toBe('hello world');
        });

        it('passes empty object when arguments are omitted', async () => {
            const handler = vi.fn().mockResolvedValue('ok');
            service.registerTool('t', { name: 't', description: '', inputSchema: {} }, handler);

            await rpc(service, {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 't' },
                id: 1,
            });

            expect(handler).toHaveBeenCalledWith({});
        });

        it('returns error for missing tool name', async () => {
            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {},
                id: 1,
            });

            expect(res.body.error.code).toBe(-32603);
            expect(res.body.error.message).toContain('Missing tool name');
        });

        it('returns error for unknown tool', async () => {
            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 'nonexistent' },
                id: 1,
            });

            expect(res.body.error.code).toBe(-32603);
            expect(res.body.error.message).toContain('Unknown tool: nonexistent');
        });

        it('wraps string result in MCP content array', async () => {
            service.registerTool('t', { name: 't', description: '', inputSchema: {} },
                vi.fn().mockResolvedValue('plain text'));

            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 't' },
                id: 1,
            });

            expect(res.body.result).toEqual({
                content: [{ type: 'text', text: 'plain text' }],
            });
        });

        it('passes through MCP-shaped content from handler', async () => {
            const mcpResult = {
                content: [{ type: 'text', text: 'already formatted' }],
                isError: false,
            };
            service.registerTool('t', { name: 't', description: '', inputSchema: {} },
                vi.fn().mockResolvedValue(mcpResult));

            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 't' },
                id: 1,
            });

            expect(res.body.result).toEqual(mcpResult);
        });

        it('JSON-serializes non-string, non-MCP results', async () => {
            service.registerTool('t', { name: 't', description: '', inputSchema: {} },
                vi.fn().mockResolvedValue({ items: [1, 2, 3], count: 3 }));

            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 't' },
                id: 1,
            });

            const parsed = JSON.parse(res.body.result.content[0].text);
            expect(parsed).toEqual({ items: [1, 2, 3], count: 3 });
        });

        it('returns handler errors as JSON-RPC errors', async () => {
            service.registerTool('t', { name: 't', description: '', inputSchema: {} },
                vi.fn().mockRejectedValue(new Error('handler boom')));

            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 't' },
                id: 1,
            });

            expect(res.body.error.code).toBe(-32603);
            expect(res.body.error.message).toBe('handler boom');
        });

        it('handles non-Error throws gracefully', async () => {
            service.registerTool('t', { name: 't', description: '', inputSchema: {} },
                vi.fn().mockRejectedValue('string error'));

            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 't' },
                id: 1,
            });

            expect(res.body.error.message).toBe('string error');
        });
    });

    // =====================================================================
    // Auth check
    // =====================================================================

    describe('auth check', () => {
        it('blocks tools/call when auth check returns false', async () => {
            service.setAuthCheck(() => false);
            service.registerTool('t', { name: 't', description: '', inputSchema: {} },
                vi.fn().mockResolvedValue('ok'));

            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 't' },
                id: 1,
            });

            // Auth failure returns MCP-level error, not JSON-RPC error
            expect(res.body.result.isError).toBe(true);
            expect(res.body.result.content[0].text).toContain('not logged into Beaver');
        });

        it('allows tools/call when auth check returns true', async () => {
            service.setAuthCheck(() => true);
            service.registerTool('t', { name: 't', description: '', inputSchema: {} },
                vi.fn().mockResolvedValue('success'));

            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 't' },
                id: 1,
            });

            expect(res.body.result.content[0].text).toBe('success');
        });

        it('allows tools/call when no auth check is set', async () => {
            service.registerTool('t', { name: 't', description: '', inputSchema: {} },
                vi.fn().mockResolvedValue('no auth check'));

            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 't' },
                id: 1,
            });

            expect(res.body.result.content[0].text).toBe('no auth check');
        });

        it('does not block initialize when auth fails', async () => {
            service.setAuthCheck(() => false);

            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'initialize',
                id: 1,
            });

            expect(res.body.result.protocolVersion).toBe('2024-11-05');
        });

        it('does not block tools/list when auth fails', async () => {
            service.setAuthCheck(() => false);

            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'tools/list',
                id: 1,
            });

            expect(res.body.result.tools).toBeDefined();
        });
    });

    // =====================================================================
    // Unknown method
    // =====================================================================

    describe('unknown method', () => {
        it('returns method-not-found error', async () => {
            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'resources/list',
                id: 1,
            });

            expect(res.body.error.code).toBe(-32603);
            expect(res.body.error.message).toContain('Method not found');
        });
    });

    // =====================================================================
    // register / unregister
    // =====================================================================

    describe('register', () => {
        it('returns false when Zotero.Server.Endpoints is not available', () => {
            const zotero = (globalThis as any).Zotero;
            const origServer = zotero.Server;
            delete zotero.Server;

            const result = service.register();
            expect(result).toBe(false);

            zotero.Server = origServer;
        });

        it('registers endpoint on Zotero.Server.Endpoints', () => {
            const zotero = (globalThis as any).Zotero;
            zotero.Server = { Endpoints: {} };

            const result = service.register();
            expect(result).toBe(true);
            expect(zotero.Server.Endpoints['/beaver/mcp']).toBeDefined();

            // Cleanup
            delete zotero.Server;
        });

        it('unregister removes the endpoint', () => {
            const zotero = (globalThis as any).Zotero;
            zotero.Server = { Endpoints: {} };

            service.register();
            expect(zotero.Server.Endpoints['/beaver/mcp']).toBeDefined();

            service.unregister();
            expect(zotero.Server.Endpoints['/beaver/mcp']).toBeUndefined();

            delete zotero.Server;
        });

        it('unregister is safe to call when not registered', () => {
            const zotero = (globalThis as any).Zotero;
            zotero.Server = { Endpoints: {} };

            // Should not throw
            service.unregister();

            delete zotero.Server;
        });

        it('unregister is safe when Zotero.Server is unavailable', () => {
            // Should not throw
            service.unregister();
        });
    });

    // =====================================================================
    // JSON-RPC response format
    // =====================================================================

    describe('response format', () => {
        it('success responses have correct JSON-RPC structure', async () => {
            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'ping',
                id: 123,
            });

            expect(res.status).toBe(200);
            expect(res.contentType).toBe('application/json');
            expect(res.body.jsonrpc).toBe('2.0');
            expect(res.body.id).toBe(123);
            expect(res.body.result).toBeDefined();
            expect(res.body.error).toBeUndefined();
        });

        it('error responses have correct JSON-RPC structure', async () => {
            const res = await rpc(service, {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: 'nonexistent' },
                id: 456,
            });

            expect(res.status).toBe(200);
            expect(res.contentType).toBe('application/json');
            expect(res.body.jsonrpc).toBe('2.0');
            expect(res.body.id).toBe(456);
            expect(res.body.error).toBeDefined();
            expect(res.body.error.code).toBeTypeOf('number');
            expect(res.body.error.message).toBeTypeOf('string');
        });

        it('error responses for parse errors have null id', async () => {
            const result = await (service as any).handleRequest({
                ...makeRequest(null),
                data: '{bad json',
            });
            const res = parseResponse(result);

            expect(res.body.id).toBeNull();
        });
    });
});
