# Document and background runtime

`addon.documents` owns shared document extraction and MuPDF client construction.
Every renderer routes whole-document requests to this instance. The two worker
slots, `hot` and `background`, use separate WASM heaps; their module workers are
constructed in a system module and have no main-window owner. Closing or focusing
a window neither replaces a worker nor unregisters a background lane.

Each worker admits one operation at a time, with at most 32 waiting operations.
Excess admission fails with `WorkerQueueFullError`. Queued cancellation removes
only that request; active cancellation and watchdog recovery use the worker's
existing termination and retry rules. Cache single-flight shares cold extraction
for matching source identities and modes. Each cache waiter has its own
cancellation signal; losing the last waiter cancels the shared operation. Request
keepalives remain owned by the request dispatcher while work waits for admission.

One plugin-owned deadline covers attachment resolution and PDF extraction.
Account or scope revocation rejects stale results; background extraction treats
that rejection as cancellation and releases the job without consuming a retry.

`addon.background` registers OCR (3 local jobs), cloud fulltext upsert (2 jobs),
and untag (1 job) alongside the extraction lane (1 job). Backend OCR waits release
their local slots. A shared background MuPDF mutex orders OCR re-extraction and
document extraction at whole-job granularity; the bounded worker queue orders
individual operations within those jobs and interactive requests. The existing
idle, sync, priority, startup-delay, busy,
preference, access and entitlement gates still apply with zero main windows.

The instance also owns metadata embedding scans and their item observer,
remote-reference sweeps, exclusion cleanup, notification claims and background
status reads. Renderers subscribe to embedding/status changes and issue explicit
rebuild commands. A rebuild restarts only embedding work, leaving the other
background lanes registered. Account generations and scope changes cancel stale work;
same-account refreshes with unchanged access do not restart lanes or indexing.
Debounced embedding events stay with the instance across generation changes;
the next generation drains them using its current searchable-library scope.
Upgrade flags are set before background initialization.

Window detach removes only renderer subscriptions. Instance shutdown closes
admission, cancels document requests and background generations, settles protected
work, stops the dispatcher and producers, and disposes workers before closing the
database. UI endpoints remain subject to their existing window/auth lifecycle.

The document worker requires Gecko module-worker and WASM support. Text/EPUB/HTML
parsing uses plugin-realm DOMParser and TextDecoder; no background operation opens
a main window to obtain a parser. Image or UI operations outside this service
must still provide their required rendering capability explicitly.

## Verification

Run the document queue, instance background/document, cross-bundle error and MuPDF
unit suites, plus the live worker, document-cache, background processing and EPUB
suites against an isolated profile.

The [system-module lifecycle harness](../tests/helpers/documentRuntime.sys.mjs)
accepts the Zotero singleton and PDF bytes. Register its directory under a temporary
`resource://` substitution, import it with `ChromeUtils.importESModule`, and call
`void run(Zotero, bytes)` from a privileged debugger. It closes both main windows,
so the harness itself must run in a system module. Inspect
`Zotero.__beaverDocumentRuntimeCheck` after the main window reopens; `finished`
must be true with no `error`. Use a text-bearing PDF and an idle isolated profile.
The check covers independent main runtimes, focus changes, first-window closure
with a pending extraction, zero-window structured extraction, a cold background
worker, idle reaping and respawn. It restores the hot worker's normal idle timeout.

Also verify real account/entitlement transitions during cloud OCR and fulltext
work, notification presentation across windows, plugin disable, and zero-window
quit on each supported Zotero release. Unit cancellation and account fixtures do
not establish those cross-version or remote-service behaviors.
