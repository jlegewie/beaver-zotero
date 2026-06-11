/**
 * Busy-context snapshot for backend WS diagnostics.
 *
 * Captures very cheap signals about what Zotero / Beaver are doing right now,
 * attached to `request_received` acks and to response `timing` metadata so the
 * backend can attribute slow or timed-out WS requests to a busy client
 * (sync in progress, DB transaction open, file uploads running, starved event
 * loop) instead of guessing.
 *
 * Everything here must stay O(1) property reads — this runs on the hot path of
 * every backend request.
 */

import { store } from '../../react/store';
import { isFileUploaderRunningAtom } from '../../react/atoms/sync';

/**
 * Numeric-only snapshot (booleans encoded as 0/1) so the fields can be merged
 * into `FrontendTimingMetadata`, whose index signature is `number | undefined`.
 */
export interface BusyContext {
    /** 1 if a Zotero sync is currently running */
    busy_sync: number;
    /** 1 if a Zotero DB transaction is open right now (queries queue behind it) */
    busy_db_tx: number;
    /** 1 if Zotero holds its global data lock */
    busy_zotero_locked: number;
    /** 1 if Beaver's file uploader is processing its queue */
    busy_uploader: number;
    /** 1 if the window is hidden/occluded (see `event_loop_lag_ms` caveat) */
    window_hidden: number;
    /**
     * How many ms the 1s heartbeat is currently overdue — a main-thread
     * starvation gauge. CAVEAT: the platform throttles timers in hidden /
     * occluded windows (to ~1s+), so this can read high purely because the
     * window is backgrounded rather than because the event loop is starved.
     * Discount this value when `window_hidden` is 1.
     */
    event_loop_lag_ms: number;
}

const HEARTBEAT_INTERVAL_MS = 1000;

let lastTick = 0;
let heartbeatHandle: ReturnType<typeof setInterval> | null = null;

/**
 * The window that loaded this bundle (not `getMainWindow()`), used to register
 * the heartbeat-stop hook so a plugin hot-reload — which re-evaluates this
 * module in the same window — clears the prior instance's interval instead of
 * leaking a new one each reload. Mirrors the supabaseClient cleanup pattern.
 */
// eslint-disable-next-line no-restricted-globals -- intentionally this script's window, not getMainWindow()
const currentWindow: Window | undefined = typeof window !== 'undefined' ? window : undefined;

// Stop a heartbeat left running by a previous bundle instance (hot reload).
currentWindow?.__beaverStopBusyHeartbeat?.();

/**
 * Lazily start a 1s heartbeat. When the main thread is starved, the interval
 * can't fire, so `now - lastTick - interval` measures how long the event loop
 * has been blocked once code finally runs again.
 */
function ensureHeartbeat(): void {
    if (heartbeatHandle !== null) return;
    lastTick = Date.now();
    heartbeatHandle = setInterval(() => {
        lastTick = Date.now();
    }, HEARTBEAT_INTERVAL_MS);
    if (currentWindow) {
        currentWindow.__beaverStopBusyHeartbeat = stopBusyContextHeartbeat;
    }
}

/**
 * Stop the event-loop-lag heartbeat. Safe to call repeatedly. Wired into the
 * window-unload cleanup (and the hot-reload guard above) so the timer doesn't
 * outlive its window or accumulate across plugin reloads.
 */
export function stopBusyContextHeartbeat(): void {
    if (heartbeatHandle !== null) {
        clearInterval(heartbeatHandle);
        heartbeatHandle = null;
    }
    if (currentWindow?.__beaverStopBusyHeartbeat === stopBusyContextHeartbeat) {
        currentWindow.__beaverStopBusyHeartbeat = undefined;
    }
}

export function getBusyContext(): BusyContext {
    ensureHeartbeat();

    let busySync = 0;
    let busyDbTx = 0;
    let busyLocked = 0;
    let busyUploader = 0;
    let windowHidden = 0;
    try {
        // `as any`: syncInProgress is a defineProperty getter and may be
        // missing from zotero-types
        const Z = Zotero as any;
        busySync = Z.Sync?.Runner?.syncInProgress ? 1 : 0;
        busyDbTx = Z.DB?.inTransaction?.() ? 1 : 0;
        busyLocked = Z.locked ? 1 : 0;
    } catch {
        // Never let diagnostics break request handling
    }
    try {
        busyUploader = store.get(isFileUploaderRunningAtom) ? 1 : 0;
    } catch {
        // Store may not be initialized during startup/shutdown
    }
    try {
        // Lets the backend discount event_loop_lag_ms inflated by timer
        // throttling rather than genuine main-thread starvation.
        windowHidden = currentWindow?.document?.hidden ? 1 : 0;
    } catch {
        // Window/document may be unavailable during startup/shutdown
    }

    return {
        busy_sync: busySync,
        busy_db_tx: busyDbTx,
        busy_zotero_locked: busyLocked,
        busy_uploader: busyUploader,
        window_hidden: windowHidden,
        event_loop_lag_ms: Math.max(0, Date.now() - lastTick - HEARTBEAT_INTERVAL_MS),
    };
}
