# Search preparation and readiness

Search readiness describes preparation of indexable attachments. It is neither authorization nor a promise that every attachment is searchable. The backend computes eligibility; this contract does not activate full-text tools.

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
  "index_incarnation": "opaque-server-incarnation",
  "libraries": [{
    "scope_ref": "lLOCAL123",
    "discovery_complete": true,
    "inventory_revision": 1,
    "indexed": 90,
    "pending": 10,
    "unavailable": 2,
    "unavailable_reasons": {"encrypted": 2}
  }]
}
```

The schema-version values above illustrate the shape; `GET /api/v1/index/requirements` is authoritative. Summary counts are strict nonnegative integers. A summary contains at most 500 distinct libraries. Its account, installation and complete scope set must match the authenticated connection and handshake. A personal index scope is `l<installation_id>`; group scopes are `g<group_id>`. Model-context limitations use portable `u` and `g<group_id>` library references.

Missing, legacy, malformed, incomplete, mismatched or incompatible summaries fail closed without failing the chat request. Other clients, including provider-relay clients, remain ineligible. The summary carries no attachment manifest or document text.

## Counting and discovery

The plugin background runtime owns the summary. Its existing reconciler publishes an inventory only after successful enumeration and processing-state reconciliation, fenced against account, scope and preference invalidation. Notification batches use a separate membership fence: they hold dispatch eligibility until targeted replay, without rejecting the in-progress inventory. Unsupported formats, linked URLs, trash, trashed parents and excluded libraries are omitted. A failed or partial inventory is not complete. Missing ledger rows count as pending.

* **Indexed:** the durable ledger contains a completed/tagged acknowledgement for current extracted content, account, installation, scope, accepted schema/index versions and index incarnation. Accepted/in-flight uploads remain pending. A successful zero-chunk document is indexed.
* **Unavailable:** a settled document-specific failure with a structured reading reason. Current producers recognize `file_missing`, `encrypted`, `invalid_pdf`, `invalid_epub`, `invalid_snapshot`, `file_too_large`, `too_many_pages` and `pdf_too_complex`; the latter three normalize to `document_too_large` or `unsupported_document`. OCR backend failures retain their structured code and are joined by current content hash and OCR engine version; `encrypted_pdf` and `corrupt_pdf` normalize to `encrypted` and `invalid_pdf`. Human-readable error text and generic permanent/retry-exhausted states are not classification evidence.
* **Pending:** everything else, including service/network failures, authorization/configuration/version errors, unfinished OCR/extraction/indexing and unknown legacy acknowledgements.

The wire unavailable-reason vocabulary is `file_missing`, `remote_download_denied`, `encrypted`, `invalid_pdf`, `invalid_epub`, `invalid_snapshot`, `unsupported_document`, `document_too_large`, `ocr_unavailable` and `no_extractable_text`. OCR-required documents without OCR access are unavailable; granting access makes them pending preparation. Explicit empty/no-text and supported OCR document limitations are unavailable. Generic download/extraction failures, unknown OCR codes and output-consistency failures stay pending. Reason counts must sum to the unavailable count. Source changes, download-permission changes and explicit retries reconsider document failures.

Eligibility requires at least one indexed attachment overall and `indexed * 10 >= (indexed + pending) * 9` in every included library. Empty and wholly unavailable libraries do not veto other libraries. Validated pending/unavailable counts, including wholly unavailable libraries, remain available in the run's eligibility result. They must never be described as searched with no matches.

Acknowledgements do not expire on idle, pause, window closure or restart. A restart must re-establish inventory completeness. Attachment notifications invalidate the dispatch snapshot synchronously; targeted reconciliation updates membership. Parent notifications check affected children; ordinary metadata edits do not invalidate the whole-library inventory. Child deletion notifications remove membership directly; parent deletions do not force enumeration. Items erased or trashed during enumeration are filtered and their notifications replayed. A discovery pass rejected by a scope/preference fence schedules an immediate retry. Metadata edits do not erase indexing acknowledgements. Cache eviction does not erase the ledger. Startup inventories still use authoritative Zotero membership: matching ledger counts and modification cursors alone cannot prove the same attachment set. Known note/annotation and excluded-library notifications are ignored. Relevant notifications flush every 500 ms during a stream rather than waiting for a quiet interval. Scope resets clear stale membership holds. Each full reconciliation pass captures the current membership token without incrementing it and completes that token only after a successful, uncancelled pass with no queued attachment notifications. This releases notifications dropped during maintenance suspension without releasing newer holds. Empty targeted batches cannot release a discarded batch before that full pass succeeds. Known attachment failures conservatively dirty that key and retry its original notification with 1/2/4-second backoff while retaining the membership hold. Retries never assume the attachment is still included. After exhaustion, the affected library is rediscovered; unknown identities still fail closed across the inventory. Library-pass failures invalidate only that library.

An initial inventory reads each library ledger once. Connection-local SQLite triggers journal affected attachment identities when classification fields change. Queue bookkeeping and unchanged values do not invalidate readiness. A journal-read failure conservatively invalidates cached outcomes and schedules a refresh without rejecting the successful ledger write. Dirty attachments become pending immediately while unrelated acknowledgements remain usable. Subsequent refreshes read at most 250 dirty keys per library per pass and update cached counters; a concurrent change invalidates only its affected keys. Failed reads retain pending work and retry after five seconds. Dispatch reads use the cached snapshot without file scans, SQL or network requests. A missing portable scope is logged and fails closed for the complete summary, because omitting an included library would violate scope validation.

## Index incarnation and consistency

The account lifecycle's namespace generation fences namespace selection and retirement. An additional random UUID lives in the reserved turbopuffer control row `__beaver_index_incarnation`, in its `index_incarnation` attribute. The wire identity hashes the namespace name and this UUID.

The control row is inserted atomically with `upsert_condition = ["id", "Eq", null]`. Concurrent first writers adopt the same winning epoch. It carries a fixed unit vector because vector namespaces require one, but has no library memberships and cannot match scoped document queries. The control row consumes no embedding request. It also creates a namespace for successfully processed zero-chunk documents. No Postgres migration is required beyond the existing account-lifecycle schema.

Upserts capture the control-row identity under the existing document claim, perform the normal fenced write/completion, then strong-read the control row again. A process-local, positive-only cache (60-second TTL, at most 2,048 namespace entries) supplies the pre-write identity for recently confirmed namespaces. Every successful acknowledgement still requires an uncached strong post-write check matching that identity. Write/post-read failures and epoch mismatches evict the entry, so a reset can be bootstrapped on retry without waiting for TTL expiry. Cold/expired entries and control-row initialization still require additional strong reads; warm sequential uploads need one control read each. A missing or changed epoch prevents a readiness acknowledgement. Ambiguous control-row writes retain the claim's uncertainty window. Successful upserts return `index_incarnation` alongside stored processing versions.

Requirements return `index_incarnation` plus `index_validity` (`current`, `missing`, `unknown`). Validity uses two account-state reads, one account-active RPC and one strong control-row query, with a five-second total timeout. There is no backend validity cache. Run admission performs this check for otherwise eligible summaries, independently of attachment count. Entitlement is evaluated separately using the existing policy and profile cache. Failures remain unknown and do not rewrite local successes.

Supported destructive resets delete the namespace, including its control row. Lifecycle retirement already deletes complete namespaces. Operators must not implement a reset by deleting document rows while preserving the control row: that is reference drift, not an incarnation change. Recreation under the same namespace name creates a new epoch. Individual missing references remain the responsibility of targeted repair and explicit retries.

Queries that rely on these acknowledgements must use strong consistency. Successful indexing acknowledges durable writes, not completion of asynchronous ANN indexing; strong queries include the write-ahead log. Tool integration must preserve this consistency requirement and report query/targeted-content failures explicitly.

## Recovery, cost and settings

The full-text lane selects recovery on startup and relevant ledger changes, coalescing requests and spacing recovery attempts by at least one minute. Full fifty-job batches schedule a continuation; unchanged libraries do not undergo minute-by-minute selection. Five-minute validity probes still detect index loss; unchanged validity skips recovery selection until an hourly safety interval elapses. Changed requirements/incarnation trigger selection immediately subject to the same rate limit. Unknown/legacy validity does not invoke selection bookkeeping or consume pending intent. Transient probe failures wait for the next validity probe; retained intent alone does not start a minute retry loop while validity is unknown. Requirements are cached on the client for at most five minutes per account generation; successful upserts update that cache. A settled summary needs no attachment reads or verification calls. Recovery selects at most 50 unacknowledged/incompatible ledger rows, excluding queued work and failures already attempted for the current incarnation, and lets normal hash-first upserts establish ownership and reuse content. A new non-null incarnation permits a bounded recovery attempt even after an older dead letter. Recovery jobs carry that incarnation into dead-letter storage, preventing repeated automatic retries within the same epoch. An index on dead-letter job type, library and attachment key bounds the correlated lookup before checking recovery incarnation. Explicit retry remains available. It never performs a recurring `/verify` sweep. Missing incarnation schedules recovery; unknown validity does not.

The backend reference-verification endpoint remains available for explicit diagnostics and suspected drift; unused plugin coverage/verification wrappers have been removed. Replacement, exclusion, deletion and the durable cleanup outbox retain their existing ownership rules. Remote-only references are not deletion evidence.

Settings show preparation activity, problems/retry controls and protected OCR-cache information. They do not poll remote coverage or show a search-readiness indicator.

## Deployment compatibility

Deploy the compatible backend before releasing the dependent plugin. Old clients ignore new acknowledgement/requirements fields; absent summaries retain existing tools. New clients against an older backend remain unready and do not turn unknown acknowledgements into successes. Existing ledger rows recover incrementally through normal upserts. New backends initialize a control row on indexing, including existing namespaces. No tool activation, commercial entitlement expansion or retention-setting change is part of this contract.
