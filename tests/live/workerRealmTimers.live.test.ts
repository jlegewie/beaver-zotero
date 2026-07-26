/**
 * Worker realm-safe timers + creator-realm self-heal suite.
 *
 * Covers the live-verifiable surface of the dead-realm timer fix: the
 * MuPDFWorkerClient watchdogs (busy-age lease, idle reap) must run on
 * host-injected realm-independent timers, clients must record their
 * creating realm, and `getMuPDFWorkerClient` must replace an instance
 * whose creating realm is gone (or that predates creator tracking).
 *
 * What can NOT be covered here: an actually-dead window realm (macOS
 * close-last-window → reopen). These tests simulate a dead creator realm
 * via the module-window test hook; the real window lifecycle is a manual
 * test (see docs / memory notes on the close-reopen idle-probe repro).
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - User authenticated so the test endpoints are registered.
 *   - Fixture attachments seeded (SMALL_PDF, NORMAL_PDF).
 *
 * Run with: `npm run test:live -- workerRealmTimers`
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
    isZoteroAvailable,
    skipIfNoZotero,
} from '../helpers/zoteroAvailability';
import {
    pdfPageCount,
    workerIdleProbe,
    workerRealmProbe,
    workerWedgeProbe,
} from '../helpers/cacheInspector';
import { LARGE_PDF, SMALL_PDF } from '../helpers/fixtures';

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

describe('worker timer wiring', () => {
    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
    });

    it('injects realm-independent timers and creator-realm tracking', async () => {
        const info = await workerRealmProbe('info');
        expect(info.ok).toBe(true);
        // configurePDFForBeaver must wire Timer.sys.mjs timers in a real
        // Gecko host — falling back to bare module-realm setTimeout would
        // silently disarm every watchdog after a window close/reopen.
        expect(info.timersInjected).toBe(true);
        expect(info.hasCreatorTracking).toBe(true);
        expect(info.isCreatorRealmDead).toBe(false);
        expect(info.createdFromWindowRecorded).toBe(true);
    });

    it('returns the same healthy instance on consecutive lookups (no churn)', async () => {
        const res = await workerRealmProbe('identity');
        expect(res.ok).toBe(true);
        expect(res.sameInstance).toBe(true);
    });
});

describe('busy-age lease watchdog (timer-based reap)', () => {
    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
    });

    it('reaps a genuinely long op when the lease expires and retries the innocent sibling', async () => {
        // LARGE_PDF (373 pages): extraction reliably outlives the shortened
        // lease + 1s watchdog slack even on a fast machine, so the reap is
        // driven by the timer, never by op completion racing it.
        const res = await workerWedgeProbe(LARGE_PDF, {
            leaseMs: 300,
            op: 'extractSerialized',
            sibling: true,
        });
        expect(res.ok).toBe(true);

        const primary = res.results!.find((r) => r.label === 'extractSerialized')!;
        const sibling = res.results!.find((r) => r.label.startsWith('sibling'))!;

        // The oldest in-flight op gets the non-retriable deadline error —
        // this only happens if the watchdog timer actually fired.
        expect(primary.status).toBe('rejected');
        expect(primary.errorName).toBe('WorkerDeadlineError');

        // The sibling is rejected with a retriable stale error internally
        // and transparently retried against a fresh worker.
        expect(sibling.status).toBe('fulfilled');

        expect(res.after!.leaseReapCount).toBe(res.before!.leaseReapCount + 1);
        expect(res.after!.lastLeaseReapOp).toBe('extractSerialized');
        // The sibling retry respawned the worker.
        expect(res.after!.spawnCount).toBeGreaterThan(res.before!.spawnCount);
        expect(res.after!.retryCount).toBeGreaterThan(res.before!.retryCount);
    });

    it('never reaps in-budget work under the production-scale lease', async () => {
        const res = await workerWedgeProbe(SMALL_PDF, {
            leaseMs: 30_000,
            op: 'getPageCount',
            sibling: false,
        });
        expect(res.ok).toBe(true);
        const primary = res.results![0];
        expect(primary.status).toBe('fulfilled');
        expect(res.after!.leaseReapCount).toBe(res.before!.leaseReapCount);
    });
});

describe('idle-timer reap (injected timers fire)', () => {
    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
    });

    it('reaps an idle worker after the idle window elapses', async () => {
        const res = await workerIdleProbe({ idleMs: 1200, waitMs: 3500 });
        expect(res.ok).toBe(true);
        expect(res.hasWorkerAfterPing).toBe(true);
        expect(res.idleTimerArmedAfterPing).toBe(true);
        // The reap only happens if the armed timer actually fires — the
        // exact probe that stays wedged when watchdog timers are inert.
        expect(res.hasWorkerAfterWait).toBe(false);
        expect(res.idleTimerArmedAfterWait).toBe(false);
    });
});

describe('creator-realm self-heal in getMuPDFWorkerClient', () => {
    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
    });

    it('replaces a client whose creating realm reports closed', async () => {
        const res = await workerRealmProbe('simulate-dead-realm');
        expect(res.ok).toBe(true);
        expect(res.doomedReportedDead).toBe(true);
        expect(res.replaced).toBe(true);
        expect(res.doomedDisposed).toBe(true);
        expect(res.replacementHasTracking).toBe(true);
        expect(res.replacementIsCreatorRealmDead).toBe(false);
    });

    it('replaces and disposes a legacy instance without creator tracking', async () => {
        const res = await workerRealmProbe('legacy-stub');
        expect(res.ok).toBe(true);
        expect(res.replaced).toBe(true);
        expect(res.stubDisposed).toBe(true);
        expect(res.replacementHasTracking).toBe(true);
        expect(res.replacementIsCreatorRealmDead).toBe(false);
    });

    it('leaves the slot serving real ops after the self-heal probes', async () => {
        const res = await pdfPageCount(SMALL_PDF);
        expect(res.ok).toBe(true);
        expect(res.count).toBeGreaterThan(0);
    });
});
