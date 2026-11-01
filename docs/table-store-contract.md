# Stored table operations

`table.json` in the attachment's storage directory is the table:
`{spec, creation}`, written atomically, and that write is the commit point of
every operation. The snapshot HTML beside it is a rendering. `tableStore`
serializes tab edits, fill commits, model edits, reverts and trims through one
lock per library/item key. Tables are development-only: readers ignore fields an
older build wrote (`receipts` in `table.json`, `ledger` in `history.json`), and
the next commit drops them. Table chat remains development-only; group support does not
change that gate.

## The snapshot renderer

Every write of any kind renders the snapshot inside the write itself
(`tableRenderer.ts`): after the commit and the history update, under the same
table lock and admitted library mutation, so a render never overlaps another
operation and the snapshot is never behind a write that has returned. The render
rechecks exclusion and edit permission before it changes a file or the item. It
reads `table.json`, writes the HTML with the spec's SHA-256 as the root attribute
`data-beaver-spec-sha256` and the digest of the whole `table.json` as
`data-beaver-file-sha256` (the whole file Zotero syncs), queues full-text indexing, marks the attachment for
upload, saves the item, and records both digests in `beaver/bookkeeping.json`. A
failed render never fails a write: the write returns `saved: false`, and the next
open renders again.

The render is synchronous because a render deferred past the write would need
its own mutation admission, permission rechecks, shutdown flushes and a flush
before Zotero syncs the attachment to be safe.

The snapshot is a static page for readers without Beaver (Zotero without the
plugin, the web library, the mobile apps, a browser) and for Zotero's full-text
index (`tableDocument.ts`). It has no script and no controls: rows are emitted
in the spec's sort order, each row expands with `<details>` to its answers in
full and their evidence (quote, table context, a citation marker linking to the
cited page), the cited works are listed under the table, row verbs and markers
are plain `zotero://` links, and a dismissible notice says the table was made
with Beaver. A cell's reasoning and evidence boxes are not in the page; both
stay in `table.json`. Every commit re-renders, re-indexes and re-uploads the
page, which is about 1.2–1.3 times the size of `table.json`.

With Beaver running, no reader shows a table: a reader tab is replaced by the
Beaver tab when it is added, and a restored reader tab or a reader window is
handed to it when it loads (`view/readerTableView.ts`), so a reader never
presents an older render as current. Opening a table re-renders a snapshot
whose hash or bookkeeping does not match the committed `table.json` (reported
as `rerendered`; a render that fails again reports `bookkeeping_pending`), and
the tab warns that Zotero without Beaver shows an earlier version when the
render still fails. A missing snapshot is regenerated on the next open in a library
Beaver may write to, because Zotero treats an attachment without its main file
as one to download. Reads never write. `table.json` is written atomically and
syncs with its history, so a `table.json` missing beside a retained history is
damage from outside: the table reads as `corrupt`, nothing rebuilds it, and
restoring a retained version (revert, or the item pane's restore of this
device's version) writes a new one. A
storage directory with no table, no history and no snapshot is a table whose
files have not arrived yet (`file_missing`); a snapshot without a table is
`no_spec`.

## Libraries

Tables can be created in the personal library or a group library that permits both
item and file edits. An explicit target is never silently replaced by another
library. An unusable default preference falls back to the personal library.
Group snapshots use Zotero's stored URL attachment importer with an explicit
library ID; they remain top-level HTML attachments, identified remotely by
`g<groupID>-<itemKey>` rather than a device-local library number.

Read-only group documents can be read, attached and opened; creation, content
changes, restore and trash require write permissions. Exclusions refuse provider
access and writes, including when an identifiable source in the table belongs to
an excluded library. Local viewing remains available.

Zotero owns file sync. Group writes use the same upload state, operation
identities and recovery shadows as personal tables. This does
not supply a lock across group members or devices: stale writes must be reread
and conflicts reviewed. Missing local files are reported as unavailable.

The provider and composer live suites accept `BEAVER_TEST_TABLE_LIBRARY_REF`
(default `u`). Run them again with an editable `g<groupID>` target and an explicit
`ZOTERO_HTTP_PORT` to exercise both library paths. They cover simulated directory
replacement and shadow restore; actual multi-device file sync and conflict dialogs
still require an isolated sync-enabled test setup.

## Current state and writes

`openTable(ref)` returns `version`, `sha256`, `spec` and history. `sha256` is an
opaque SHA-256 digest of the stored spec's JSON bytes, including store-assigned
stamps — the bytes of `beaver/v<N>.json` and the snapshot's root attribute.

### Collapse keys and sealing

A write carries an optional `meta.collapse_key`. A write collapses onto the tip —
rewriting that version in place instead of taking a new number — only when the tip
is unsealed, was written by the same actor, and has the same key. Without an
explicit key, an agent write's key is its run and thread; a user write without
one always takes a new version. The fill job uses its job id and the table tab
its editing session, so consecutive commits of either are one version, and a
write by anyone else in between starts a new one: history is never rewritten
across someone else's change.

`meta.seal` commits a version marked `sealed`: nothing collapses onto it, and the
sealed write itself never collapses onto the tip. Creation, model edits,
destructive tab edits, reverts and restores seal their versions.

### Fill commits

The plugin's fill job (`addon.tableFills`) commits through `editTableSession` —
the session path with skip-missing semantics — after entering the instance
mutation queue (`libraryOperations.run('table_editTableSession', …)`). Each
`set_cells` write carries the column's `revision` and question hash as planned and
the row's documents; a write whose column, question or row documents changed, a
user cell, and a removed row or column are skipped and reported, and the rest of
the commit lands. A job's commits are local and never repeated, so the session
path keeps no replay state.

### Model edits

`applyTableEdit(ref, build, meta, { operation_id, request_sha256 }, guard?)` is
the provider's `apply_edit`. Under the lock it reads the current spec, runs
`build` on it and commits the result as one sealed version whose log entry
records `operation_id`, `request_sha256` and the edit's `changes`. A repeat with
the same id finds that entry among the retained versions and answers the current
state with the recorded changes and `replayed: true`, writing nothing; the same id
with another fingerprint is `operation_mismatch`. A failed build is returned
unchanged and a build that changes nothing commits nothing. The backend repeats
only immediately, so retention never decides a replay. Column revisions come from
the build.

`editTable` applies mutations inside the lock. A persistent editor passes an
optional `{version, sha256}` fourth argument from the displayed snapshot; a
stale draft is rejected before its mutations are applied. `writeTable` is the
local whole-spec write behind a restore and the development endpoints.

`saved: false` means content committed but a step after the commit point (the
version file, the version log, or the render with its indexing, upload mark and
item save) needs repair. It never means the caller should repeat the mutation.

Version retention always keeps the newest three versions, whatever their size,
so even a table near the spec cap can be reverted; beyond those it is bounded by
count (20) and by bytes (16 MiB of version files). Whole-spec writes and edits enforce the shared
cell and table limits and refuse growth past them with `too_large`. An edit
returns the `set_cells` writes the engine skipped (user cells, changed
questions) in `skipped`.

## Creation

`createTable({ spec, operation_id, ...options })` serializes imports by operation ID
in the selected library. The attachment URL contains a SHA-256-derived operation
identity, allowing a later process to locate the same item without a registry row.
Its final path segment is the title slug, so Zotero keeps a readable filename.
Lookup uses the operation identity independently of the slug and also recognizes
the earlier URLs without a slug; a changed title still fails request validation.
Zotero imports a snapshot and assigns the key; the store then writes `table.json`
with the stamped spec and a `creation` marker carrying the operation id and the
request fingerprint. That write commits the creation.

`createTableFromRequest({ request, build, operation_id, ... })` is the provider's
`create`: the same operation identity, but the fingerprint covers the request
(with the collection key and library) rather than a spec. `build` resolves the
sources and runs only when no earlier import has that identity; the change list
it answers with is stored on the creation marker, and a replay returns it without
building again. A failed build imports nothing.

Before acknowledging a replay, the store reapplies missing table tags, reconciles
and audits history and renders if the bookkeeping is not complete. It
also attempts to restore a missing creation shadow when the current table is
still that original state, and emits the update event. An intervening edit's
recovery evidence is preserved.

Once `table.json` is installed, failed tags are recorded in
`beaver/bookkeeping.json` and the creation's own render adds them; a failed
history seeding or render returns confirmed success with `saved: false`. Ordinary local open repairs history and version
files under the store lock and access checks and re-renders a stale snapshot. An
import without a committed `table.json` remains `operation_pending`; local repair
never manufactures its content or imports a replacement.

`beaver/bookkeeping.json` acknowledges the current spec and `table.json` digests
only after a render completes. Missing or stale acknowledgements trigger a render after restart;
healthy opens do not save items or queue uploads. Repair always uses current
committed content, preserving later edits. Export and history access also use
the local store. No backend replay is needed. Recovery-shadow recording retains
its best-effort policy.

A completed retry returns the same item and its current state. A changed payload
returns `operation_mismatch`; a `table.json` lost beside its history is `corrupt`. An unfinished import, unavailable
file, duplicate import identity, or discarded item returns `operation_pending`;
callers must preserve the ID and resolve that item, never generate a replacement ID
to bypass the refusal. Incomplete imports are not automatically trashed or duplicated.
Creation replay checks library exclusions before looking up item data.

Create IDs are scoped to a selected library; edit IDs are scoped to a table. Producers
should use unique stable IDs for logical operations and send an explicit library for
creation so a changed local default cannot change the retry’s target. Registry
registration should upsert the returned item identity.

## Rewind

`trimTable(ref, { thread_id, run_ids })` removes a contiguous suffix from the tip.
Only agent entries belonging to the specified conversation and discarded runs are
eligible. A user, system, other-thread, other-run, or reconstructed entry stops the
walk. Trim audits the retained version files before choosing that suffix, adopting
recoverable files missing from the log as protected reconstructed entries. It persists
repaired history even when no versions are eligible for trimming; a failed history
commit rejects that unchanged operation rather than reporting `saved: true`. Collapse also requires the same actor, so an agent cannot absorb a user or system
boundary that shares its run ID.

Creation is sealed against collapse but eligible for trim. Known legacy creation
entries (sealed version 1, non-system actor) remain recognizable. If the entire
history belongs to discarded runs and starts at known creation, trim trashes the
item. Otherwise, when retention has removed the starting boundary, trim preserves
the oldest retained state and reports exhaustion. It never infers creation from the
absence of older files.

The result is:

```ts
{
    ok: true;
    outcome: 'unchanged' | 'trimmed' | 'trashed';
    trimmed_versions: number[];
    trimmed_to: number | null;
    retention_exhausted: boolean;
    saved: boolean;
}
```

`trimmed_to` names the surviving tip, including for an unchanged live item; it is
null for a trashed item. A retry against an already trashed item is unchanged and retries recovery-shadow
cleanup. Failed shadow deletion reports `saved: false`, including on such retries.
The backend should soft-delete its registry pointer when the item was trashed,
report retention exhaustion honestly, and call trim before deleting run records.

Trim verifies the survivor’s retained JSON against its history digest before any
rollback. It commits the survivor to `table.json` atomically, keeping the creation
marker, then rewrites history, removes discarded files and renders. A failure
after the commit returns `saved: false`; ordinary open recovery truncates a stale
log and removes orphan files. An unchanged trim renders when the
bookkeeping is incomplete, so a retry completes indexing and upload even after a
restart.
Sidecar cleanup during trim's initial audit is strict: a deletion failure rejects
the call, including retries, rather than reporting successful cleanup. Recovery-shadow
recording remains best-effort; `saved` does not guarantee that a shadow was recorded.
Trim intentionally retires the device’s discarded recovery shadow before rollback,
so the intentional rewind is not misreported as a sync conflict. A failed pre-commit
write can therefore lose that recovery insurance while leaving the table intact.

## Evidence and fixtures

Cells carry item-less evidence (`locator`, `quote`, `page`, `boxes`, or a metadata
`field`); there is no table-level citation list. `layouts/tableCitations.ts`
assembles a chat citation from a row's reference cell and one evidence entry; the
React surfaces and the snapshot's markers and source list all use it.

`tests/fixtures/artifacts/table-mutations`, `table-summaries`, `table-merges` and
`table-negative-reads` (which values head their passages "Related passages") are
the language-neutral contract corpus shared with the backend; both sides run
every case. The backend's engine keeps a column's `revision` without counting it,
so the plugin compares shared mutation cases without revisions they do not state.
`table-fill-selection` and `table-fill-requests` come from the backend;
`table-pending` (pending work) is the plugin's own.

## Development endpoints

- `table-create`: accepts `operation_id`.
- `table-open`: returns `sha256` alongside the spec and history.
- `table-write`: a local whole-spec write; accepts `expectedVersion`.
- `table-trim`: accepts `libraryID`, `key`, `thread_id`, `run_ids` and returns the trim result.
- `table-fill`: drives the fill service with `action` — `plan` (`key`, `scope?`), `start`
  (`planId`), `fill` (plan and start), `wait` (`jobId`, `timeoutMs?`), `stop`, `status`
  (`jobId` or `key`), `dismiss` and `configure` (`settings`: concurrency, commit cadence,
  retries).
- `table-pending`: accepts `libraryID`, `key` and returns the table's pending work.

## Provider and persistent editor

`artifact_request` and `/beaver/artifact` use the same adapter and portable item
identities. Request envelopes are defined in `agent-core/protocol/artifactProtocol`;
`tests/fixtures/artifacts/provider-contract.json` records the transport examples.
Non-applicable null fields are accepted. Malformed envelopes are refused before
identity lookup. List is bounded to 200 explicit, unique keys and returns a status
for each key; it does not enumerate a library. Reads, creates, edits and reverts
carry the table's `pendingWork` as `pending` beside `summary`.

`fill_plan` and `fill` are a chat run's `fill_table`: they reach the fill service
(`addon.tableFills.agent`) without entering the instance mutation queue, since a
waiting `fill` may last minutes and the job's own commits take the queue one at a
time. One tool call is one job (keyed by its plan and tool call, since some
models reuse tool call ids); a waiting `fill` answers `done` when the job ends
or `running` at the `tables.fillWaitSeconds` deadline (eight minutes, from the
request's first arrival), and the user stopping the run that waits stops the job.

Explicit reads validate `table.json`'s key, version, format, and the attachment
type; cosmetic tag removal does not invalidate a table. Automatic discovery may still
use its tag as a candidate hint. Trashed identities and unavailable local files
are distinct failures. Reads remain available in read-only libraries; mutations
check library and file permissions under the store lock.

Remote access checks the current document, identifiable source references, and
retained history before exposing content, summaries, or conflicts. A now-excluded source withholds the whole table. Mutation guards run on the current and the resulting spec inside the lock.
Local reading preserves the user's document. No filtered replacement is returned.
Provider access checks readable sidecar content before repairing interrupted
bookkeeping from the committed table, then verifies all retained digests before
returning history. Missing or corrupt older versions remain unavailable.

The item-pane Edit action opens one persistent React editor in the existing Beaver
window. Ordinary Open shows the table in the Beaver tab (`src/ui/tableTab.ts`), which
reads the committed `table.json` and re-reads it on the store's update event; a reader
opened on a table, in a tab or a window, is replaced by that tab. Local edits, explicit
history restore, and resets do not call the backend. Notifications reload current
content, while unsaved drafts require an explicit reload after concurrent changes.
Saving one editor section refreshes its saved fields and revision without discarding
drafts in the other sections. Only explicit reload discards all drafts.
Window teardown removes the editor entry point, subscriptions, and item observer.
Correction inputs use raw cell payloads rather than formatted display strings.
Evidence-only edits preserve value metadata; changing a number or date clears its
old display override so it cannot mask the corrected value.
Extraction callbacks are optional and do not start paid work by themselves.

## Cell outcomes

A written cell names its `outcome` (`answered`, `not_reported`, `failed`,
`cleared`) and `provenance` (`document`, `metadata`, `user`, `system`); an absent
cell is unattempted. `value` appears exactly with `answered`, `error` exactly with
`failed`, evidence only with `document` or `metadata`, and `cleared` only with
`user`. A failed cell's `error` is the user-facing message clients show in the
cell, written by the backend; its optional `error_code` (`download_failed`,
`deadline`, …) is stable and appears only on failed cells. Raw diagnostics stay
out of the table. A user clear stores
`{outcome: "cleared", provenance: "user"}`; a reset deletes the cell so the next
fill answers it. Summary columns count each outcome,
unattempted cells (in-scope rows for extraction columns), stale, unsure and
metadata-only cells. The shared fixtures specify these semantics for other clients.

React and saved HTML render outcome, uncertainty, metadata-only answers, failure,
staleness and user-edit indicators. CSV includes per-column evidence, reasoning
and state. CSV quotes delimiters/newlines and prefixes formula-like values so
spreadsheet applications do not execute them as formulas.
