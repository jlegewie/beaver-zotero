# Beaver MCP Server

Beaver exposes an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server on Zotero's built-in HTTP server. This lets any MCP-compatible client (Claude Code, Claude Desktop, Cursor, etc.) call Beaver tools — like searching your Zotero library by topic — directly from an AI coding or writing tool.

## Architecture

### Transport

The MCP server uses **Streamable HTTP** transport: a single `POST` endpoint at `/beaver/mcp` speaking JSON-RPC 2.0. This runs on Zotero's existing HTTP server (default port 23119, but check `extensions.zotero.httpServer.port` in your Zotero config).

This is a **stateless POST-only subset** of Streamable HTTP. Each request gets a plain `application/json` JSON-RPC response; the server never opens a Server-Sent Events (SSE) stream. The optional server→client SSE channel (a `GET` on the same endpoint) is not offered — a `GET` returns `405 Method Not Allowed`, which spec-compliant clients treat as "no stream available". Tool calls are unaffected since they ride on `POST` request/response.

**Why not stdio?** Zotero's gecko runtime can't use `@modelcontextprotocol/sdk` (Node.js APIs). Spawning a child Node.js process adds complexity and requires Node.js on the user's system. The MCP JSON-RPC 2.0 protocol is simple enough to implement manually.

**Why not reuse the REST endpoints in `useHttpEndpoints.ts`?** Those are REST endpoints. MCP clients need JSON-RPC 2.0 with `initialize`, `tools/list`, `tools/call` methods.

### Code Layout

| File | Bundle | Purpose |
|------|--------|---------|
| `src/services/mcpService.ts` | esbuild (imported by webpack) | MCP protocol engine: JSON-RPC 2.0 dispatch, tool registry, Zotero endpoint registration |
| `react/hooks/useMcpServer.ts` | webpack | React hook: reads pref, registers tools with handlers, manages lifecycle |
| `react/hooks/mcp/libraryAnnotationTools.ts` | webpack | Library and annotation tool schemas, validation, and adapters |
| `react/index.tsx` | webpack | Mounts `useMcpServer()` in `GlobalContextInitializer` |
| `addon/prefs.js` | N/A | `mcpServerEnabled` and `mcpCreateNoteToolEnabled` preferences (both default: `false`) |

### How It Works

1. `GlobalContextInitializer` calls `useMcpServer()` on mount.
2. The hook reads the `mcpServerEnabled` preference. If `false`, it returns immediately.
3. When enabled, it creates an `MCPService` instance, registers tools with their handlers, sets up auth checking, and calls `service.register()` to mount the `/beaver/mcp` endpoint. Mutating tools are registered only when `mcpCreateNoteToolEnabled` is `true`, so they are neither advertised nor callable otherwise. That key gates every write tool; it keeps its original name so users who already opted in stay opted in.
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
      "type": "http",
      "url": "http://localhost:PORT/beaver/mcp"
    }
  }
}
```

Replace `PORT` with your Zotero HTTP server port (check `extensions.zotero.httpServer.port` in Zotero's Config Editor, default is `23119`).

> **`http` vs `streamable-http`**: Both name the same MCP Streamable HTTP transport. `http` is the value VS Code, Claude Code, and recent Cursor all accept; `streamable-http` is the spec's longer name and works as an alias on clients that recognize it (e.g. Claude Code). Prefer `http`. Some clients can also infer the transport from `url` alone and let you omit `type`.

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "beaver-zotero": {
      "type": "http",
      "url": "http://localhost:PORT/beaver/mcp"
    }
  }
}
```

> Some clients log a one-time `Failed to open SSE stream` warning on connect. This is expected — Beaver doesn't offer the optional SSE stream and returns `405` for it. Tool discovery and tool calls still work over `POST`, so the warning is safe to ignore.

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

# Read note
curl -X POST http://localhost:PORT/beaver/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"read_note","arguments":{"note_id":"1-ABC12345","offset":1,"limit":50}},"id":6}'

# Create note
curl -X POST http://localhost:PORT/beaver/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"create_note","arguments":{"title":"Short note","content":"A claim. <citation id=\"1-ABC12345\" loc=\"page5\"/>","parent_id":"1-DEF67890"}},"id":7}'

# Get item details
curl -X POST http://localhost:PORT/beaver/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_item_details","arguments":{"item_ids":["1-ABC12345"],"include_attachments":true}},"id":8}'

# List collections
curl -X POST http://localhost:PORT/beaver/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_collections","arguments":{}},"id":9}'

# List tags
curl -X POST http://localhost:PORT/beaver/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_tags","arguments":{"min_item_count":3}},"id":10}'

# List items in a collection
curl -X POST http://localhost:PORT/beaver/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_items","arguments":{"collection":"DEF456","sort_by":"year","sort_order":"desc"}},"id":11}'
```

## Available Tools

Item and attachment IDs use portable library references (e.g. `u-ABC12345` or `g12345-ABC12345`). Legacy numeric IDs such as `1-ABC12345` are also accepted.

### `search_by_topic`

Semantic (meaning-based) search across the user's Zotero library. The most important tool for research discovery.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `topic_query` | `string` | Yes | Concise topic phrase (2-8 words). Use canonical academic terms. |
| `author_filter` | `string[]` | No | Creator names (first, last, full, or institutional) (OR logic). |
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
| `author_query` | `string` | No* | Creator name tokens (first, last, full, or institutional); case-insensitive within one creator. |
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

Read supported attachment text from the user's Zotero library. Maximum 30 pages per request; EPUB page windows use extraction pages, not section ordinals.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `attachment_id` | `string` | Yes | Attachment ID in `<library_id>-<zotero_key>` format. |
| `start_page` | `integer` | No | Starting page number (1-indexed). Default: 1. |
| `end_page` | `integer` | No | Ending page number (inclusive). Default: last page (up to 30). |
| `include_annotation_locations` | `boolean` | No | Return structured source passages and copyable annotation locators. Default: false. |

**Response**: With `include_annotation_locations=true`, JSON discriminated by `content_kind`: PDF uses `pages[].passages[]`, while EPUB and snapshots use `passages[]`. Otherwise, plain text with page content wrapped in `<pageN>...</pageN>` XML tags. Includes a header with attachment ID, total page count, and the page range shown.

**Underlying handler**: `handleZoteroDocumentRequest` from `src/services/agentDataProvider/`, sliced to the requested page window.

---

### `read_note`

Read a Zotero note as simplified HTML. Citation, annotation, and image nodes are represented as compact self-closing tags.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `note_id` | `string` | Yes | Note ID in `<library_id>-<zotero_key>` format. Get this from `get_item_details` with `include_notes: true`, search, or `list_items` with note categories. |
| `offset` | `integer` | No | 1-indexed start line for paging through long notes. |
| `limit` | `integer` | No | Maximum number of lines to return. |

**Response**: JSON with `note_id`, `title`, `parent_item_id`, `parent_title`, `total_lines`, `lines_returned`, `has_more`, `next_offset`, `content` (simplified HTML), and `cited_items[]` with `item_id`, `item_type`, and `title`.

**Underlying handler**: `handleReadNoteRequest` from `src/services/agentDataProvider/`.

---

### `create_note`

Create a Zotero note from markdown. This is a mutating tool: it is advertised only when **Write Tools** is enabled (`extensions.zotero.beaver.mcpCreateNoteToolEnabled`, default `false`), and MCP clients should apply their own approval policy before calling it.

Citation tags use the unified format `<citation id="libraryID-zoteroKey"/>`. Add page locators with `loc`, for example `loc="page5"` or `loc="page5-page6"`. Use the 1-based page numbers from `read_attachment` `<pageN>` tags (physical page index, not printed labels). Use only IDs returned by tool results in the current session, copy page locators verbatim from `read_note` when editing existing notes, omit `loc` for metadata-only citations, and do not use legacy attributes such as `item_id`, `att_id`, `page`, or `sid`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | `string` | Yes | Concise note title. |
| `content` | `string` | Yes | Markdown content with `<citation>` tags. |
| `parent_id` | `string` | No | Parent item ID in `<library_id>-<zotero_key>` format. Creates a child note. |
| `library` | `string` | No | Target library name or ID. Omit to use the default user library. |
| `collection` | `string` | No | Collection name or key for standalone notes. Ignored when `parent_id` is set. |

**Response**: JSON with `note_id`, `parent_item_id`, `related_item_id`, `collection_key`, `note_content` (rendered simplified HTML), `warning`, and `citation_issues` containing `invalid_keys[]` and `errors[]`.

**Underlying handlers**: `validateCreateNoteAction` and `executeCreateNoteAction` from `src/services/agentDataProvider/actions/createNote.ts`.

---

### `get_item_details`

Retrieve full Zotero metadata for one or more items.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `item_ids` | `string[]` | Yes | Item IDs in `<library_id>-<zotero_key>` format. Maximum 25 items. |
| `include_attachments` | `boolean` | No | Include attachment metadata. Default: false. |
| `include_notes` | `boolean` | No | Include child notes. Default: false. |

**Response**: JSON with `items[]` (full Zotero metadata per item) and `not_found[]` (IDs that couldn't be found). When `include_attachments` is true, each item includes `attachments[]` with `attachment_id`, `filename`, `content_type`, `page_count`, and `status`. When `include_notes` is true, each item includes `notes[]` with `item_id`, `title`, `parent_item_id`, `parent_title`, and `date_modified`.

**Underlying handler**: `handleGetMetadataRequest` from `src/services/agentDataProvider/`.

---

### `list_collections`

List collections (folders) in the user's Zotero library.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `library` | `string` | No | Library name or ID. Default: user's library. |
| `parent_collection` | `string` | No | Collection key to list subcollections within. |
| `recursive` | `boolean` | No | Include every descendant instead of direct children only. Default: false. |
| `include_item_counts` | `boolean` | No | Include item counts. Default: true. Counts are omitted when false. |
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
| `name_query` | `string` | No | Case-insensitive tag-name substring. |
| `tag_type` | `string` | No | `manual` (default), `automatic`, or `all`. Mixed tags count as manual. |
| `min_item_count` | `integer` | No | Minimum tagged objects (regular items, attachments, notes, and annotations). Default: 1. |
| `limit` | `integer` | No | Max results per page (default 50, max 100). |
| `offset` | `integer` | No | Results to skip for pagination (default 0). |

**Response**: JSON with `total_count`, `has_more`, `next_offset`, and `tags[]`. Each tag has `name`, `tag_type`, per-object-type counts, and optionally `color`. `manual_count` and `automatic_count` apply after `name_query` and `min_item_count`, before `tag_type` and pagination.

**Underlying handler**: `handleListTagsRequest` from `src/services/agentDataProvider/`.

---

### `list_items`

Browse items in the library, optionally filtered by collection or tag.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `library` | `string` | No | Library name or ID. Default: user's library. |
| `collection` | `string` | No | Collection name or key. |
| `tag` | `string` | No | Tag to filter by. |
| `item_category` | `string` | No | Item type to return: "regular", "note", "attachment", or "all"; use `find_annotations` for annotations. Default: "regular". |
| `recursive` | `boolean` | No | Include subcollection items. Default: true. |
| `sort_by` | `string` | No | Sort field: "dateAdded", "dateModified", "title", "creator", "year". Default: "dateModified". |
| `sort_order` | `string` | No | "asc" or "desc". Default: "desc". |
| `limit` | `integer` | No | Max results per page (default 20, max 100). |
| `offset` | `integer` | No | Results to skip for pagination (default 0). |

**Response**: JSON with `total_count`, `has_more`, `next_offset`, and `items[]`. Item shape depends on `item_category`: regular items have `item_id`, `item_type`, `title`, `authors`, `year`, `date_added`, `date_modified` (no attachment IDs — use `get_item_details` to get those); notes have `parent_item_id`, `parent_title`, `date_modified`; attachments have `filename`, `content_type`, `parent_item_id`, `parent_title`, `annotations_count`, `date_modified`.

**Underlying handler**: `handleListItemsRequest` from `src/services/agentDataProvider/`.

---

### `list_libraries`

Lists only libraries available to Beaver. Returns `libraries` and `total_count`;
rows include `library_ref` (`u` or `g<groupID>`), the local `library_id`, name,
read-only status, and item/note/collection/tag counts. Takes no arguments.
Use `library_ref` in the `library` argument of library-scoped tools.

### `find_annotations`

Searches annotation text and comments, with optional `tag`, `color`,
`annotation_type` (`highlight`, `underline`, `note`), `author`, `attachment_id`,
`collection`, `library`, and `modified_in_last` (e.g. `7 days`) filters.
Omit filters to browse all annotations with pagination. Filters combine with AND. `author` matches the annotation creator (for example, `Beaver`), not the paper author. `attachment_id` requires an actual file attachment ID; resolve parent items with `get_item_details(include_attachments=true)` first.
The personal library is the default. Collection searches recurse by default.

Results include annotation IDs, text, comments, source IDs, tags, and Zotero links.
`limit` defaults to 25 (maximum 50); `offset` defaults to zero. Responses include
`total_count`, `has_more`, `next_offset`, and any scan-limit note from the search.
Sort with `sort_by` (`date_modified`, `date_added`, `reading_order`) and
`sort_order` (`asc`, `desc`).

### `create_highlight_annotations` and `create_note_annotations`

Enable **Write Tools** in Beaver's advanced preferences
(`extensions.zotero.beaver.mcpCreateNoteToolEnabled`, default `false`) and refresh
the MCP client's tool list. The same setting gates `create_note`.
The tools create reader annotations on a single local PDF, EPUB, or HTML snapshot;
`create_note_annotations` creates sticky notes on the attachment.

Both accept `attachment_id`, an `items` array (1–50 entries), and optional `tags`
applied to every annotation. Each item accepts an optional `color` (one of Zotero's
eight palette names; default yellow). Highlights require `text`; notes require
`comment`. Highlight comments are optional.

For PDFs, call `read_attachment` with `include_annotation_locations: true` and a
page range. Its structured `pages[].passages[]` output includes exact source
`text`, `page_locations`, and `note_position`. Copy these locations into the
creation request; do not invent coordinates. Page indices in locations are
zero-based; the read tool's page range is one-based. Highlight boxes are PDF
points in Beaver's extraction frame with an explicit `coord_origin` (`t` for
top-left, `b` for bottom-left). Multi-page highlights produce one annotation per
page. Note positions use `page_index`, `x`, `y`, `side`, and `coord_origin`. Copy the passage's `page_label` too; when omitted, PDF note creation resolves it from document metadata. Physical `page` is one-based and distinct from the printed `page_label`.

For EPUBs, provide `section_href` or a one-based `section_ordinal`, plus `text` or
`anchor_id` to locate the passage. Snapshots use `text` or `anchor_id`. The same
`read_attachment` option returns these as copyable `passages` for EPUBs and
snapshots; section ordinals are separate from the read tool’s page window.

The MCP client owns approval. Beaver validates library access, editability, and
attachment availability, then executes directly. Responses include `created`
(with `annotation_id` and `zotero_uri`), `failed`, `total_created`, and
`total_failed`. Failed batches, including partial failures, set MCP `isError`;
any successful writes are still returned. Retry only failed entries to avoid
duplicates. Each result's zero-based `index` identifies the original input item.

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
import type { WSMyToolRequest, WSMyToolResponse } from '@beaver/agent-core/protocol/agentProtocol';
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

### Argument and identity rules

All MCP calls validate types, enums, required fields, and unknown properties before executing. For example, `list_items(tags_filter=[...])` is rejected; its filter is `tag`. Omitted parameters receive documented defaults; invalid categories never fall back to regular items.

Publication-year bounds are inclusive and exclude undated items. Collection names must be unambiguous within the requested scope; ambiguity errors list accessible collection IDs and paths for retrying. Successful metadata results emit portable IDs even when requested with legacy numeric IDs.

`read_note.cited_items` describes resolved citations in the returned line slice, including directly cited attachments. Deleted, excluded, and unresolved targets are omitted.

`list_libraries.tag_count` counts distinct tag names on non-deleted objects, merging manual/automatic uses of the same name. It matches an unfiltered `list_tags(tag_type="all", min_item_count=0)` scope.
