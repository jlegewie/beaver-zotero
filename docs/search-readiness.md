# Search readiness, policy version 1

Readiness describes observed cloud-index coverage for the current Zotero installation.
It is not an entitlement, authorization, or a switch enabling an agent tool.

## Coverage policy

- Initial readiness requires at least **95% in every included nonempty library**.
- An already ready scope remains ready at **90% or more in every nonempty library**.
  Falling below 90% requires reaching 95% again. Small additions do not revoke
  readiness merely because extraction/upload jobs are queued.
- The denominator is distinct current PDF, EPUB and snapshot attachments, including
  unavailable files and reading, OCR or indexing failures. Linked URLs, unsupported
  formats, trashed attachments, attachments of trashed parents and excluded libraries
  do not count. Empty libraries do not block another library; an entirely empty scope
  is not ready.
- Complete discovery comes from Zotero's attachment inventory, independently of the
  extraction ledger and background preparation preferences. A missing ledger row
  contributes to the denominator, never to verified membership.
- A numerator entry requires a current extraction source observation, its exact
  structured content hash, a backend-accepted extraction schema, and a strong server
  verification of that attachment/hash/scope at the accepted index version. Server
  `empty` is a confirmed processed document with no chunks. Historical upload success,
  namespace existence and aggregate remote reference counts are not coverage evidence.

## Changes and freshness

The plugin owns one readiness service for all windows. It refreshes independently of
preparation, ordinarily every minute, and coalesces concurrent requests. Exact refs
are verified in sequential batches of at most 50. Backend requirements use the existing
five-minute account-generation-scoped cache. No document text is uploaded by readiness.
Settings windows read the shared status and subscribe to its updates; they do not
start additional remote verification loops. Discovery checks account/scope at batch
boundaries and uses cheap cancellation checks for individual attachments.

Account, entitlement, included-library or portable scope identity changes immediately
discard the current and last-confirmed observations and the readiness latch. A newly
included library must satisfy initial readiness. Exclusion/deletion removes files from
the next complete denominator. Accepted index/schema changes reset initial readiness.

Item and file notifications invalidate discovery synchronously and request a new pass
after one second. If a pass is already active, notifications queue one follow-up pass
that starts as soon as the invalidated pass settles. While discovery is incomplete
the run signal is unready. After a
complete pass, additions within the same scope use the retained 90% threshold. Thus
there can be a short fail-closed discovery interval, but ordinary preparation queue
changes do not toggle readiness. Large imports lower coverage and can revoke the latch.

Source identities are checked again after remote verification, so extraction or file
replacement during a pass cannot publish membership for the prior identity. Account
and scope fences discard late results. Positive evidence of lost membership revokes
the prior result even if a later verification batch fails.

Verification expires at **24 hours**, including at request time. A network failure
preserves the last confirmed counts and timestamp, with an explicit error; unknown is
never displayed as zero. An unchanged, unexpired observation remains usable during an
outage. Changed scope/content, incomplete discovery or expired verification is unready.
Observations are session-local: an offline startup is unknown and must verify again.

## Run contract

Every Zotero chat request, including retries and continuations, includes
`search_readiness`. It is refreshed from the instance owner immediately before the
ready-handshake callback returns and the transport sends the request:

```json
{
  "policy_version": 1,
  "ready": true,
  "reason": "ready",
  "discovery_complete": true,
  "verified_at": "2026-09-18T12:00:00.000Z",
  "index_version": 3,
  "extract_schema_versions": { "pdf": ["4"], "epub": ["2"], "snapshot": ["1"] },
  "zotero_local_id": "example-device",
  "libraries": [{ "scope_ref": "lexample-device", "supported": 100, "confirmed": 95 }]
}
```

The server remains authoritative for entitlement and accepted versions. Before using
this signal to select tools, a consumer must validate policy version, discovery,
freshness, installation and exact included scope against the authenticated run context,
as well as accepted index/schema versions and per-library counts. Missing, unknown,
malformed, stale or unsupported signals require the existing attachment-search fallback.
The signal contains no attachment keys, file paths, document text or account IDs.

Current servers ignore this additional request field and retain their existing tools.
This implementation does not enable cloud search in conversations. Settings explicitly
separate preparation activity, verified coverage, conversation availability, problems
and local cache storage. Protected OCR bytes survive cache clearing; local cache size
does not measure cloud coverage.
