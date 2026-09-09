# Stored table operations

The document’s embedded `TableSpec` is authoritative. `tableStore` serializes local
edits, remote writes, reverts and trims through one lock per library/item key.
The table feature remains disabled until its transport and consumers are implemented.

## Current state and remote writes

`openTable(ref)` returns `version`, `sha256`, `spec` and history. `sha256` is an opaque
SHA-256 digest of the stored spec’s JSON bytes, including store-assigned stamps.
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
Local `editTable` applies mutations inside the lock and needs no remote guard.

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

Acknowledgements live in the non-executable `beaver-table-store` JSON block beside
the spec, and commit in the same atomic HTML rename. They survive local edits,
collapse, revert and trim, independently of the 20-version history retention cap.
They contain no old specs. Receipts are retained for the lifetime of the item;
this deliberately trades a growing compact ledger for safe late retries. They sync
with the attachment. This is single-provider serialization, not a cross-device
consensus protocol: file replacement by sync can roll back the receipt ledger too.

`saved: false` means content committed but post-commit bookkeeping needs repair.
It never means the caller should repeat the mutation under a new operation ID.

## Creation

`createTable({ spec, operation_id, ...options })` serializes imports by operation ID
in the selected library. The attachment URL contains a SHA-256-derived operation
identity, allowing a later process to locate the same item without a registry row.
Its final path segment is the title slug, so Zotero keeps a readable filename.
Lookup uses the operation identity independently of the slug and also recognizes
the earlier URLs without a slug; a changed title still fails request validation.
The import document carries the request fingerprint before Zotero assigns the key;
the stamped document marks creation complete and records the acknowledgement.

The completion marker identifies a stamped document, not finished bookkeeping. Before
acknowledging a replay, the store reapplies table tags, reconciles and audits history,
queues indexing, marks the item for upload and saves it. It also attempts to restore a
missing creation shadow when the current document is still that original state, and
emits the update event. An intervening edit's recovery evidence is preserved.

Failed operation-backed indexing, item save or history seeding rejects the call while
keeping the same item available for retry. The caller must retry with the original
operation ID. Recovery-shadow recording retains its existing best-effort policy.

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
rollback. It commits the rendered survivor atomically, then rewrites history,
removes discarded files and schedules upload/indexing. A post-commit failure returns
`saved: false`; ordinary open recovery truncates a stale log and removes orphan files.
An unchanged trim also retries indexing and the item save that schedules upload,
so retrying after a post-commit failure completes that bookkeeping even after a
restart. Failed indexing or saving returns `saved: false` on these retries too.
Sidecar cleanup during trim's initial audit is strict: a deletion failure rejects
the call, including retries, rather than reporting successful cleanup. Recovery-shadow
recording remains best-effort; `saved` does not guarantee that a shadow was recorded.
Trim intentionally retires the device’s discarded recovery shadow before rollback,
so the intentional rewind is not misreported as a sync conflict. A failed pre-commit
write can therefore lose that recovery insurance while leaving the table intact.

## Citations and fixtures

`applyMutations` prunes citations once, after the entire successful mutation list.
Create and whole-spec write also prune. Live references include text values, text
evidence and every list-evidence entry. Metadata survives if any requested, resolved
or raw-tag lookup key matches a live reference. Shared references survive deletion
of just one citing cell. Retained entry order and metadata are unchanged.

`Citation.parent_ref` optionally carries the owning bibliographic Zotero item. It is
best-effort metadata, not a lookup alias or part of citation identity. Old citations
without it remain valid.

`tests/fixtures/artifacts/table-mutations` is the language-neutral contract corpus;
backend mirrors should copy the complete directory and run all cases. Pruning leaves
an existing citation list as `[]` when its last reference disappears, and preserves
an absent citation field when none existed.

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
