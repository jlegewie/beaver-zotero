/**
 * Dev-only HTTP handler for the Zotero sync-suppression (`syncPause`) module.
 *
 * Drives the real `src/services/syncPause` functions against the running
 * Zotero's `Zotero.Sync.Runner`, so live tests can confirm what unit tests can
 * only mock: that `delayIndefinite()` exists and returns a resolve function,
 * and that the pause/resume round-trip works against the real runner.
 *
 * Registered in `useHttpEndpoints.ts` under `/beaver/test/sync-pause`.
 *
 * NOTE: This shares the same module instance the production webpack path uses
 * (the `agent_action_execute` dispatch wrapper and `useSyncSuppression`), so
 * callers must always release the pause (`action: 'resume'`) to avoid leaving
 * Zotero auto-sync suppressed; the module's idle safety timer is only a
 * backstop.
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
                error?: string;
            } = {
                delayIndefiniteAvailable: typeof runner?.delayIndefinite === 'function',
                resolveType: null,
                roundTripOk: false,
            };
            try {
                const resolve = runner.delayIndefinite();
                probe.resolveType = typeof resolve;
                if (typeof resolve === 'function') {
                    resolve();
                    probe.roundTripOk = true;
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
