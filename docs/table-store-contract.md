# Stored table operations

`table.json` in the attachment's storage directory is the table:
`{spec, receipts, creation}`, written atomically, and that write is the commit
point of every operation. The snapshot HTML beside it is a rendering. `tableStore`
serializes local edits, remote writes, reverts and trims through one lock per
library/item key. Table chat remains development-only; group support does not
change that gate.

## The snapshot renderer

Every write of any kind renders the snapshot inside the write itself
(`tableRenderer.ts`): after the commit and the history update, under the same
table lock and admitted library mutation, so a render never overlaps another
operation and the snapshot is never behind a write that has returned. The render
rechecks exclusion and edit permission before it changes a file or the item. It
reads `table.json`, writes the HTML with the spec's SHA-256 as the root attribute
`data-beaver-spec-sha256` and the digest of the whole `table.json` as
`data-beaver-file-sha256` (so a commit that changes only receipts still changes
the file Zotero syncs by), queues full-text indexing, marks the attachment for
upload, saves the item, and records both digests in `beaver/bookkeeping.json`. A
failed render never fails a write: the write returns `saved: false`, and the next
open renders again.

The render is synchronous by design. A render deferred past the write would
need, and still be fragile without, every one of these guards:

1. Admitting each render as its own library mutation, so it never overlaps a
   write or a sync, and never awaiting one from inside an admitted operation.
2. Rechecking exclusion and file-edit permission before replacing the HTML and
   again before saving the item.
3. Flushing renders at every shutdown path before mutation admission closes,
   after the operations already admitted, then rendering what is left directly.
4. Disposing the account only after that flush, since without the
   searchable-library scope every library reads as excluded.
5. Marking readers opened before the render as outdated, and flushing the
   render before the product Open loads the reader.

Opening a table re-renders a snapshot whose hash or bookkeeping does not match
the committed `table.json` (reported as `rerendered`; a render that fails again
reports `bookkeeping_pending`). A reader opened without the product Open (a
double-click or a restored session) compares its document with the committed
spec when it mounts, marks itself outdated on a mismatch and runs the same open
repair. A missing snapshot is regenerated on the next open in a library
Beaver may write to, because Zotero treats an attachment without its main file
as one to download. Reads never write: in a read-only or excluded library a
missing `table.json` is rebuilt in memory only. A missing
`table.json` is rebuilt from the history's tip version file when its bytes match
the logged digest (`table_file_rebuilt`); otherwise the table is `corrupt`.
Every history commit also copies `table.json`'s receipts and creation marker into
`history.json` (`ledger`), so the rebuilt file, and a write that replaces an
unreadable spec, keep answering operation retries. A
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

Zotero owns file sync. Group writes use the same upload state, revision/digest
checks, operation receipts and recovery shadows as personal tables. This does
not supply a lock across group members or devices: stale writes must be reread
and conflicts reviewed. Missing local files are reported as unavailable.

The provider and composer live suites accept `BEAVER_TEST_TABLE_LIBRARY_REF`
(default `u`). Run them again with an editable `g<groupID>` target and an explicit
`ZOTERO_HTTP_PORT` to exercise both library paths. They cover simulated directory
replacement and shadow restore; actual multi-device file sync and conflict dialogs
still require an isolated sync-enabled test setup.

## Current state and remote writes

`openTable(ref)` returns `version`, `sha256`, `spec` and history. `sha256` is an opaque
SHA-256 digest of the stored spec’s JSON bytes, including store-assigned stamps —
the bytes of `beaver/v<N>.json` and the snapshot's root attribute.
Callers must echo it; they must not recreate it using another JSON serializer.
History versions can collapse within one agent run, so a version alone is insufficient.

Remote callers use:

```ts
writeTable(ref, spec, meta, expectedVersion, {
    expected_sha256,
    operation_id,
});
```

Both preconditions and a nonempty operation ID are required for this remote form.
A distinct operation from an outdated base returns `ok: false, conflict: true` with
the current `version`, `sha256` and `spec`. Reapply mutations to that state and use a
new operation ID for the new request. A transport retry must keep its original ID
and payload. `request_id` identifies a transport attempt and is not an operation ID.
Local `editTable` applies mutations inside the lock. A persistent editor passes
an optional `{version, sha256}` fourth argument from the displayed snapshot; a
stale draft is rejected before its mutations are applied. Immediate callers may
omit that guard.

The retry fingerprint sorts object keys recursively, preserves array order, omits
undefined object values, and excludes the spec’s caller-supplied `key` and `version`.
An omitted `spec_version` means the current format. It includes write metadata and
both preconditions. Reusing an ID with a different fingerprint throws
`operation_mismatch`, even if the precondition is now outdated.

A success includes the current state and an `operation` acknowledgement:

```ts
{
    operation_id: string;
    request_sha256: string;
    version: number;
    sha256: string;
}
```

On replay, `replayed: true` means no content write occurred. `operation.version` and
`operation.sha256` describe the original commit; the response’s top-level
`version`, `sha256` and `spec` describe the current table. They can differ after
another edit, a collapsed write, or a rewind. Consumers must not treat the original
acknowledgement as a fresh version or replace current state with historical content.

Acknowledgements live in `table.json` beside the spec, as `receipts`, and commit in
the same atomic write. They survive local edits,
collapse, revert and trim, independently of the 20-version history retention cap.
They contain no old specs. Receipts are retained for the lifetime of the item;
this deliberately trades a growing compact ledger for safe late retries. They sync
with the attachment. This is single-provider serialization, not a cross-device
consensus protocol: file replacement by sync can roll back the receipt ledger too.

`saved: false` means content committed but a step after the commit point (the
version file, the version log, or the render with its indexing, upload mark and
item save) needs repair. It never means the caller should repeat the mutation
under a new operation ID.

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
with the stamped spec, a completion marker carrying the request fingerprint, and
the acknowledgement. That write commits the creation.

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

A completed retry returns the same item, original acknowledgement and current state.
A changed payload returns `operation_mismatch`. An unfinished import, unavailable
file, duplicate import identity, or discarded item returns `operation_pending`;
callers must preserve the ID and resolve that item, never generate a replacement ID
to bypass the refusal. Incomplete imports are not automatically trashed or duplicated.
Creation replay checks library exclusions before looking up item data.

Create IDs are scoped to a selected library; write IDs are scoped to a table. Producers
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
commit rejects that unchanged operation rather than reporting `saved: true`. Collapse also requires both the writer and tip to be agent-owned, with matching
run and thread IDs; an agent cannot absorb a user/system boundary with the same run ID.

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
rollback. It commits the survivor to `table.json` atomically, keeping the receipts,
then rewrites history, removes discarded files and renders. A failure
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
React surfaces, the reader enhancement and the snapshot's source list all use it.
Snapshot markers carry `data-cite-key="<row>|<column>|<index>"`, and the reader
enhancement resolves them against the spec read through the store.

`tests/fixtures/artifacts/table-mutations`, `table-summaries` and `table-merges`
are the language-neutral contract corpus shared with the backend; both sides run
every case.

## Development endpoints

- `table-create`: accepts `operation_id`.
- `table-open`: returns `sha256` alongside the spec and history.
- `table-write`: accepts `expectedVersion`, `expected_sha256`, `operation_id` and
  returns the current digest plus operation acknowledgement/replay status.
- `table-trim`: accepts `libraryID`, `key`, `thread_id`, `run_ids` and returns the trim result.

The future wire adapter maps `expected_version` to `expectedVersion`, transports the
same digest/operation fields and preserves the structured trim outcomes. In addition
to conflicts and library errors, it must explicitly map `operation_mismatch`,
`operation_pending`, `invalid_request`, unsupported formats and corrupt versions.

## Provider and persistent editor

`artifact_request` and `/beaver/artifact` use the same adapter and portable item
identities. Request envelopes are defined in `agent-core/protocol/artifactProtocol`;
`tests/fixtures/artifacts/provider-contract.json` records the transport examples.
Non-applicable null fields are accepted. Malformed envelopes are refused before
identity lookup. List is bounded to 200 explicit, unique keys and returns a status
for each key; it does not enumerate a library.

Explicit reads validate `table.json`'s key, version, format, and the attachment
type; cosmetic tag removal does not invalidate a table. Automatic discovery may still
use its tag as a candidate hint. Trashed identities and unavailable local files
are distinct failures. Reads remain available in read-only libraries; mutations
check library and file permissions under the store lock.

Remote access checks the current document, identifiable source references, and
retained history before exposing content, summaries, operation receipts, or
conflicts. A now-excluded source withholds the whole table. Incoming content is
checked before operation lookup, and mutation guards repeat inside the lock.
Local reading preserves the user's document. No filtered replacement is returned.
Provider access checks readable sidecar content before repairing interrupted
bookkeeping from the committed table, then verifies all retained digests before
returning history. Missing or corrupt older versions remain unavailable.

The item-pane Edit action opens one persistent React editor in the existing Beaver
window. Ordinary Open shows the table in the Beaver tab (`src/ui/tableTab.ts`), which
reads the committed `table.json` and re-reads it on the store's update event; a reader tab
opened on a table is replaced by that tab. Local edits, explicit
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
