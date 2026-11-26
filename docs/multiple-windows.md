# Multiple chat windows

Beaver 0.25.0-beta.1 gives each main Zotero window its own chat runtime and gives
the single separate Beaver window another runtime. A window shows one chat at a
time. Runs belong to the instance, not to a window: they execute in the plugin
realm, in the run session of their chat (see [thread runtime](thread-runtime.md)),
and every window that shows the chat shows and controls the same run. Switching
chats or closing a window does not stop a run, and several chats can respond at
once, in one window or in several.

Opening the separate window focuses its existing chat. To show a chat there, use
**Open in Beaver window** in the chat menu, also while it is responding. The
destination confirms replacing an unsent draft; a response going in the chat it
showed goes on.
Tables temporarily replace the standalone's presentation; returning to chat keeps
that window's history and draft.

The separate window is laid out as an application rather than a pane: a collapsible
chat history sidebar on the left (new chat, search, pinned and recent chats, the
account), a header with the open chat's title, its actions and the account menu, and
the chat itself in a centered column whose margins grow with the window. The sidebar
state is persisted in the `windowSidebarCollapsed` preference. The chat is the same
`Sidebar` component the panes render, given the window's header in place of its own.

The standalone follows the most recently active main window for automatic library,
selection, reader, and note context. With no main windows open, automatic context is
empty and explicit attachments remain. Closing main windows does not close the
standalone. Preferences uses the renderer that opened it, including the standalone,
and closes when that renderer closes.

## Thread integrity

This client requires the server's `thread_admission_version: 1` capability. Every
execution supplies an `expected_tail_run_id`, including explicit null for an empty
thread. The server's authoritative tail includes runs omitted from presentation.
The existing transport remains compatible with callers that omit the precondition.

A chat can be viewed in several windows; they show its one session, and one run
writes at a time. Server activity also blocks writes when a response is active on
another device or its settlement is unknown. Then a viewer polls persisted history
with bounded backoff.
Conflicts preserve the draft and require explicit refresh and retry. Failed polling
never counts as an idle response, and conflicts are never automatically resent.

Retrying or editing an earlier message first stops any active follow-up. The client
keeps the retry lock until server activity settles, reconciles persisted history,
and includes the stopped follow-up in the removal suffix. It refuses to delete a
new successor discovered during reconciliation. An expired reservation permits an
explicit retry. Truncation asserts the surviving tail, as does the replacement
request. A failed request that never reached admission remains locally retryable
when the server tail and persisted prefix are unchanged; only persisted runs are
sent for truncation. Draft restoration belongs to the originating request and
cannot affect another chat's error handling. Canceling the later undo confirmation
leaves the response stopped.

## Validation and compatibility

Verified on macOS with Zotero **10.0.1-beta.1+16a79acf7**, using an isolated profile
and a server advertising admission v1. The final unit run passed **8,398 tests in
531 files**. Live suites passed **20 selected tests across eight files**, with
additional real chat/lifecycle probes described below. Development build, root and
package type checks, bundle boundary checks, ESLint, and `git diff --check` passed:

- Two main windows and one standalone streamed separate chats concurrently.
- Same-thread contention prevented the competing send and preserved its draft.
- A real stop-and-retry removed an earlier turn and its streaming follow-up, then
  completed one replacement with the draft preserved.
- The standalone finished streaming after every main window closed. PDF extraction
  worked after invalidating the document cache with no main window open.
- Standalone preferences opened with no main window and retained the correct owner.
- Completed responses showed no status card in the standalone window and retained
  the card in a main window with its sidebar closed. All nine reader-context
  transition and library-exclusion live tests passed with explicit window targets.
- Repeated standalone open/close, reader-context initialization, sidebar context,
  table/chat round trips, and plugin rebuild/restart were exercised.
- Live suites covered runtime cleanup, context isolation, account/access projection,
  thread repository sharing, and concurrent mutations and undo. Unit tests cover
  server activity polling, late navigation/account responses, busy/expired
  reservations, unseen successors, canceled undo, handshake capability checks,
  authoritative history metadata, and command routing.

The manifest range remains **6.999–10.0.***. This validation does not establish
compatibility with Zotero 11 or every release within that range. No version-number
branches were added; tagged and untagged tab-event behavior has unit coverage.

### Remaining manual coverage

- Supported stable Zotero releases and the upstream build with tagged multi-window
  notifications; repeat context and reader/note navigation across two main windows.
- Windows and Linux window lifecycles, keyboard shortcuts, focus, sizing, and menus.
- Native focus switching (the automation host could not locate a native Zotero
  window; programmatic focus did not activate it), plus visual review of chat
  switching confirmations, tables, scrolling/find-in-chat,
  preferences, detached readers/notes, and keyboard shortcuts across all surfaces.
- Long-running token rotation, sleep/wake, network loss during final persistence,
  and crash/relaunch against the deployed backend. Settlement/expiry failure cases
  are tested with controlled responses, not induced production outages.

The repository-wide formatting check currently fails on pre-existing formatting
across the repository. ESLint, type checks, bundle boundary checks, and the targeted
behavioral validations are separate checks.
