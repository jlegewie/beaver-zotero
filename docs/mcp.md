# Beaver MCP Server

Beaver exposes an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server on Zotero's built-in HTTP server. This lets any MCP-compatible client (Claude Code, Claude Desktop, Cursor, etc.) call Beaver tools — like searching your Zotero library by topic — directly from an AI coding or writing tool.

## Architecture

### Transport

The MCP server uses **Streamable HTTP** transport: a single `POST` endpoint at `/beaver/mcp` speaking JSON-RPC 2.0. This runs on Zotero's existing HTTP server (default port 23119, but check `extensions.zotero.httpServer.port` in your Zotero config).

**Why not stdio?** Zotero's gecko runtime can't use `@modelcontextprotocol/sdk` (Node.js APIs). Spawning a child Node.js process adds complexity and requires Node.js on the user's system. The MCP JSON-RPC 2.0 protocol is simple enough to implement manually.

**Why not reuse the REST endpoints in `useHttpEndpoints.ts`?** Those are REST endpoints. MCP clients need JSON-RPC 2.0 with `initialize`, `tools/list`, `tools/call` methods.

### Code Layout

| File | Bundle | Purpose |
|------|--------|---------|
| `src/services/mcpService.ts` | esbuild (imported by webpack) | MCP protocol engine: JSON-RPC 2.0 dispatch, tool registry, Zotero endpoint registration |
| `react/hooks/useMcpServer.ts` | webpack | React hook: reads pref, registers tools with handlers, manages lifecycle |
| `react/index.tsx` | webpack | Mounts `useMcpServer()` in `GlobalContextInitializer` |
| `addon/prefs.js` | N/A | `mcpServerEnabled` preference (default: `false`) |

### How It Works

1. `GlobalContextInitializer` calls `useMcpServer()` on mount.
2. The hook reads the `mcpServerEnabled` preference. If `false`, it returns immediately.
3. When enabled, it creates an `MCPService` instance, registers tools with their handlers, sets up auth checking, and calls `service.register()` to mount the `/beaver/mcp` endpoint.
4. MCP clients send JSON-RPC 2.0 requests. The service dispatches to `initialize`, `tools/list`, or `tools/call`.
5. `tools/call` checks Beaver authentication first. If the user isn't logged in, it returns an `isError: true` response telling the model to ask the user to sign in.
6. On unmount, the hook calls `service.unregister()` to remove the endpoint.

### Authentication

- `initialize`, `tools/list`, and `ping` work **without** authentication (so MCP clients can connect and discover tools).
- `tools/call` requires the user to be **logged into Beaver**. If not, the tool returns an MCP error content block:
  > "Error: User is not logged into Beaver. Please open Zotero and sign in to Beaver before using this tool."

The auth check reads `isAuthenticatedAtom` from the shared Jotai store at call time (not at registration time), so it reflects the current auth state.

### Bundle Considerations

`mcpService.ts` lives in `src/` (esbuild bundle) but is imported by `useMcpServer.ts` (webpack bundle). This is fine because webpack resolves `src/` imports. The service uses `Zotero.Beaver?.xxx` (not `addon.xxx`) since it runs in the webpack context at runtime. See `CLAUDE.md` for the full explanation of the two-bundle architecture.

## Client Configuration

### Claude Code

Add to your project's `.mcp.json` or `~/.claude.json`:

```json
{
  "mcpServers": {
    "beaver-zotero": {
      "type": "streamable-http",
      "url": "http://localhost:PORT/beaver/mcp"
    }
  }
}
```

Replace `PORT` with your Zotero HTTP server port (check `extensions.zotero.httpServer.port` in Zotero's Config Editor, default is `23119`).

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "beaver-zotero": {
      "type": "streamable-http",
      "url": "http://localhost:PORT/beaver/mcp"
    }
  }
}
```

### Claude Desktop / Other stdio-only clients

These clients require stdio transport. Use `mcp-remote` as a bridge:

```json
{
  "mcpServers": {
    "beaver-zotero": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:PORT/beaver/mcp"]
    }
  }
}
```

## Enabling the Server

The MCP server is **off by default**. To enable it:

1. In Zotero, go to **Settings > Advanced > Config Editor**
2. Search for `extensions.zotero.beaver.mcpServerEnabled`
3. Set it to `true`
4. Restart Zotero

## Testing

```bash
# Check if the endpoint is alive (replace PORT)
curl -X POST http://localhost:PORT/beaver/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1}'

# List available tools
curl -X POST http://localhost:PORT/beaver/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":2}'

# Semantic search
curl -X POST http://localhost:PORT/beaver/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search_by_topic","arguments":{"topic_query":"machine learning"}},"id":3}'

# Metadata search
curl -X POST http://localhost:PORT/beaver/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search_by_metadata","arguments":{"author_query":"Acemoglu"}},"id":4}'

# Read attachment
curl -X POST http://localhost:PORT/beaver/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"read_attachment","arguments":{"attachment_id":"1-ABC12345","start_page":1,"end_page":5}},"id":5}'

# Get item details
curl -X POST http://localhost:PORT/beaver/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_item_details","arguments":{"item_ids":["1-ABC12345"],"include_attachments":true}},"id":6}'

# List collections
curl -X POST http://localhost:PORT/beaver/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_collections","arguments":{}},"id":7}'

# List tags
curl -X POST http://localhost:PORT/beaver/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_tags","arguments":{"min_item_count":3}},"id":8}'

# List items in a collection
curl -X POST http://localhost:PORT/beaver/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_items","arguments":{"collection":"DEF456","sort_by":"year","sort_order":"desc"}},"id":9}'
```

## Available Tools

All tools that accept or return item/attachment IDs use the `<library_id>-<zotero_key>` format (e.g., `1-ABC12345`).

### `search_by_topic`

Semantic (meaning-based) search across the user's Zotero library. The most important tool for research discovery.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `topic_query` | `string` | Yes | Concise topic phrase (2-8 words). Use canonical academic terms. |
| `author_filter` | `string[]` | No | Author last names (OR logic). |
| `min_year` | `integer` | No | Earliest publication year (inclusive). |
| `max_year` | `integer` | No | Latest publication year (inclusive). |
| `libraries_filter` | `string[]` | No | Library names or IDs. |
| `tags_filter` | `string[]` | No | Tags (OR logic). |
| `collections_filter` | `string[]` | No | Collection names or keys. |
| `limit` | `integer` | No | Max results per page (default 5, max 25). |
| `offset` | `integer` | No | Results to skip for pagination (default 0). |

**Response**: JSON with `has_more`, `next_offset`, and `results[]`. Each result has `item_id`, `item_type`, `title`, `authors`, `year`, `publication`, `similarity`, `abstract` (truncated ~300 chars), `tags`, and `attachments[]` (with `attachment_id`, `filename`, `page_count`, `status`).

**Underlying handler**: `handleItemSearchByTopicRequest` from `src/services/agentDataProvider/`.

---

### `search_by_metadata`

Find specific papers when you know bibliographic details (author name, title keywords, journal). At least one of `author_query`, `title_query`, or `publication_query` is required.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `author_query` | `string` | No* | Author's last name to search for. |
| `title_query` | `string` | No* | Keyword or phrase from the title. |
| `publication_query` | `string` | No* | Journal or publication name. |
| `min_year` | `integer` | No | Earliest publication year (inclusive). |
| `max_year` | `integer` | No | Latest publication year (inclusive). |
| `libraries_filter` | `string[]` | No | Library names or IDs. |
| `tags_filter` | `string[]` | No | Tags (OR logic). |
| `collections_filter` | `string[]` | No | Collection names or keys. |
| `limit` | `integer` | No | Max results per page (default 5, max 25). |
| `offset` | `integer` | No | Results to skip for pagination (default 0). |

**Response**: JSON with `has_more`, `next_offset`, and `results[]`. Same structure as `search_by_topic` but without the `similarity` field.

**Underlying handler**: `handleItemSearchByMetadataRequest` from `src/services/agentDataProvider/`.

---

### `read_attachment`

Read the text content of a PDF attachment from the user's Zotero library. Maximum 30 pages per request.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `attachment_id` | `string` | Yes | Attachment ID in `<library_id>-<zotero_key>` format. |
| `start_page` | `integer` | No | Starting page number (1-indexed). Default: 1. |
| `end_page` | `integer` | No | Ending page number (inclusive). Default: last page (up to 30). |

**Response**: Plain text with page content wrapped in `<pageN>...</pageN>` XML tags. Includes a header with attachment ID, total page count, and the page range shown.

**Underlying handler**: `handleZoteroAttachmentPagesRequest` from `src/services/agentDataProvider/`.

---

### `get_item_details`

Retrieve full Zotero metadata for one or more items.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `item_ids` | `string[]` | Yes | Item IDs in `<library_id>-<zotero_key>` format. Maximum 25 items. |
| `include_attachments` | `boolean` | No | Include attachment metadata. Default: false. |

**Response**: JSON with `items[]` (full Zotero metadata per item) and `not_found[]` (IDs that couldn't be found). When `include_attachments` is true, each item includes `attachments[]` with `attachment_id`, `filename`, `content_type`, `page_count`, and `status`.

**Underlying handler**: `handleGetMetadataRequest` from `src/services/agentDataProvider/`.

---

### `list_collections`

List collections (folders) in the user's Zotero library.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `library` | `string` | No | Library name or ID. Default: user's library. |
| `parent_collection` | `string` | No | Collection key to list subcollections within. |
| `include_item_counts` | `boolean` | No | Include item counts. Default: true. |
| `limit` | `integer` | No | Max results per page (default 50, max 100). |
| `offset` | `integer` | No | Results to skip for pagination (default 0). |

**Response**: JSON with `total_count`, `has_more`, `next_offset`, and `collections[]`. Each collection has `collection_key`, `name`, `item_count`, and `subcollection_count`.

**Underlying handler**: `handleListCollectionsRequest` from `src/services/agentDataProvider/`.

---

### `list_tags`

List tags in the user's Zotero library.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `library` | `string` | No | Library name or ID. Default: user's library. |
| `collection` | `string` | No | Collection key to list tags within. |
| `min_item_count` | `integer` | No | Minimum items a tag must have. Default: 1. |
| `limit` | `integer` | No | Max results per page (default 50, max 100). |
| `offset` | `integer` | No | Results to skip for pagination (default 0). |

**Response**: JSON with `total_count`, `has_more`, `next_offset`, and `tags[]`. Each tag has `name`, `item_count`, and optionally `color`.

**Underlying handler**: `handleListTagsRequest` from `src/services/agentDataProvider/`.

---

### `list_items`

Browse items in the library, optionally filtered by collection or tag.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `library` | `string` | No | Library name or ID. Default: user's library. |
| `collection` | `string` | No | Collection name or key. |
| `tag` | `string` | No | Tag to filter by. |
| `recursive` | `boolean` | No | Include subcollection items. Default: true. |
| `sort_by` | `string` | No | Sort field: "dateAdded", "dateModified", "title", "creator", "year". Default: "dateModified". |
| `sort_order` | `string` | No | "asc" or "desc". Default: "desc". |
| `limit` | `integer` | No | Max results per page (default 20, max 100). |
| `offset` | `integer` | No | Results to skip for pagination (default 0). |

**Response**: JSON with `total_count`, `has_more`, `next_offset`, and `items[]`. Each item has `item_id`, `item_type`, `title`, `authors`, `year`, `date_added`, `date_modified`. Note: does not include attachment IDs — use `get_item_details` to get those.

**Underlying handler**: `handleListItemsRequest` from `src/services/agentDataProvider/`.

---

## Adding a New Tool

Follow these steps to add a new MCP tool. The `item_search_by_topic` tool serves as the reference implementation.

### Step 1: Define the tool schema

In `react/hooks/useMcpServer.ts`, add a tool definition constant following the existing pattern:

```typescript
const MY_NEW_TOOL = {
    name: 'my_tool_name',
    description: 'Clear description of what the tool does. Written for an LLM to understand when to use it.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            required_param: {
                type: 'string',
                description: 'What this parameter is for.',
            },
            optional_param: {
                type: 'integer',
                description: 'Optional parameter with a default.',
                default: 10,
            },
        },
        required: ['required_param'],
    },
};
```

**Guidelines for tool definitions:**
- `name`: Use `snake_case`. Keep it short and descriptive.
- `description`: Write for an LLM. Explain *when* to use the tool, not just *what* it does. Include example queries if helpful.
- `inputSchema`: Standard JSON Schema. Always include `description` for every property. Set sensible `default` values for optional params.
- `required`: Only include parameters the tool cannot function without.

### Step 2: Write the handler function

Add an async handler function in `react/hooks/useMcpServer.ts` that:
1. Validates/clamps input arguments
2. Constructs the appropriate `WS*Request` object
3. Calls the existing agent data provider handler
4. Formats the response as a human-readable string

```typescript
async function handleMyTool(args: any): Promise<string> {
    const limit = Math.min(Math.max(1, args.optional_param ?? 10), 50);

    const wsRequest: WSMyToolRequest = {
        event: 'my_tool_request',
        request_id: generateRequestId(),
        required_param: args.required_param,
        // ... map all args
    };

    const response = await handleMyToolRequest(wsRequest);
    return formatMyToolResults(response);
}
```

**Key patterns:**
- **Clamp numeric inputs**: Always enforce min/max bounds on limit, offset, etc.
- **Reuse existing handlers**: The agent data provider handlers in `src/services/agentDataProvider/` already contain the business logic. The MCP handler is just a thin adapter.
- **Return strings**: MCP tool results are consumed by LLMs. Return formatted plain text, not raw JSON. Truncate long fields (e.g., abstracts > 300 chars).
- **Use `generateRequestId()`**: Each request needs a unique ID for the WS protocol layer.

### Step 3: Write a response formatter

Add a function that converts the `WS*Response` into human-readable text:

```typescript
function formatMyToolResults(response: WSMyToolResponse): string {
    if (!response.items || response.items.length === 0) {
        return 'No results found.';
    }
    // Build a numbered list with relevant fields
    // Truncate long text fields
    // Include identifiers (Zotero key, library ID) so the LLM can reference items
    return lines.join('\n');
}
```

### Step 4: Register the tool in the hook

In the `useMcpServer()` hook's `useEffect`, add a `registerTool` call:

```typescript
service.registerTool(
    MY_NEW_TOOL.name,
    MY_NEW_TOOL,
    handleMyTool,
);
```

### Step 5: Add imports

Import the handler and request/response types at the top of `useMcpServer.ts`:

```typescript
import { handleMyToolRequest } from '../../src/services/agentDataProvider';
import type { WSMyToolRequest, WSMyToolResponse } from '../../src/services/agentProtocol';
```

### Step 6: Update this document

Add the new tool to the [Available Tools](#available-tools) section above.

### Checklist

- [ ] Tool definition with clear `description` and JSON Schema `inputSchema`
- [ ] Handler function that maps MCP args to `WS*Request` and calls existing handler
- [ ] Response formatter that returns human-readable text (not raw JSON)
- [ ] Tool registered in `useMcpServer()` hook
- [ ] Imports added for handler and types
- [ ] TypeScript compiles cleanly (`npx tsc --noEmit`)
- [ ] Tested with `curl` against the endpoint
- [ ] This document updated with the new tool
