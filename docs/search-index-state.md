# Search preparation snapshot

`AgentRunRequest.search_index_state` is an optional, versioned snapshot of local
attachment preparation. It is separate from saved prompt application state.

```json
{
  "version": 1,
  "libraries": [
    { "library_ref": "u", "total": 100, "indexed": 81, "unavailable": 10 }
  ]
}
```

Each entry covers a whole searchable library. `total` counts current PDF, EPUB
and HTML snapshot attachments, excluding linked URLs and attachments or parents
in the trash. Missing processing rows count as pending. `indexed` requires a
completed upload with compatible extraction/index versions and matching account,
installation and index scope. `unavailable` is disjoint from `indexed` and includes
only explicitly classified settled document limitations. Pending is derived as
`total - indexed - unavailable`.

Generic extraction, download, read and service failures remain pending. Settled OCR
with no usable text (`ocr_no_text`) is a document limitation and counts as
unavailable; persisted legacy no-text messages have the same classification.
Wrapped reason codes are matched as complete colon-separated tokens. Reading
success supersedes an earlier limitation; reading errors alone do not establish
unavailability because they survive source changes and retries. Reset processing
rows remain pending until processing settles again. Accepted OCR completion clears
the reading error atomically with the processing-ledger update, using the start
time of re-extraction so it cannot overwrite a newer reading observation.

The plugin reads the processing/reading tables once and the current Zotero
inventory once, matching identities locally. There is no polling, file inspection,
item loading or persistent summary cache. Each run dispatch, including retry and
resume, obtains a new snapshot; transport retries reuse the request. The field is
omitted without search entitlement and cloud consent, while library scope is
uninitialized, after an account/scope change during the read, or on a read failure.

The backend validates integer counts, disjoint subsets, unique library identities,
and contract version. Malformed or unknown snapshots become absent without
rejecting chat. Eligibility additionally requires backend entitlement, agreement
with the connection's entire index scope, and no excluded libraries. For each
library with `total > unavailable`, `indexed / (total - unavailable)` must be at
least 90%. At least one indexed attachment is required overall. Empty or wholly
unavailable libraries do not veto another prepared library.

This is preparation evidence, not proof of remote index contents. Source changes
are detected by the existing ingestion machinery; the two databases are not read
in a shared transaction. Remote resets and isolated index drift require separate
index validity/repair handling. The snapshot does not activate the full-text tool.
