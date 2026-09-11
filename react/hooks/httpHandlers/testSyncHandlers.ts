/**
 * Dev-only HTTP handler for the Zotero sync-suppression (`syncPause`) module.
 *
 * Drives the real `src/services/syncPause` functions against the running
 * Zotero's `Zotero.Sync.Runner`, so live tests can confirm what unit tests can
 * only mock: that the runner APIs the module depends on exist (`delayIndefinite`
 * for the hard sync hold, plus `delaySync` / `clearSyncTimeout` / `setSyncTimeout`
 * for suppressing the auto-sync spinner), and that the pause/resume round-trip
 * works against the real runner.
 *
 * Registered in `useHttpEndpoints.ts` under `/beaver/test/sync-pause`.
 *
 * Calls the plugin-owned service used by all renderers and library mutations.
 * Callers must release their diagnostic pause after testing. Explicit resume
 * does not reschedule sync; the scheduled-resume action uses production behavior.
 */

import {
    pauseSyncForMutatingRun,
    scheduleResumeAfterRun,
    cancelScheduledResume,
    resumeSyncNow,
    isSyncPaused,
    RELEASE_DEBOUNCE_MS,
    SAFETY_IDLE_MS,
} from '../../../src/services/syncPause';

type SyncPauseAction =
    | 'status'
    | 'pause'
    | 'resume'
    | 'schedule-resume'
    | 'cancel-resume'
    | 'probe-runner';

/** Snapshot of the live runner API contract + current module state. */
function snapshot() {
    const runner = typeof Zotero !== 'undefined' ? (Zotero as any).Sync?.Runner : null;
    const service = Zotero.Beaver?.syncPause;
    return {
        runner: {
            available: !!runner,
            delayIndefiniteAvailable: typeof runner?.delayIndefinite === 'function',
            delaySyncAvailable: typeof runner?.delaySync === 'function',
            clearSyncTimeoutAvailable: typeof runner?.clearSyncTimeout === 'function',
            setSyncTimeoutAvailable: typeof runner?.setSyncTimeout === 'function',
            syncInProgress: typeof runner?.syncInProgress === 'boolean' ? runner.syncInProgress : null,
        },
        paused: isSyncPaused(),
        releaseDebounceMs: RELEASE_DEBOUNCE_MS,
        safetyIdleMs: SAFETY_IDLE_MS,
        instanceServiceRegistered: typeof service?.releaseWindow === 'function'
            && typeof service?.resumeSyncNow === 'function',
    };
}

export async function handleTestSyncPauseHttpRequest(request: any) {
    const action: SyncPauseAction = request?.action ?? 'status';

    switch (action) {
        case 'pause':
            pauseSyncForMutatingRun();
            break;
        case 'schedule-resume':
            scheduleResumeAfterRun();
            break;
        case 'cancel-resume':
            cancelScheduledResume();
            break;
        case 'resume':
            resumeSyncNow();
            break;
        case 'probe-runner': {
            // Exercise the raw Zotero API the module depends on, independent of
            // module state: acquire a delay and immediately release it. Does not
            // touch the module's held pause, so `snapshot().paused` is unchanged.
            const runner = typeof Zotero !== 'undefined' ? (Zotero as any).Sync?.Runner : null;
            const probe: {
                delayIndefiniteAvailable: boolean;
                resolveType: string | null;
                roundTripOk: boolean;
                // The spinner-suppression APIs the fix depends on. Exercised with
                // no-op arguments so the probe never starts a real sync.
                suppressionApisOk: boolean;
                error?: string;
            } = {
                delayIndefiniteAvailable: typeof runner?.delayIndefinite === 'function',
                resolveType: null,
                roundTripOk: false,
                suppressionApisOk: false,
            };
            try {
                const resolve = runner.delayIndefinite();
                probe.resolveType = typeof resolve;
                if (typeof resolve === 'function') {
                    resolve();
                    probe.roundTripOk = true;
                }
                // delaySync(0) clears the window; clearSyncTimeout() cancels any
                // pending auto-sync timer. Neither initiates a sync.
                if (typeof runner.delaySync === 'function' && typeof runner.clearSyncTimeout === 'function') {
                    runner.delaySync(0);
                    runner.clearSyncTimeout();
                    probe.suppressionApisOk = typeof runner.setSyncTimeout === 'function';
                }
            } catch (err) {
                probe.error = String(err);
            }
            return { ok: true, action, probe, ...snapshot() };
        }
        case 'status':
        default:
            break;
    }

    return { ok: true, action, ...snapshot() };
}
