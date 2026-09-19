# Search preparation and readiness

Search readiness describes preparation of indexable attachments. It is neither authorization nor a promise that every attachment is searchable. This contract carries a summary and a pure backend evaluator; it does not activate full-text tools or attach eligibility to runs.

## Run protocol

Every Zotero run, retry and continuation supplies `search_readiness` immediately before dispatch, after the ready handshake. An unknown local summary is `null`. Version 2 contains:

```json
{
  "version": 2,
  "account_id": "authenticated-account-id",
  "installation_id": "LOCAL123",
  "scope_revision": 1,
  "index_version": 3,
  "extract_schema_versions": {"pdf": ["4"], "epub": ["1"], "snapshot": ["1"]},
  "namespace_generation": 1,
  "libraries": [{
    "scope_ref": "lLOCAL123",
    "discovery_complete": true,
    "inventory_revision": 1,
    "indexed": 90,
    "pending": 10,
    "unavailable": 2
  }]
}
```

The schema-version values above illustrate the shape; `GET /api/v1/index/requirements` is authoritative. Counts are strict nonnegative integers. A summary contains at most 500 distinct libraries. Its account, installation and complete scope set must match the authenticated connection and handshake. A personal index scope is `l<installation_id>`; group scopes are `g<group_id>`.

The pure evaluator rejects missing, legacy, malformed, incomplete, mismatched or incompatible summaries. It requires entitlement, a matching server-confirmed namespace generation, at least one indexed attachment overall, and `indexed * 10 >= (indexed + pending) * 9` in every included library. Empty and wholly unavailable libraries do not veto other libraries. Unknown data never fails the chat request. Counts contain no attachment manifest, document text or reason vocabulary.

The evaluator is not called during chat admission until tool registration consumes its result. That integration must supply authoritative entitlement, identity, scope, versions and current validity, and restrict eligibility to supported clients. It must retain pending/unavailable counts when describing search limitations: unavailable content cannot be presented as searched with no matches.

## Counting and discovery

The plugin background runtime caches counts per library. The existing reconciler enumerates live processable attachments, ensures their ledger rows exist, heals missed deletions and marks discovery complete only after a successful pass. Persisted cursors and matching row counts cannot establish discovery after restart. Account/installation/scope changes and reconciliation suspension invalidate discovery.

Attachment additions, deletions, trash/restoration and parent moves invalidate discovery for the affected library; unresolved membership-change identities invalidate all included libraries. Ordinary metadata edits and file downloads do not invalidate discovery. Zotero change metadata and explicit trash events distinguish these paths, and batching retains membership-change evidence. Membership changes retain the last completed snapshot while reconciliation runs. The initial snapshot after startup still requires a successful discovery pass. A membership revision prevents a pass from completing after a newer membership notification or scope change. No attachment membership, row, outcome or dirty-key inventory is retained by the readiness service.

Cursor-driven, forced and weekly processing scans begin discovery only when it is already needed. An unchanged processing scan, including one that fails, preserves a completed summary. Ledger changes mark cached counts for refresh through the normal write subscription while retaining the last published snapshot.

After discovery, durable classification writes invalidate the affected library's cached counts for recomputation. Refreshes coalesce for 250 ms and fold ledger rows plus structured reading errors; dispatch reads use the cache without SQL, file scans or network requests. A library revision rejects refreshes superseded by writes, membership changes, requirements, OCR entitlement or account/scope changes. Same-scope reconciliation, suspension and failed count reads retain the last completed snapshot; failed reads retry after five seconds. A refreshed snapshot replaces it only when all included libraries have completed discovery and fresh counts. Counts can therefore lag additions, deletions and processing changes by a reconciliation pass, and remain stale if that pass cannot complete. Account, installation, scope, search/OCR entitlement, processing-version and index-validity/identity changes clear the snapshot immediately. There is no fallback across these boundaries. Unaffected libraries retain their cached counts.

* **Indexed:** a completed extraction with an accepted format-specific schema, a structured-document hash, and a successful upsert acknowledgement matching the current account, installation, library scope, index version and namespace generation.
* **Unavailable:** a settled document-specific failure established by a structured error code. OCR-required documents without OCR access also count as unavailable; granting access makes them pending.
* **Pending:** everything else, including unknown acknowledgements, unfinished work, service/network errors, authorization/configuration/version errors and generic retry exhaustion.

Classification never parses human-readable errors. OCR failures are joined by current file hash and OCR engine version so obsolete failures cannot classify replacement content. The local classifier recognizes supported document errors but emits only the three counts. Source changes, download-permission changes and explicit retries reconsider document failures. Cache eviction does not erase the ledger or indexing acknowledgements.

## Namespace generation and consistency

The account lifecycle's positive integer `namespace_generation` is the index identity. It selects the namespace and fences document claims, writes and completion. Successful upserts return the generation captured by their claim; local acknowledgements store that value alongside account, installation and scope. They never infer it from cached requirements. There is no control row, synthetic vector, upsert identity cache or extra pre/post-write identity read.

Requirements return `namespace_generation` plus `index_validity` (`current`, `missing`, `unknown`). Validity checks namespace metadata, bracketed by account-state reads and the existing account-active guard, with a bounded five-second timeout and no backend cache. Missing namespaces fail closed; outages and concurrent lifecycle changes remain unknown. A future tool-registration consumer must check current validity before accepting a summary. Entitlement remains a separate policy check.

Supported resets must use the account lifecycle: stop admission, drain fenced writes, delete the namespace and advance generation before allowing new writes. Lifecycle purge completion already advances generation; no new database migration is required. Deleting document rows or recreating a namespace under the same generation is unsupported. Individual missing references remain the responsibility of targeted repair and explicit retries.

Zero-chunk acknowledgements still carry the claim generation but do not create a namespace. Only a nonempty successful upsert can establish namespace presence locally; a zero-chunk acknowledgement preserves already-known validity for the same generation. A library containing only zero-chunk documents cannot make a missing namespace ready. Recovery still compares the known generation when the namespace is missing, so settled zero-chunk documents are not repeatedly enqueued. Repairing an unexpected deletion under the same generation requires the supported lifecycle reset or explicit retry.

Queries that rely on these acknowledgements must use strong consistency. Successful indexing acknowledges durable writes, not completion of asynchronous ANN indexing; strong queries include the write-ahead log. Tool integration must preserve this consistency requirement and report query/targeted-content failures explicitly.

## Recovery, cost and settings

Recovery is a bounded producer on the existing reconciler timer. Startup and ordinary five-minute reconciliation refresh requirements and select at most 50 unacknowledged or incompatible ledger rows across searchable libraries. A full batch schedules continuation after one minute; otherwise the next ordinary reconciliation checks again. Requirements remain cached on the client for at most five minutes per account generation, and successful upserts update that cache. A settled current summary skips ledger recovery selection.

Recovery uses normal hash-first upserts and the existing queue for retries. Queued jobs, failed ledger rows and dead letters are excluded. Terminal failures require explicit Settings retry, including after an namespace generation change; there is no namespace generation field in recovery jobs or dead letters. Unknown/legacy validity creates no work, and transport failures wait for the next ordinary interval. There is no separate recovery subscription, hourly safety scheduler or recurring `/verify` sweep.

The backend reference-verification endpoint remains available for explicit diagnostics and suspected drift. Replacement, exclusion, deletion and the durable cleanup outbox retain their existing ownership rules. Remote-only references are not deletion evidence.

Settings show preparation activity, problems/retry controls and protected OCR-cache information. They do not poll remote coverage or show a search-readiness indicator.

## Deployment compatibility

Deploy the compatible backend before releasing the dependent plugin. Old clients ignore new acknowledgement/requirements fields; absent summaries retain existing tools. New clients against an older backend remain unready and do not turn unknown acknowledgements into successes. Existing ledger rows recover incrementally through normal upserts. Legacy acknowledgements without a generation remain pending until a normal upsert returns one. No tool activation, commercial entitlement expansion or retention-setting change is part of this contract.
