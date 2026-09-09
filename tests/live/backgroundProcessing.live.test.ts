/**
 * Whole-library background processing live suite.
 *
 * Drives the producer layer above the queue — `ReconcilerService` and the
 * `attachment_processing_state` ledger — through the `/beaver/test/processing-*`
 * endpoints, and checks that a drained `document_extract` job writes the ledger
 * fields Stage 1 of the rollout depends on (extract status, structured document
 * hash, OCR verdict).
 *
 * The reconcile is deliberately whole-library (that is the only mode the
 * producer has), but the drain is not: the backlog it queues is cleared and
 * only the two fixtures are re-enqueued, at a priority below the idle-gate
 * ceiling so they are claimed first and the suite stays bounded. Extracting a
 * real library here would take tens of minutes.
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - User authenticated so the test endpoints are registered.
 *   - Fixture attachments seeded (NORMAL_PDF, NO_TEXT_PDF, MISSING_FILE_PDF).
 *
 * This suite mutates real local state: it clears the ledger, the scan cursors
 * and the job queue for every library, and flips the background-processing
 * prefs. Everything is restored in `afterAll`, and all of it is derived data
 * that the next reconcile rebuilds.
 *
 * Run with: `ZOTERO_HTTP_PORT=<port> npm run test:live -- backgroundProcessing`
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { backgroundClear, backgroundEnqueue } from '../helpers/cacheInspector';
import {
    drainJobs,
    getLedgerRow,
    isJobQueued,
    processingLedger,
    processingReconcileNow,
    processingReset,
    processingStatus,
    setPref,
    type LedgerRow,
} from '../helpers/processingInspector';
import { MISSING_FILE_PDF, NORMAL_PDF, NO_TEXT_PDF } from '../helpers/fixtures';

let available = false;

/** Prefs to put back in `afterAll`, captured before the suite changes them. */
let originalPrefs: {
    enabled: boolean;
    continuous: boolean;
    extractor: boolean;
} | null = null;

/**
 * Restored in `afterAll` alongside the processing prefs. The suite turns remote
 * file access off so a file-less attachment is unambiguously `file_missing`:
 * with it on, `resolveAttachmentFileSource` reports such an attachment as a
 * remote source and the reconciler queues a download instead of skipping it.
 */
let originalAccessRemoteFiles = true;

/**
 * Below `LOW_PRIORITY_CEILING` (100), so the dispatcher claims these rows
 * whether or not the machine is idle — the reconciler's own extract jobs sit
 * at 110 and would only run behind the idle gate.
 */
const FIXTURE_PRIORITY = 10;

/** Whole-library scans and a real PDF extraction are both slow. */
const SLOW = { timeout: 300_000 } as const;

/**
 * Close the producer gate. Flipping `backgroundProcessingEnabled` on fires the
 * reconciler's pref observer, which schedules a pass immediately — so state must
 * be reset while the gate is still shut, or that pass races the reset and
 * repopulates the ledger the test is about to assert is empty.
 */
async function disableProcessing(): Promise<void> {
    await setPref('backgroundProcessingEnabled', false);
    await setPref('backgroundProcessingContinuous', false);
}

/**
 * Open the producer gate. `executor` controls whether the dispatcher may claim
 * anything: a whole-library reconcile queues hundreds of extract jobs, and on
 * an idle machine the auto-tick would start grinding through real PDFs while
 * the producer assertions run. The phases that only inspect the ledger keep it
 * shut and the drain phase opens it.
 *
 * Call this *after* `resetProcessingState()`, immediately before the explicit
 * reconcile.
 */
async function enableProcessing(
    options: { executor: boolean; remoteFiles?: boolean },
): Promise<void> {
    await setPref('accessRemoteFiles', options.remoteFiles === true);
    await setPref('backgroundExtractorEnabled', options.executor);
    // Left off deliberately: the suite drives every pass explicitly, and
    // continuous mode would let the auto-tick claim the backlog mid-assertion.
    await setPref('backgroundProcessingContinuous', false);
    await setPref('backgroundProcessingEnabled', true);
}

/**
 * Ledger + cursors + queue back to empty, for a deterministic reconcile.
 *
 * Verifies rather than assumes: callers close the producer gate first, but a
 * pass already past its own enabled-check when the pref flipped can still land
 * rows after the delete. Retry until the state stays empty.
 */
async function resetProcessingState(): Promise<void> {
    let last = '';
    for (let attempt = 0; attempt < 5; attempt += 1) {
        await processingReset({});
        await backgroundClear();
        const status = await processingStatus({ includeFailures: false });
        if ((status.ledger?.total ?? 0) === 0 && (status.queue?.pending ?? 0) === 0) return;
        last = `ledger=${status.ledger?.total} queue=${status.queue?.pending}`;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(
        `processing state kept refilling after reset (${last}); `
        + 'a producer is still running with the gate closed',
    );
}

beforeAll(async () => {
    available = await isZoteroAvailable();
    if (!available) return;
    const status = await processingStatus({ includeFailures: false });
    originalPrefs = {
        enabled: status.prefs?.backgroundProcessingEnabled === true,
        continuous: status.prefs?.backgroundProcessingContinuous === true,
        extractor: status.prefs?.backgroundExtractorEnabled === true,
    };
    originalAccessRemoteFiles = status.prefs?.accessRemoteFiles === true;
}, 60_000);

afterAll(async () => {
    if (!available) return;
    // Order matters: stop the producer before dropping its output, or the
    // 5-minute tick can refill the queue between the two calls and leave the
    // instance grinding through a full backlog after the suite ends.
    await disableProcessing();
    await resetProcessingState();
    // Remote-file access goes back FIRST. Re-enabling processing fires the
    // reconciler immediately, and a pass that runs while `accessRemoteFiles` is
    // still forced off records every remote-only attachment as `file_missing`
    // — a skip the producer never revisits, so the user's rebuilt ledger would
    // stay wrong until the next manual reset.
    await setPref('accessRemoteFiles', originalAccessRemoteFiles);
    if (originalPrefs) {
        await setPref('backgroundExtractorEnabled', originalPrefs.extractor);
        await setPref('backgroundProcessingContinuous', originalPrefs.continuous);
        await setPref('backgroundProcessingEnabled', originalPrefs.enabled);
    }
}, 120_000);

describe('background processing status endpoint', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('reports queue, ledger, entitlements, prefs and library scope', async () => {
        const status = await processingStatus();
        expect(status.ok).toBe(true);
        expect(status.queue).toBeDefined();
        expect(status.ledger).toBeDefined();
        expect(status.documentCache).toBeTruthy();
        expect(status.entitlements).toBeDefined();
        // The producers gate on the mirrors, so a divergence from the store
        // atoms is a bug in the publishing hook, not in the test.
        expect(status.entitlements?.mirrored_ocr)
            .toBe(status.entitlements?.hasOcrAccess);
        expect(status.entitlements?.mirrored_search_index)
            .toBe(status.entitlements?.hasSearchIndexAccess);
        expect(status.library_scope?.initialized).toBe(true);
        expect(status.library_scope?.searchable_library_ids?.length ?? 0)
            .toBeGreaterThan(0);
    });

    it('omits cloud coverage when the user has no search-index access', async () => {
        const status = await processingStatus();
        if (status.entitlements?.hasSearchIndexAccess) return;
        expect(status.coverage).toBeUndefined();
    });
});

describe('reconciler refuses to run behind a closed gate', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('reports an error instead of a silent no-op when the pref is off', async () => {
        await setPref('backgroundProcessingEnabled', false);
        const result = await processingReconcileNow();
        expect(result.ok).toBe(false);
        expect(result.error).toContain('backgroundProcessingEnabled');
    });
});

describe('reconcile builds the ledger', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    let reconcileMs = 0;
    let libraryIds: number[] = [];

    beforeAll(async () => {
        if (!available) return;
        // Gate closed for the reset, opened only for the explicit reconcile —
        // otherwise enabling the pref schedules a pass that races the reset.
        await disableProcessing();
        await resetProcessingState();
        const before = await processingStatus({ includeFailures: false });
        libraryIds = before.library_scope?.searchable_library_ids ?? [];
        expect(before.ledger?.total).toBe(0);
        await enableProcessing({ executor: false });
        const result = await processingReconcileNow();
        expect(result.ok).toBe(true);
        reconcileMs = result.duration_ms ?? 0;
    }, 300_000);

    it('creates a ledger row for every processable attachment', SLOW, async () => {
        const status = await processingStatus({ includeFailures: false });
        expect(status.ledger?.total ?? 0).toBeGreaterThan(0);
        // Whole-library scan on a real library; recorded so a regression that
        // makes the producer quadratic shows up as a timeout, not a slow run.
        expect(reconcileMs).toBeGreaterThan(0);
    });

    it('advances the per-library scan cursor', SLOW, async () => {
        const ledger = await processingLedger({ limit: 0 });
        expect(ledger.ok).toBe(true);
        // A cursor is written per library the reconciler completed; at least
        // the library holding the fixtures must be there.
        const cursor = ledger.cursors?.[String(NORMAL_PDF.library_id)];
        expect(cursor).toBeTruthy();
        expect(cursor?.attachmentCount ?? 0).toBeGreaterThan(0);
        expect(cursor?.ledgerRowCount ?? 0).toBeGreaterThan(0);
        expect(cursor?.lastScanTimestamp ?? 0).toBeGreaterThan(0);
        expect(libraryIds.length).toBeGreaterThan(0);
    });

    it('queues extract work for the unprocessed backlog', SLOW, async () => {
        const status = await processingStatus({ includeFailures: false });
        expect(status.queue?.pending ?? 0).toBeGreaterThan(0);
        expect(status.queue?.byJobType?.document_extract ?? 0).toBeGreaterThan(0);
    });

    it('skips an attachment whose file is missing, with a reason', SLOW, async () => {
        const row = await getLedgerRow(
            MISSING_FILE_PDF.library_id,
            MISSING_FILE_PDF.zotero_key,
        );
        expect(row).toBeTruthy();
        // Skipped by the producer itself (no job is queued for it), so this
        // holds without draining anything. Deterministic only because the
        // suite turned `accessRemoteFiles` off — see `enableProcessing`.
        expect(row?.extractStatus).toBe('skipped');
        expect(row?.lastError).toBe('file_missing');
        const status = await processingStatus({ includeFailures: false });
        expect(status.prefs?.accessRemoteFiles).toBe(false);
        expect(status.ledger?.skipped ?? 0).toBeGreaterThan(0);
    });

    it('lists the skip in the failures feed', SLOW, async () => {
        const status = await processingStatus();
        // `getBackgroundProcessingFailures` unions ledger failures, dead
        // letters and content failures; a skip is not a failure, so the feed
        // must stay clean rather than fill with every unreadable attachment.
        const ledgerFailures = (status.failures ?? [])
            .filter((failure) => failure.source === 'ledger');
        expect(ledgerFailures.some(
            (failure) => failure.zoteroKey === MISSING_FILE_PDF.zotero_key,
        )).toBe(false);
    });
});

describe('draining an extract job fills in the ledger', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    let normal: LedgerRow | null = null;
    let scanned: LedgerRow | null = null;
    let drainMs = 0;
    let hasOcrAccess = false;

    beforeAll(async () => {
        if (!available) return;
        await enableProcessing({ executor: true });
        hasOcrAccess = (await processingStatus({ includeFailures: false }))
            .entitlements?.hasOcrAccess === true;
        // Drop the backlog the reconcile above queued: the assertions below
        // need two specific jobs drained, not a whole library extracted.
        await backgroundClear();
        const targets = [NORMAL_PDF, NO_TEXT_PDF].map((fixture) => ({
            libraryId: fixture.library_id,
            zoteroKey: fixture.zotero_key,
            jobType: 'document_extract',
        }));
        for (const fixture of [NORMAL_PDF, NO_TEXT_PDF]) {
            const response = await backgroundEnqueue({
                library_id: fixture.library_id,
                zotero_key: fixture.zotero_key,
                content_kind: 'pdf',
                payload_kind: 'structured',
                job_type: 'document_extract',
                priority: FIXTURE_PRIORITY,
                payload: { content_kind: 'pdf', maxPages: null, timeoutSeconds: 120 },
            });
            expect(response.ok).toBe(true);
            expect(response.enqueued).toBe(true);
        }
        // Wait on these two rows only. Extracting them can spawn follow-on work
        // (OCR when entitled, upsert when search-entitled) that this phase must
        // neither wait for nor let run to completion — see `drainJobs`.
        const drain = await drainJobs(targets, { timeoutMs: 300_000 });
        drainMs = drain.elapsedMs;
        normal = await getLedgerRow(NORMAL_PDF.library_id, NORMAL_PDF.zotero_key);
        scanned = await getLedgerRow(NO_TEXT_PDF.library_id, NO_TEXT_PDF.zotero_key);
    }, 360_000);

    it('marks a readable PDF extracted with a content hash', SLOW, async () => {
        expect(normal?.extractStatus).toBe('done');
        expect(normal?.extractSchemaVersion).toBeTruthy();
        // The cloud-index dedup key. Without it the upsert lane has nothing
        // to tag, so an extracted row with a null hash is a silent dead end.
        expect(normal?.structuredDocumentHash).toBeTruthy();
        expect(normal?.fileHash).toBeTruthy();
        expect(normal?.ocrStatus).toBe('na');
        expect(drainMs).toBeGreaterThan(0);
    });

    it('records the OCR verdict for a scanned PDF', SLOW, async () => {
        expect(scanned?.extractStatus).toBe('done');
        if (hasOcrAccess) {
            // Extraction enqueues `document_ocr` at priority 90 on an entitled
            // account, which is below the idle-gate ceiling and so can be
            // claimed while this suite runs. What is being asserted is the
            // extractor's verdict — that the scan is not readable as-is — so
            // accept any state the OCR lane may have advanced it to, but never
            // `na` (which would mean the verdict itself was wrong).
            expect(scanned?.ocrStatus).not.toBe('na');
            expect(scanned?.ocrStatus).not.toBeNull();
        } else {
            expect(scanned?.ocrStatus).toBe('needed');
            // Nothing may be stamped as OCR'd before an engine has run.
            expect(scanned?.ocrEngineVersion).toBeNull();
        }
    });

    it('counts the drained work in the aggregates', SLOW, async () => {
        const status = await processingStatus({ includeFailures: false });
        expect(status.ledger?.extracted ?? 0).toBeGreaterThan(0);
        // Both fixture jobs are gone. Deliberately not `queue.pending === 0`:
        // an entitled account still has follow-on OCR/upsert rows queued here,
        // and a priority-115 upsert cannot be claimed at all while continuous
        // mode is off.
        for (const fixture of [NORMAL_PDF, NO_TEXT_PDF]) {
            expect(await isJobQueued({
                libraryId: fixture.library_id,
                zoteroKey: fixture.zotero_key,
                jobType: 'document_extract',
            })).toBe(false);
        }
        if (!hasOcrAccess) {
            // The upsell number for non-entitled users in the prefs section.
            expect(status.ledger?.ocrNeeded ?? 0).toBeGreaterThan(0);
        }
    });
});

describe('availability failures recover on a deep pass', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    let skipped: LedgerRow | null = null;
    let recovered: LedgerRow | null = null;
    let queuedAfterRecovery = false;

    beforeAll(async () => {
        if (!available) return;
        await disableProcessing();
        await resetProcessingState();

        // 1. Remote access off: an attachment with no local file is skipped
        //    `file_missing`. Every branch after this in `reconcileAttachment`
        //    returns early for a non-`done` status, so before the availability
        //    re-check nothing ever looked at this row again.
        await enableProcessing({ executor: false, remoteFiles: false });
        expect((await processingReconcileNow()).ok).toBe(true);
        skipped = await getLedgerRow(
            MISSING_FILE_PDF.library_id,
            MISSING_FILE_PDF.zotero_key,
        );

        // 2. The file becomes reachable. `processingReconcileNow` is the
        //    "Process now" path, which is one of the two deep passes that
        //    re-attempt an availability failure (the other is the weekly
        //    safety diff, not reachable from a test).
        await backgroundClear();
        await setPref('accessRemoteFiles', true);
        expect((await processingReconcileNow()).ok).toBe(true);
        recovered = await getLedgerRow(
            MISSING_FILE_PDF.library_id,
            MISSING_FILE_PDF.zotero_key,
        );
        queuedAfterRecovery = await isJobQueued({
            libraryId: MISSING_FILE_PDF.library_id,
            zoteroKey: MISSING_FILE_PDF.zotero_key,
            jobType: 'document_extract',
        });
    }, 300_000);

    it('records the unreachable file as skipped', SLOW, async () => {
        expect(skipped?.extractStatus).toBe('skipped');
        expect(skipped?.lastError).toBe('file_missing');
    });

    it('re-attempts the row once the file is reachable again', SLOW, async () => {
        // The whole point: a 404 or a missing file is only permanent for that
        // attempt. A sync race that resolves later must not leave the
        // attachment unprocessed forever.
        expect(recovered?.extractStatus).toBeNull();
        expect(queuedAfterRecovery).toBe(true);
    });

    it('leaves a still-unreachable file skipped rather than looping', SLOW, async () => {
        // The re-check is a retry, not a licence to re-download forever: with
        // the file still unreachable the row lands back on `skipped` and no
        // job is queued, so repeated deep passes cost a resolve and nothing more.
        await backgroundClear();
        await setPref('accessRemoteFiles', false);
        expect((await processingReconcileNow()).ok).toBe(true);
        const row = await getLedgerRow(
            MISSING_FILE_PDF.library_id,
            MISSING_FILE_PDF.zotero_key,
        );
        expect(row?.extractStatus).toBe('skipped');
        expect(row?.lastError).toBe('file_missing');
        expect(await isJobQueued({
            libraryId: MISSING_FILE_PDF.library_id,
            zoteroKey: MISSING_FILE_PDF.zotero_key,
            jobType: 'document_extract',
        })).toBe(false);
    });
});

describe('processing-reset clears derived state', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('empties the ledger, the cursors and the queue', SLOW, async () => {
        await disableProcessing();
        await resetProcessingState();
        const status = await processingStatus({ includeFailures: false });
        expect(status.ledger?.total).toBe(0);
        expect(status.queue?.pending).toBe(0);
        const ledger = await processingLedger({ limit: 0 });
        expect(ledger.total).toBe(0);
        expect(Object.values(ledger.cursors ?? {}).every((c) => c === null)).toBe(true);
    });
});
