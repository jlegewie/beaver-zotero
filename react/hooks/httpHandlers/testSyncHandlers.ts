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
 * NOTE: This shares the same module instance the production webpack path uses
 * (the `agent_action_execute` dispatch wrapper and `useSyncSuppression`), so
 * callers must always release the pause (`action: 'resume'`) to avoid leaving
 * Zotero auto-sync suppressed; the module's idle safety timer is only a
 * backstop. `resume` here intentionally does NOT reschedule a sync (no real
 * edits were made), so running the suite never triggers a sync of the library.
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
    const mainWindow = Zotero.getMainWindow?.();
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
        resumeHookRegistered: typeof mainWindow?.__beaverResumeSyncAfterRun === 'function',
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
