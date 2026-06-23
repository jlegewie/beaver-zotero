/**
 * Zotero sync-suppression (syncPause) live suite.
 *
 * Exercises the real `src/services/syncPause` module against the running
 * Zotero's `Zotero.Sync.Runner` via the dev-only `/beaver/test/sync-pause`
 * endpoint. The unit tests (`tests/unit/services/syncPause.test.ts`) cover the
 * state machine with a mocked runner; this suite's load-bearing value is
 * confirming the parts the unit tests can only fake:
 *   - the runner APIs the module depends on exist on the real runner:
 *     `delayIndefinite()` (the hard sync hold, which the feature silently
 *     no-ops without) plus `delaySync` / `clearSyncTimeout` / `setSyncTimeout`
 *     (the auto-sync spinner suppression),
 *   - the pause -> resume round-trip works against the real runner and never
 *     starts a sync (`syncInProgress` stays false),
 *   - the debounced and cancel paths behave with real timers, and
 *   - the window unload-cleanup hook (`__beaverResumeSyncAfterRun`) is wired.
 *
 * The endpoint shares the same webpack module instance the production path
 * uses (the `agent_action_execute` dispatch wrapper and `useSyncSuppression`),
 * so every test releases the pause; a leaked pause would otherwise suppress
 * the user's auto-sync until the 10-minute idle safety timer fires.
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - User authenticated so the dev-only test endpoints are registered.
 *
 * Run with: `npm run test:live -- syncPause`
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { syncPause } from '../helpers/cacheInspector';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

describe('sync suppression — Zotero.Sync.Runner contract', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('exposes delayIndefinite as a function on the live Sync.Runner', async () => {
        const res = await syncPause('status');
        expect(res.ok).toBe(true);
        expect(res.runner.available).toBe(true);
        expect(res.runner.delayIndefiniteAvailable).toBe(true);
        expect(typeof res.runner.syncInProgress).toBe('boolean');
    });

    it('exposes the auto-sync spinner-suppression APIs on the live Sync.Runner', async () => {
        // The fix prevents the sync spinner mid-run by parking Zotero's auto-sync
        // timer before it animates the icon. That relies on these three runner
        // APIs existing — guard against an upstream rename silently regressing it.
        const res = await syncPause('status');
        expect(res.runner.delaySyncAvailable).toBe(true);
        expect(res.runner.clearSyncTimeoutAvailable).toBe(true);
        expect(res.runner.setSyncTimeoutAvailable).toBe(true);
    });

    it('acquires and releases a real Zotero sync delay in one round-trip', async () => {
        const res = await syncPause('probe-runner');
        expect(res.ok).toBe(true);
        expect(res.probe?.delayIndefiniteAvailable).toBe(true);
        expect(res.probe?.resolveType).toBe('function');
        expect(res.probe?.roundTripOk).toBe(true);
        // delaySync(0)/clearSyncTimeout round-trip cleanly and setSyncTimeout exists.
        expect(res.probe?.suppressionApisOk).toBe(true);
        expect(res.probe?.error).toBeUndefined();
    });

    it('registers the window resume hook used for unload cleanup', async () => {
        const res = await syncPause('status');
        expect(res.resumeHookRegistered).toBe(true);
    });

    it('reports the documented debounce and safety-idle timings', async () => {
        const res = await syncPause('status');
        expect(res.releaseDebounceMs).toBe(1000);
        expect(res.safetyIdleMs).toBe(600_000);
    });
});

describe('sync suppression — pause/resume against live Zotero', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    // Never leave the shared runner suppressed for the next test or the user.
    afterEach(async () => {
        if (!available) return;
        await syncPause('resume');
    });

    it('holds the pause after pause and releases it on resume', async () => {
        const paused = await syncPause('pause');
        expect(paused.paused).toBe(true);

        const resumed = await syncPause('resume');
        expect(resumed.paused).toBe(false);
    });

    it('never starts a sync across a pause/resume cycle (no mid-run spinner)', async () => {
        // Suppression cancels the auto-sync timer and parks it before the icon
        // animates, so pausing must not flip the runner into a sync. The dev
        // resume path also does not reschedule a sync (no real edits were made).
        const idle = await syncPause('status');
        expect(idle.runner.syncInProgress).toBe(false);

        const paused = await syncPause('pause');
        expect(paused.paused).toBe(true);
        expect(paused.runner.syncInProgress).toBe(false);

        const resumed = await syncPause('resume');
        expect(resumed.paused).toBe(false);
        expect(resumed.runner.syncInProgress).toBe(false);
    });

    it('acquires the pause once across repeated mutating actions', async () => {
        // Clean baseline: module state persists in the long-running Zotero.
        await syncPause('resume');

        await syncPause('pause');
        await syncPause('pause');
        const third = await syncPause('pause');
        expect(third.paused).toBe(true);

        // One resume releases it; a second resume is a harmless no-op.
        const first = await syncPause('resume');
        expect(first.paused).toBe(false);
        const second = await syncPause('resume');
        expect(second.paused).toBe(false);
    });

    it('releases the pause after the debounced resume window elapses', async () => {
        const paused = await syncPause('pause');
        expect(paused.paused).toBe(true);

        // The snapshot is taken right after the debounce timer is armed, so the
        // pause is still held until the window elapses.
        const scheduled = await syncPause('schedule-resume');
        expect(scheduled.paused).toBe(true);

        await sleep(scheduled.releaseDebounceMs + 500);

        const after = await syncPause('status');
        expect(after.paused).toBe(false);
    });

    it('keeps the pause held when a scheduled resume is cancelled', async () => {
        const paused = await syncPause('pause');
        expect(paused.paused).toBe(true);

        await syncPause('schedule-resume');
        await syncPause('cancel-resume');

        await sleep(paused.releaseDebounceMs + 500);

        const after = await syncPause('status');
        expect(after.paused).toBe(true); // afterEach releases it
    });

    it('probe-runner does not disturb a held module pause', async () => {
        await syncPause('pause');

        const probe = await syncPause('probe-runner');
        expect(probe.probe?.roundTripOk).toBe(true);
        // The raw-API probe acquires/releases its own delay without touching
        // the module's held pause.
        expect(probe.paused).toBe(true);

        const after = await syncPause('status');
        expect(after.paused).toBe(true); // afterEach releases it
    });
});
