/**
 * MCP (Model Context Protocol) Service
 *
 * Implements MCP's Streamable HTTP transport on Zotero's built-in HTTP server
 * at /beaver/mcp. Handles JSON-RPC 2.0 messages for initialize, tools/list,
 * and tools/call methods.
 *
 * This file lives in the esbuild bundle but is imported by the webpack bundle
 * (via useMcpServer hook). Use `Zotero.Beaver?.xxx` instead of `addon.xxx`.
 */

import { logger } from '../utils/logger';

// =============================================================================
// Types
// =============================================================================

interface JsonRpcRequest {
    jsonrpc: '2.0';
    method: string;
    params?: any;
    id?: string | number | null;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: string | number | null;
    result?: any;
    error?: { code: number; message: string; data?: any };
}

interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, any>;
}

interface McpToolEntry {
    definition: McpToolDefinition;
    handler: (args: any) => Promise<any>;
}

interface ZoteroRequestData {
    method: string;
    pathname: string;
    pathParams: Record<string, string>;
    searchParams: URLSearchParams;
    headers: Headers;
    data: any;
}

// MCP protocol version with widest client support
const MCP_PROTOCOL_VERSION = '2024-11-05';

// =============================================================================
// MCP Service
// =============================================================================

export class MCPService {
    private tools: Map<string, McpToolEntry> = new Map();
    private registered = false;
    private authCheck: (() => boolean) | null = null;

    /**
     * Set a callback that returns whether the user is authenticated.
     * When set, tools/call will return an error if the user is logged out.
     */
    setAuthCheck(check: () => boolean): void {
        this.authCheck = check;
    }

    /**
     * Register a tool that MCP clients can call.
     */
    registerTool(
        name: string,
        definition: McpToolDefinition,
        handler: (args: any) => Promise<any>,
    ): void {
        this.tools.set(name, { definition, handler });
    }

    /**
     * Register the /beaver/mcp endpoint on Zotero's HTTP server.
     */
    register(): boolean {
        if (!Zotero?.Server?.Endpoints) {
            logger('MCPService: Zotero.Server.Endpoints not available', 2);
            return false;
        }

        const service = this;

        // Zotero endpoint constructor pattern (same as useHttpEndpoints)
        const Endpoint = function (this: any) {} as any;
        Endpoint.prototype = {
            supportedMethods: ['POST'],
            supportedDataTypes: ['application/json'],

            async init(requestData: ZoteroRequestData): Promise<[number, string, string]> {
                return service.handleRequest(requestData);
            },
        };

        Zotero.Server.Endpoints['/beaver/mcp'] = Endpoint;
        this.registered = true;
        logger(`MCPService: Registered /beaver/mcp endpoint with ${this.tools.size} tools`, 3);
        return true;
    }

    /**
     * Unregister the endpoint.
     */
    unregister(): void {
        if (!Zotero?.Server?.Endpoints) return;

        if (Zotero.Server.Endpoints['/beaver/mcp']) {
            delete Zotero.Server.Endpoints['/beaver/mcp'];
        }
        this.registered = false;
        logger('MCPService: Unregistered /beaver/mcp endpoint', 3);
    }

    // =========================================================================
    // Request handling
    // =========================================================================

    private async handleRequest(
        requestData: ZoteroRequestData,
    ): Promise<[number, string, string]> {
        let body: JsonRpcRequest;
        try {
            body = typeof requestData.data === 'string'
                ? JSON.parse(requestData.data)
                : requestData.data;
        } catch {
            return this.jsonRpcError(null, -32700, 'Parse error');
        }

        if (body.jsonrpc !== '2.0' || !body.method) {
            return this.jsonRpcError(body.id ?? null, -32600, 'Invalid Request');
        }

        // Notification (no id) → acknowledge with 202
        if (body.id === undefined || body.id === null) {
            return [202, 'application/json', ''];
        }

        try {
            const result = await this.dispatch(body);
            return this.jsonRpcSuccess(body.id, result);
        } catch (err: any) {
            const message = err instanceof Error ? err.message : String(err);
            logger(`MCPService: Error handling ${body.method}: ${message}`, 1);
            return this.jsonRpcError(body.id, -32603, message);
        }
    }

    private async dispatch(request: JsonRpcRequest): Promise<any> {
        switch (request.method) {
            case 'initialize':
                return this.handleInitialize();

            case 'tools/list':
                return this.handleToolsList();

            case 'tools/call':
                return this.handleToolsCall(request.params);

            // ping
            case 'ping':
                return {};

            default:
                throw Object.assign(
                    new Error(`Method not found: ${request.method}`),
                    { code: -32601 },
                );
        }
    }

    // =========================================================================
    // MCP method handlers
    // =========================================================================

    private handleInitialize() {
        return {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
                tools: {},
            },
            serverInfo: {
                name: 'beaver-zotero',
                version: '1.0.0',
            },
        };
    }

    private handleToolsList() {
        const tools = Array.from(this.tools.values()).map(({ definition }) => ({
            name: definition.name,
            description: definition.description,
            inputSchema: definition.inputSchema,
        }));
        return { tools };
    }

    private async handleToolsCall(params: any) {
        // Check authentication before executing any tool
        if (this.authCheck && !this.authCheck()) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: User is not logged into Beaver. Please open Zotero and sign in to Beaver before using this tool.',
                }],
                isError: true,
            };
        }

        if (!params?.name) {
            throw new Error('Missing tool name');
        }

        const entry = this.tools.get(params.name);
        if (!entry) {
            throw new Error(`Unknown tool: ${params.name}`);
        }

        const args = params.arguments ?? {};
        const result = await entry.handler(args);

        // MCP tools/call must return { content: [...] }
        if (typeof result === 'string') {
            return { content: [{ type: 'text', text: result }] };
        }

        // If handler already returned MCP-shaped content, pass through
        if (result && Array.isArray(result.content)) {
            return result;
        }

        // Default: JSON-serialize the result
        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
    }

    // =========================================================================
    // JSON-RPC helpers
    // =========================================================================

    private jsonRpcSuccess(
        id: string | number | null,
        result: any,
    ): [number, string, string] {
        const response: JsonRpcResponse = { jsonrpc: '2.0', id, result };
        return [200, 'application/json', JSON.stringify(response)];
    }

    private jsonRpcError(
        id: string | number | null,
        code: number,
        message: string,
    ): [number, string, string] {
        const response: JsonRpcResponse = {
            jsonrpc: '2.0',
            id,
            error: { code, message },
        };
        return [200, 'application/json', JSON.stringify(response)];
    }
}
