# Library mutation ownership

`Zotero.Beaver.libraryOperations` executes named operations in the plugin realm;
renderers send data rather than async write callbacks.
`Zotero.Beaver.mutations` is the plugin-owned queue for complete library
read/modify/write operations. Chat, provider, HTTP/MCP actions, manual apply/undo,
item imports and table writes/restores enter this queue before acquiring any
resource-specific lock. Internal helpers called by an already coordinated operation
must not re-enter the queue.

An operation captures its account generation, source identity, grants and citation
context at entry. Admission rechecks that identity after waiting. Provider handlers
and their transitive imports stay React-free; rendering and UI notifications arrive
through explicit context. Markdown rendering completes before admission and the
plugin consumes the prepared strings. Preview restoration promises also belong to
the plugin realm. Originless requests do not inherit a local chat's grants
or citations. The provider bundle-closure unit test enforces this boundary.

Item imports resolve an omitted target from the caller's context before admission.
An explicit unavailable, excluded or read-only library is rejected at execution;
imports never silently redirect that target to the personal library. This keeps
execution within the selected library even when access changes after validation.

Background PDF tasks publish their state through `addon.backgroundTasks`. Renderer hooks
read snapshots and subscribe to that plugin-owned source, releasing subscriptions when
unmounted. Manual imports carry guarded completion callbacks and explicit thread/action
identities; completion can outlive a run but cannot cross account replacement or window closure.

Closing a window cancels that owner's waiting jobs. An executing job retains the
queue and its sync-pause token until its actual work settles. Timeouts and cancellation
must not race a still-running save and release the lock early. Plugin disposal closes
admission and awaits active work before disposing shared resources.

`syncPause` owns independent tokens for chat runs and executing mutations. Window
cleanup releases only that window's chat tokens. Safety timers cannot release an
active mutation's token.

`notePreviews` claims individual editor instances. A write awaits restoration of all
previews for its target note before reading live editor state; another editor's preview
is not implicitly replaced. New previews cannot start during a mutation. Conflicting
live editor snapshots fail explicitly instead of choosing whichever editor has focus.

Table operations acquire locks in this order: instance mutation queue, table creation
lock when needed, then the table's own lock. Recovery and shadow restoration use the
same outer queue as ordinary edits.

Run `npm test` for queue lifetime, sync ownership, preview claims, rendering-context
isolation and provider import-closure coverage. With an authenticated development
instance and two main windows, enable `BEAVER_MULTI_WINDOW_TEST=1` and run
`tests/live/multiWindowMutations.live.test.ts` using that instance's `ZOTERO_HTTP_PORT`.
The live test creates a temporary note, edits it through both renderer runtimes, undoes
an edit through the other renderer and removes its fixture.
