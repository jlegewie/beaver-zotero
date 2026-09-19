# Search readiness from background preparation

This document specifies the planned contract. The ledger-derived summary and backend
validity gate are not yet implemented. Readiness describes sufficient preparation of
indexable attachments; it is not authorization or a claim that every file is searchable.

## Ownership and counts

The plugin background runtime owns one whole-library summary for all windows. Reuse
its attachment inventory, durable processing ledger and change notifications. Do not
use the current processing-run percentage or an empty queue as library coverage.

After a successful full inventory, partition distinct supported current attachments:

- `indexed`: completed/tagged indexing acknowledged for the current content, account,
  portable scope, accepted processing versions and index incarnation. Accepted uploads
  remain pending. Successfully processed zero-chunk documents count as prepared.
- `pending`: unfinished extraction, OCR or indexing, retryable work, missing ledger rows,
  and unresolved service/configuration failures.
- `unavailable`: settled document-specific limitations, including corrupt/encrypted
  files or files unavailable under current download permissions. Source/permission
  changes and explicit retries reconsider these outcomes.

Unsupported formats, linked URLs, trash, attachments of trashed parents and excluded
libraries are outside the inventory. Queue-terminal is not synonymous with unavailable:
service outages, retry exhaustion, authorization failures and incompatible versions
must not shrink the denominator. Preserve structured failure reasons; do not classify
from a generic failed flag or human-readable error text.

Require `indexed / (indexed + pending) >= 0.90` in each included library with a nonzero
denominator, with at least one indexed attachment overall. Empty and wholly unavailable
libraries do not veto other libraries. Use one threshold initially, without hysteresis.
Keep unavailable counts and wholly unavailable scopes in the model-facing context.

For example, 6,000 indexed and 4,000 unavailable files means preparation has settled,
not that search covers 90% of the original library. An unavailable attachment must not
be reported as searched with no matches.

## Discovery and changes

Publish complete discovery only after a successful inventory for the current scope
revision. A discovery callback finishing after an exception does not establish success.
Missing ledger rows count as pending; partial discovery cannot produce readiness.

Update affected counts on additions, source changes, deletions, exclusions and processing
outcomes. Metadata-only edits do not invalidate indexing. Small additions use the same
ratio; large imports can revoke eligibility. An uncertain inventory or newly included
library requires discovery of the affected scope. Fence asynchronous results by account,
installation, scope revision and content identity.

Preserve acknowledgements across pauses, window closure, restarts and network outages.
On restart, re-establish local inventory completeness before claiming readiness. Do not
expire successful indexing merely because 24 hours elapsed. Account changes, incompatible
versions or remote index reset invalidate the corresponding acknowledgements. Local
cache eviction must not invalidate remote indexing or cause re-embedding.

## Backend validity and run contract

Every run, retry and continuation carries a compact `search_readiness` summary, refreshed
at the dispatch handshake. Introduce a new contract version; do not interpret legacy
verified-coverage fields using these semantics. Final field names belong in the paired
frontend/backend protocol change. The summary contains:

- Contract version, installation identity and current included portable library scopes.
- Successful discovery state and scope/inventory revision.
- Accepted extraction/index versions and index incarnation associated with successes.
- Per-library indexed, pending and unavailable counts.

It contains no attachment manifest or document text. The backend matches the authenticated
run scope, validates nonnegative integral counts and contract/version compatibility,
checks entitlement and current index validity, and computes the threshold itself.
Absent, legacy, incomplete or incompatible summaries retain existing search tools.

Index incarnation identifies a particular remote index lifetime. It is distinct from
algorithm/schema version and must change on destructive reset/recreation even when the
namespace name is reused. Reuse an existing lifecycle identity only if it satisfies this
property; otherwise introduce an epoch. Return incarnation with indexing acknowledgements
and requirements/validity responses. Unknown-incarnation legacy ledger rows require
bounded background recovery before counting as indexed.

Run admission performs a bounded validity check independent of attachment count. Any
cache must be invalidated by index lifecycle changes; unknown remote validity fails
closed without erasing local progress. Missing/recreated index invalidates older
acknowledgements and triggers background recovery. No routine readiness path re-verifies
every document. This contract accepts possible isolated drift between repairs; query
failures and targeted missing-content results remain explicit. Query visibility must
honor acknowledgement semantics through the selected consistency mode.

## Reconciliation, cost and presentation

Replace recurring full-library strong verification in both readiness and ingestion
reconciliation. Use targeted/incremental recovery and bounded audits for suspected drift,
upgrades and explicit repair. Preserve multi-device reuse, exclusions and reference
ownership; incomplete local inventories never justify deleting remote-only references.

Summary reads use local counts maintained from inventory/ledger changes; they do not
rescan every file or issue per-attachment requests. Validate this with a 10,000-attachment
fixture, measuring local costs, backend calls and underlying index queries separately.
Run admission adds only bounded backend validity work, independent of library size.

No dedicated readiness percentage, coverage poller or ready indicator belongs in
preferences. Retain preparation activity, file problems/retry controls and protected
OCR-cache storage. Supply concise pending/unavailable information to the agent, including
wholly unavailable libraries, and preserve direct-reading routes for targeted gaps.
Tool activation is a separate integration after this contract passes its tests.
