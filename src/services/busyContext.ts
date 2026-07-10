/**
 * Busy-context snapshot for backend WS diagnostics.
 *
 * Captures very cheap signals about what Zotero / Beaver are doing right now,
 * attached to `request_received` acks and to response `timing` metadata so the
 * backend can attribute slow or timed-out WS requests to a busy client
 * (Zotero sync, an open DB transaction, full-text indexing, Beaver's own PDF
 * extraction, a starved event loop) instead of guessing.
 *
 * `getBusyContext()` must stay O(1) property reads — it runs on the hot path of
 * every backend request. Anything that needs watching over time (full-text
 * indexing) is tracked out-of-band via a Notifier observer that only stamps a
 * timestamp; the hot path just compares it.
 */

/**
 * Numeric-only snapshot (booleans encoded as 0/1) so the fields can be merged
 * into `FrontendTimingMetadata`, whose index signature is `number | undefined`.
 */
export interface BusyContext {
    /** 1 if a Zotero sync is currently running (Zotero's own sync, not Beaver's) */
    busy_sync: number;
    /** 1 if a Zotero DB transaction is open right now (queries queue behind it) */
    busy_db_tx: number;
    /** 1 if Zotero holds its global data lock */
    busy_zotero_locked: number;
    /** 1 if Zotero full-text indexing fired recently (within `INDEXING_RECENCY_MS`) */
    busy_indexing: number;
    /** 1 if Beaver's MuPDF worker has in-flight operations */
    busy_extracting: number;
    /** Number of operations running or queued on the user-facing MuPDF worker */
    extracting_hot_pending: number;
    /** Number of operations running or queued on the background MuPDF worker */
    extracting_background_pending: number;
    /** Age in ms of the oldest hot-worker operation, or 0 while idle */
    extracting_hot_oldest_ms: number;
    /** Age in ms of the oldest background-worker operation, or 0 while idle */
    extracting_background_oldest_ms: number;
    /**
     * 1 if the window is hidden/occluded. The platform throttles timers in
     * hidden/occluded windows, which can inflate `event_loop_lag_ms`, so the
     * backend should discount that gauge when this reads 1.
     */
    window_hidden: number;
    /** How many ms the 1s heartbeat is currently overdue */
    event_loop_lag_ms: number;
}

const HEARTBEAT_INTERVAL_MS = 1000;

/** Window after a full-text `index` Notifier event during which `busy_indexing` reads 1 */
const INDEXING_RECENCY_MS = 1500;

let lastTick = 0;
let heartbeatHandle: ReturnType<typeof setInterval> | null = null;

/** time.now() of the most recent Zotero full-text `index` Notifier event. */
let lastIndexActivityAt = 0;
/** Notifier observer id for the full-text `index` watcher, or null when unregistered. */
let indexObserverID: string | null = null;

/** The window that loaded this bundle (not `getMainWindow()`), used to register the heartbeat-stop hook so a plugin hot-reload clears the prior instance's interval instead of leaking a new one each reload */
// eslint-disable-next-line no-restricted-globals -- intentionally this script's window, not getMainWindow()
const currentWindow: Window | undefined = typeof window !== 'undefined' ? window : undefined;

// Stop monitors left running by a previous bundle instance (hot reload).
currentWindow?.__beaverStopBusyHeartbeat?.();

/**
 * Register the full-text `index` Notifier observer once. Cheap: the observer
 * only stamps a timestamp; the hot path compares it. Best-effort — never let a
 * diagnostics failure break request handling.
 */
function ensureIndexObserver(): void {
    if (indexObserverID !== null) return;
    try {
        const Z = Zotero as any;
        if (!Z.Notifier?.registerObserver) return;
        const observer = {
            notify: (event: string) => {
                if (event === 'index') {
                    lastIndexActivityAt = Date.now();
                }
            },
        };
        indexObserverID = Z.Notifier.registerObserver(observer, ['item'], 'beaver-busy-index');
    } catch {
        // Notifier may be unavailable during startup/shutdown
    }
}

/**
 * Lazily start a 1s heartbeat and the full-text index observer. When the main
 * thread is starved, the interval can't fire, so `now - lastTick - interval`
 * measures how long the event loop has been blocked once code finally runs.
 */
function ensureHeartbeat(): void {
    ensureIndexObserver();
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
 * Stop the event-loop-lag heartbeat and unregister the full-text index
 * observer. Safe to call repeatedly. Wired into the window-unload cleanup (and
 * the hot-reload guard above) so neither outlives its window nor accumulates
 * across plugin reloads.
 */
export function stopBusyContextHeartbeat(): void {
    if (heartbeatHandle !== null) {
        clearInterval(heartbeatHandle);
        heartbeatHandle = null;
    }
    if (indexObserverID !== null) {
        try {
            (Zotero as any).Notifier?.unregisterObserver?.(indexObserverID);
        } catch {
            // best-effort
        }
        indexObserverID = null;
    }
    if (currentWindow?.__beaverStopBusyHeartbeat === stopBusyContextHeartbeat) {
        currentWindow.__beaverStopBusyHeartbeat = undefined;
    }
}

export function getBusyContext(): BusyContext {
    ensureHeartbeat();
    const now = Date.now();

    let busySync = 0;
    let busyDbTx = 0;
    let busyLocked = 0;
    let busyExtracting = 0;
    let extractingHotPending = 0;
    let extractingBackgroundPending = 0;
    let extractingHotOldestMs = 0;
    let extractingBackgroundOldestMs = 0;
    let windowHidden = 0;
    try {
        // `as any`: syncInProgress is a defineProperty getter and may be
        // missing from zotero-types
        const Z = Zotero as any;
        busySync = Z.Sync?.Runner?.syncInProgress ? 1 : 0;
        busyDbTx = Z.DB?.inTransaction?.() ? 1 : 0;
        busyLocked = Z.locked ? 1 : 0;
        // Beaver's own PDF extraction: in-flight ops on either MuPDF worker
        // slot (exposed cross-bundle via these globals).
        const hot = Z.__beaverMuPDFWorkerClient_hot;
        const background = Z.__beaverMuPDFWorkerClient_background;
        extractingHotPending = hot?.inFlight ?? 0;
        extractingBackgroundPending = background?.inFlight ?? 0;
        busyExtracting = extractingHotPending + extractingBackgroundPending > 0 ? 1 : 0;

        const hotStartedAt = hot?.oldestInFlightStartedAt ?? 0;
        const backgroundStartedAt = background?.oldestInFlightStartedAt ?? 0;
        extractingHotOldestMs = extractingHotPending > 0 && hotStartedAt > 0
            ? Math.max(0, now - hotStartedAt)
            : 0;
        extractingBackgroundOldestMs =
            extractingBackgroundPending > 0 && backgroundStartedAt > 0
                ? Math.max(0, now - backgroundStartedAt)
                : 0;
    } catch {
        // Never let diagnostics break request handling
    }
    try {
        // Lets the backend discount event_loop_lag_ms inflated by timer
        // throttling rather than genuine main-thread starvation.
        windowHidden = currentWindow?.document?.hidden ? 1 : 0;
    } catch {
        // Window/document may be unavailable during startup/shutdown
    }

    const busyIndexing = now - lastIndexActivityAt < INDEXING_RECENCY_MS ? 1 : 0;

    return {
        busy_sync: busySync,
        busy_db_tx: busyDbTx,
        busy_zotero_locked: busyLocked,
        busy_indexing: busyIndexing,
        busy_extracting: busyExtracting,
        extracting_hot_pending: extractingHotPending,
        extracting_background_pending: extractingBackgroundPending,
        extracting_hot_oldest_ms: extractingHotOldestMs,
        extracting_background_oldest_ms: extractingBackgroundOldestMs,
        window_hidden: windowHidden,
        event_loop_lag_ms: Math.max(0, now - lastTick - HEARTBEAT_INTERVAL_MS),
    };
}
