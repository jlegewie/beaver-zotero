# Local endpoints and provider ownership

`addon.localEndpoints` owns the provider WebSocket, its account-scoped wake listener,
and HTTP/MCP registrations. It starts with the instance account and preferences and
stops before account/document/database disposal. Closing a renderer does not stop ingress.

HTTP routes retain the development/staging and authentication gates. Test routes remain
development-only. MCP retains its independent enable preference and write-tool opt-in;
tool execution checks instance authentication. Registration cleanup checks constructor
identity and revokes retained/in-flight endpoint invocations. Account replacement discards
late results, and library-scope revocation closes the provider.

Library, document, cache, processing, table-store, and MCP adapters run in the plugin
realm. Originless writes capture instance account identity and tool preferences, with no
local chat grants, citations, or run identity. Note Markdown rendering uses an explicitly
pinned renderer preparation command; if none is available, it reports a capability error
before writing. Native canvas overlays likewise report an unavailable capability without
a main window.

UI test routes dispatch through each renderer's registered command handlers. Add
`windowId` to a request body to target a specific renderer. Without it, the instance
resolves the active main runtime once at request entry. Closing that target settles a
pending command with `window_unavailable`; it never redirects to another window. Detach
removes the renderer's commands synchronously. No foreign atom identities cross the seam.

Use `/beaver/test/window-runtime` with `{ "command": "list" }` to enumerate stable ids.
The route remains available with zero main windows, returning an empty list. Other UI
routes remain registered and return HTTP 409 with `error_code: "window_unavailable"`.
Instance-safe routes continue to serve requests subject to access and capability checks.

Unit coverage includes registration replacement/revocation, command pinning and closure,
account/pref/build gates, singleton wake ownership, and MCP contracts. Live validation
should include two separately evaluated main-window bundles, closing each window, zero
windows, reopening, concurrent relay/local requests, wake reconnection, preference changes,
and plugin disposal/reload. Use a development backend for relay verification.

The live `localEndpoints.live.test.ts` suite works with or without windows. Set
`BEAVER_ZERO_WINDOW_TEST=1` to assert that the registry is empty, rather than just
allowing an empty registry. Always pin `ZOTERO_HTTP_PORT` to the test instance.
Live setup waits for account hydration before normalizing library exclusions.
