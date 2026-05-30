/**
 * Background extraction processor.
 *
 * Owns the `"background"` MuPDFWorkerClient and drains the
 * `background_jobs` queue (see `src/services/database.ts`). Lives on the
 * esbuild side of the bundle split, reached via
 * `Zotero.Beaver?.backgroundExtractor`.
 *
 * Lifecycle: `start()` schedules ticks; `stop()` aborts any in-flight job
 * (via the external abort signal threaded into `extractAndCacheDocument`),
 * waits for the current iteration to settle, and disposes the background
 * worker. `processOnce()` exists as a test hook — it drives one iteration
 * synchronously and never schedules a follow-up tick.
 *
 * The processor is intentionally conservative:
 *  - Idles when no main window is open (worker constructor unreachable).
 *  - Optionally backs off when the hot worker has pending dispatches.
 *  - Recycles the background worker every `RECYCLE_AFTER_N` completed jobs
 *    to bound the documented MuPDF WASM heap leak.
 *
 * v1 has no UI subscriber for the emitted events; they exist for future
 * telemetry / indexing UI work and are dispatched on `__beaverEventBus`.
 */

import {
    disposeMuPDFWorker,
    getExistingMuPDFWorkerClient,
} from '../beaver-extract';
import { extractAndCacheDocument } from './documentExtractionCore';
import type { BackgroundJobRecord } from './database';
import type { DocumentCache } from './documentCache';

/**
 * Local alias for the BeaverDB surface this processor actually uses.
 * Resolves to the structural type that `Zotero.Beaver?.db` exposes in the
 * global typings, which is a narrowed subset of the full `BeaverDB` class
 * exported by `database.ts`.
 */
type QueueDB = NonNullable<typeof Zotero.Beaver.db>;
import { logger } from '../utils/logger';
// Import `safeIsInTrash` from the react-free helper module
import { safeIsInTrash } from '../utils/zoteroItemUtils';
import { createAbortController } from '../utils/abortController';
import { getPref } from '../utils/prefs';
import { getSystemIdleTimeMs, registerIdleObserver } from '../utils/idleService';

const IDLE_INTERVAL_MS = 30_000;
const BUSY_INTERVAL_MS = 10;
const VISIBILITY_TIMEOUT_MS = 6 * 60_000;
const RECYCLE_AFTER_N = 8;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = (attempt: number) =>
    Math.min(60_000 * Math.pow(2, attempt - 1), 30 * 60_000);

/**
 * Defer the first claim by this much after `start()` so the loop does not
 * compete with main-window load and lets Zotero finish auto-sync.
 */
const STARTUP_DELAY_MS = 30_000;
/**
 * Threshold at which the user is considered idle. Jobs at or above
 * `LOW_PRIORITY_CEILING` only claim once `nsIUserIdleService.idleTime`
 * passes this mark.
 */
const IDLE_THRESHOLD_MS = 30_000;
const IDLE_THRESHOLD_SEC = 30;
/**
 * Exclusive upper bound used by the idle-aware claim. Jobs enqueued with
 * `priority < LOW_PRIORITY_CEILING` (e.g. hot-path retries) run any time;
 * `priority >= LOW_PRIORITY_CEILING` only runs while the user is idle.
 */
const LOW_PRIORITY_CEILING = 100;
const PREF_ENABLED = 'backgroundExtractorEnabled';

/**
 * Cooperative throttle: when the hot worker has pending dispatches, the
 * background processor skips its claim and waits a tick. Kept behind a
 * const flag so it's easy to disable if it starves the queue.
 */
const COOPERATIVE_THROTTLE = true;

export type ProcessOnceReason =
    | 'stopped'
    | 'shutting_down'
    | 'disabled'
    | 'no_window'
    | 'sync_in_progress'
    | 'hot_busy'
    | 'empty'
    | 'job_done';

export interface ProcessOnceResult {
    processed: boolean;
    reason?: ProcessOnceReason;
}

export class BackgroundExtractor {
    private stopRequested = false;
    private started = false;
    private currentTickId: ReturnType<typeof setTimeout> | undefined;
    private inFlight: Promise<void> | null = null;
    private inFlightAbortController: AbortController | null = null;
    private inFlightJobId: number | null = null;
    private jobsProcessedSinceRecycle = 0;
    /**
     * True while `tick()` is executing (from entry to its `finally`).
     * Used to (1) bounce re-entrant ticks when two timers race, and
     * (2) tell `notify()` to defer the wake to the active tick instead
     * of scheduling a parallel one.
     */
    private tickRunning = false;
    /**
     * Set by `notify()` when a tick is already running. The active
     * tick's tail consumes it to reschedule at 0ms, overriding its
     * default idle reschedule. Prevents the wake from being dropped
     * when an enqueue races with a tick that's about to schedule
     * `IDLE_INTERVAL_MS`.
     */
    private pendingWake = false;
    /**
     * Latched once shutdown is observed (via `Zotero.__beaverShuttingDown`
     * or `stop()` called during shutdown).
     */
    private dbWritesPermanentlyDisabled = false;
    /**
     * Set to `false` while the user has flipped the kill-switch pref off.
     * Re-checked at every claim; an in-flight job is not interrupted.
     */
    private prefEnabled = true;
    /**
     * Mirrors `Zotero.Sync.Runner.syncInProgress`. Maintained via the
     * `['sync']` notifier observer registered in `start()`. While true,
     * the loop returns `sync_in_progress` from `processOnce()` and waits
     * for the `'finish'` event to drain.
     */
    private syncInProgress = false;
    /**
     * Earliest epoch-ms at which a tick may fire. Set in `start()` to
     * `Date.now() + STARTUP_DELAY_MS`. Producers and observers that call
     * `notify()` during the delay record their intent (no events are
     * lost) but the scheduler clamps the actual wake to this floor.
     */
    private startupDelayUntil = 0;
    private prefObserverSymbol: symbol | null = null;
    private syncObserverId: string | null = null;
    private unregisterIdleObserver: (() => void) | null = null;

    /** Schedule the first tick. Safe to call more than once (idempotent). */
    start(): void {
        if (this.started) return;
        this.started = true;
        this.stopRequested = false;
        this.dbWritesPermanentlyDisabled = false;
        this.pendingWake = false;
        this.startupDelayUntil = Date.now() + STARTUP_DELAY_MS;

        // Pref: read initial value before registering the observer so a
        // race-flip during startup is caught by the observer.
        this.prefEnabled = (getPref(PREF_ENABLED) as boolean | undefined) ?? true;

        // Sync: register the observer FIRST, then read the current
        // `syncInProgress` getter. This closes the race window — if a
        // sync starts between read and register we would miss it; the
        // other ordering catches an already-running sync via the getter
        // and any subsequent transitions via the observer.
        try {
            const syncObs = {
                notify: (
                    event: string,
                    _type: string,
                    _ids: string[] | number[],
                    _extraData: object,
                ) => {
                    if (event === 'start') {
                        this.syncInProgress = true;
                    } else if (event === 'finish' || event === 'stop') {
                        // Zotero's sync runner emits 'finish' on normal
                        // completion (syncRunner.js); 'stop' is accepted
                        // defensively but is not part of the sync flow.
                        this.syncInProgress = false;
                        this.notify();
                    }
                },
            };
            this.syncObserverId = Zotero.Notifier.registerObserver(
                syncObs,
                ['sync'],
                'beaver-bg-extractor',
            );
        } catch (e) {
            logger(`BackgroundExtractor: registerObserver(sync) failed: ${e}`, 1);
        }
        try {
            this.syncInProgress = (Zotero as any).Sync?.Runner?.syncInProgress === true;
        } catch {
            this.syncInProgress = false;
        }

        // Pref observer: registered against the full global pref path so
        // `getPref(PREF_ENABLED)`-equivalent flips trigger a wake. Going
        // from disabled → enabled re-arms the loop via `notify()`.
        try {
            this.prefObserverSymbol = Zotero.Prefs.registerObserver(
                'extensions.zotero.beaver.backgroundExtractorEnabled',
                (value: unknown) => {
                    const next = value !== false;
                    const wasEnabled = this.prefEnabled;
                    this.prefEnabled = next;
                    if (!wasEnabled && next) this.notify();
                },
                true, // global pref path (not a branch-relative key)
            );
        } catch (e) {
            logger(`BackgroundExtractor: registerObserver(pref) failed: ${e}`, 1);
        }

        // Idle observer: push-based wake the moment the user crosses
        // the 30s idle threshold, instead of waiting up to IDLE_INTERVAL_MS
        // for the next poll tick.
        try {
            this.unregisterIdleObserver = registerIdleObserver(
                { onIdle: () => this.notify() },
                IDLE_THRESHOLD_SEC,
            );
        } catch (e) {
            logger(`BackgroundExtractor: registerIdleObserver failed: ${e}`, 1);
        }

        // First tick deferred by STARTUP_DELAY_MS so the loop does not
        // compete with main-window load / auto-sync kickoff.
        this.scheduleTick(STARTUP_DELAY_MS);
    }

    /**
     * Stop the processor:
     *  1. Set `stopRequested` so the next tick exits early.
     *  2. Cancel any pending tick timer.
     *  3. Abort the in-flight job (if any) via its external abort signal.
     *  4. Wait for the in-flight extraction to settle and release the job.
     *  5. Dispose the background worker so its WASM heap is released.
     */
    async stop(): Promise<void> {
        this.stopRequested = true;
        // Latch the per-instance disable NOW if global shutdown is in
        // progress
        if (Zotero.__beaverShuttingDown === true) {
            this.dbWritesPermanentlyDisabled = true;
        }
        // Tear down observers BEFORE the rest of shutdown so notifier or
        // idle callbacks cannot fire into a half-disposed processor.
        if (this.prefObserverSymbol) {
            try {
                Zotero.Prefs.unregisterObserver(this.prefObserverSymbol);
            } catch {
                // best-effort
            }
            this.prefObserverSymbol = null;
        }
        if (this.syncObserverId) {
            try {
                Zotero.Notifier.unregisterObserver(this.syncObserverId);
            } catch {
                // best-effort
            }
            this.syncObserverId = null;
        }
        if (this.unregisterIdleObserver) {
            try {
                this.unregisterIdleObserver();
            } catch {
                // best-effort
            }
            this.unregisterIdleObserver = null;
        }
        if (this.currentTickId !== undefined) {
            clearTimeout(this.currentTickId);
            this.currentTickId = undefined;
        }
        await this.abortAndAwaitInFlight();
        try {
            await disposeMuPDFWorker('background');
        } catch (e) {
            logger(`BackgroundExtractor.stop: disposeMuPDFWorker failed: ${e}`, 1);
        }
        this.started = false;
        this.pendingWake = false;
    }

    /**
     * Abort any in-flight job and wait for it to settle
     */
    async abortInFlight(): Promise<void> {
        await this.abortAndAwaitInFlight();
    }

    /**
     * Producer-side wake. Producers call this after enqueueing a job
     * they want picked up immediately, instead of waiting for the next
     * idle tick (up to `IDLE_INTERVAL_MS`). Safe to call any time.
     *
     * Behavior:
     *  - No-op when the processor is not started, has been stopped, or
     *    is in (latched) shutdown.
     *  - When a tick is already running (or a job is in flight from a
     *    direct `processOnce()` call), records a `pendingWake` that the
     *    active tick's tail consumes by rescheduling at 0ms instead of
     *    `IDLE_INTERVAL_MS`. This avoids two failure modes:
     *      (a) Scheduling a parallel 0ms tick that the active tick's
     *          own reschedule later cancels — dropping the wake.
     *      (b) Two ticks entering `processOnce()` concurrently and
     *          claiming different rows, leaking the first job's abort
     *          controller (only the latest `inFlight` is tracked).
     *  - Otherwise (idle, between ticks): reschedules the next tick to
     *    fire immediately.
     *
     * Bulk producers (e.g. library indexers) should call this **once
     * after a batch commit**, not per row, to avoid thrashing the
     * timer and to sidestep visibility races where the tick fires
     * before the transaction commits.
     */
    notify(): void {
        if (!this.started || this.stopRequested) return;
        if (this.dbWritesPermanentlyDisabled) return;
        if (Zotero.__beaverShuttingDown === true) return;
        if (this.tickRunning || this.inFlight) {
            this.pendingWake = true;
            return;
        }
        // Clamp to the startup-delay floor so a producer enqueue or an
        // observer callback during the first 30s cannot defeat the
        // delay. Once we are past the floor this is a no-op (max(0, neg)).
        const delay = Math.max(0, this.startupDelayUntil - Date.now());
        this.scheduleTick(delay);
    }

    private async abortAndAwaitInFlight(): Promise<void> {
        if (this.inFlightAbortController) {
            try {
                this.inFlightAbortController.abort();
            } catch (_e) {
                // best-effort
            }
        }
        if (this.inFlight) {
            try {
                await this.inFlight;
            } catch (_e) {
                // logged by processJob
            }
        }
    }

    /**
     * Skip DB writes once global shutdown has been observed
     */
    private shouldSkipDbWrites(): boolean {
        if (this.dbWritesPermanentlyDisabled) return true;
        if (Zotero.__beaverShuttingDown === true) {
            this.dbWritesPermanentlyDisabled = true;
            return true;
        }
        return false;
    }

    /**
     * Drive a single iteration of the tick loop synchronously and return
     * what happened. Used by tests and the dev `process-once` endpoint.
     * Never schedules a follow-up tick.
     */
    async processOnce(): Promise<ProcessOnceResult> {
        if (this.stopRequested) return { processed: false, reason: 'stopped' };

        // Global shutdown check BEFORE claim
        if (this.shouldSkipDbWrites()) {
            return { processed: false, reason: 'shutting_down' };
        }

        if (!this.prefEnabled) {
            return { processed: false, reason: 'disabled' };
        }

        const win = Zotero.getMainWindow?.() ?? null;
        if (!win) return { processed: false, reason: 'no_window' };

        if (this.syncInProgress) {
            return { processed: false, reason: 'sync_in_progress' };
        }

        if (COOPERATIVE_THROTTLE) {
            const hot = getExistingMuPDFWorkerClient('hot');
            if (hot && hot.getStats().pendingCount > 0) {
                return { processed: false, reason: 'hot_busy' };
            }
        }

        const db = Zotero.Beaver?.db;
        if (!db) return { processed: false, reason: 'empty' };

        // Idle gate: when the user is actively using the OS we still
        // run user-blocking work (priority < LOW_PRIORITY_CEILING, e.g.
        // hot-path retries) but defer library-scale indexing.
        const idleMs = getSystemIdleTimeMs();
        const maxPriority =
            idleMs >= IDLE_THRESHOLD_MS ? undefined : LOW_PRIORITY_CEILING;

        const record = await db.claimNextBackgroundJob(
            Date.now(),
            VISIBILITY_TIMEOUT_MS,
            maxPriority,
        );
        if (!record) return { processed: false, reason: 'empty' };

        logger(
            `BackgroundExtractor: claimed job id=${record.id} type=${record.jobType} ${record.libraryId}-${record.zoteroKey} mode=${record.mode} attempt=${record.attemptCount + 1}`,
            3,
        );
        await this.runJob(record, db);
        return { processed: true, reason: 'job_done' };
    }

    private scheduleTick(delayMs: number): void {
        if (this.stopRequested) return;
        if (this.currentTickId !== undefined) clearTimeout(this.currentTickId);
        const id = setTimeout(() => {
            this.currentTickId = undefined;
            this.tick().catch((e) => {
                logger(`BackgroundExtractor: tick threw: ${e}`, 1);
                // Always reschedule even after a failure so a transient
                // throw does not park the loop forever.
                this.scheduleTick(IDLE_INTERVAL_MS);
            });
        }, delayMs);
        (id as any)?.unref?.();
        this.currentTickId = id;
    }

    private async tick(): Promise<void> {
        if (this.stopRequested) return;
        // Re-entrancy guard: if a stale timer races with the active
        // tick (e.g. two timers queued before the first set
        // `currentTickId = undefined`), bail out cleanly so two ticks
        // do not run `processOnce()` in parallel.
        if (this.tickRunning) return;
        this.tickRunning = true;
        try {
            const result = await this.processOnce();

            if (this.stopRequested) return;

            if (result.processed) {
                this.jobsProcessedSinceRecycle += 1;
                if (this.jobsProcessedSinceRecycle >= RECYCLE_AFTER_N) {
                    try {
                        await disposeMuPDFWorker('background');
                    } catch (e) {
                        logger(
                            `BackgroundExtractor: recycle disposeMuPDFWorker failed: ${e}`,
                            1,
                        );
                    }
                    this.jobsProcessedSinceRecycle = 0;
                }
            }

            // Always honor a wake recorded during this tick — even when
            // the queue was empty this iteration — so a notify() racing
            // a pre-claim await is not swallowed by the default idle
            // reschedule. JS is single-threaded between these two lines,
            // so no notify() can sneak in and have its flag cleared.
            const wakeNow = this.pendingWake;
            this.pendingWake = false;
            if (wakeNow) {
                // Same startup-delay clamp as `notify()` — a wake recorded
                // during the first 30s must not bypass the delay floor.
                const delay = Math.max(0, this.startupDelayUntil - Date.now());
                this.scheduleTick(delay);
                return;
            }
            this.scheduleTick(
                result.processed ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS,
            );
        } finally {
            this.tickRunning = false;
        }
    }

    private async runJob(record: BackgroundJobRecord, db: QueueDB): Promise<void> {
        // Use the shim from `../utils/abortController`: in the chrome JS
        // realm where this runs, `AbortController` is not a top-level
        // global — it lives on the main window instead.
        const abortController = createAbortController();
        this.inFlightAbortController = abortController;
        this.inFlightJobId = record.id;
        const completion = this.processJob(record, db, abortController.signal);
        this.inFlight = completion;
        try {
            await completion;
        } finally {
            this.inFlight = null;
            this.inFlightAbortController = null;
            this.inFlightJobId = null;
        }
    }

    private async processJob(
        record: BackgroundJobRecord,
        db: QueueDB,
        externalAbortSignal: AbortSignal,
    ): Promise<void> {
        dispatchBackgroundEvent('background-job:start', { id: record.id, record });

        let item: Zotero.Item | null = null;
        try {
            const lookup = await Zotero.Items.getByLibraryAndKeyAsync(
                record.libraryId,
                record.zoteroKey,
            );
            item = lookup || null;
        } catch (e) {
            logger(
                `BackgroundExtractor: getByLibraryAndKeyAsync failed for ${record.libraryId}-${record.zoteroKey}: ${e}`,
                1,
            );
        }
        if (!item || safeIsInTrash(item) === true) {
            if (this.shouldSkipDbWrites()) return;
            await db.completeBackgroundJob(record.id);
            dispatchBackgroundEvent('background-job:done', {
                id: record.id,
                reason: !item ? 'item_missing' : 'in_trash',
            });
            return;
        }

        const payload = record.payload;
        if (!payload) {
            if (this.shouldSkipDbWrites()) return;
            await db.completeBackgroundJob(record.id);
            dispatchBackgroundEvent('background-job:done', {
                id: record.id,
                reason: 'missing_payload',
            });
            return;
        }

        let result;
        try {
            result = await extractAndCacheDocument({
                libraryId: record.libraryId,
                zoteroKey: record.zoteroKey,
                mode: record.mode,
                maxPages: payload.maxPages,
                maxFileSizeMB: payload.maxFileSizeMB,
                timeoutSeconds: payload.timeoutSeconds,
                workerName: 'background',
                externalAbortSignal,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.recordFailure(db, record.id, `unexpected: ${message}`);
            dispatchBackgroundEvent('background-job:failed', {
                id: record.id,
                error: message,
            });
            return;
        }

        await this.classifyAndPersist(result, record, db);
    }

    private async classifyAndPersist(
        result: Awaited<ReturnType<typeof extractAndCacheDocument>>,
        record: BackgroundJobRecord,
        db: QueueDB,
    ): Promise<void> {
        if (this.shouldSkipDbWrites()) return;
        switch (result.kind) {
            case 'ok':
                await db.completeBackgroundJob(record.id);
                logger(
                    `BackgroundExtractor: job id=${record.id} done (ok) pages=${result.totalPages}`,
                    3,
                );
                dispatchBackgroundEvent('background-job:done', {
                    id: record.id,
                    reason: 'ok',
                });
                return;
            case 'external_abort':
                await db.releaseBackgroundJob(record.id, Date.now());
                logger(
                    `BackgroundExtractor: job id=${record.id} released (external_abort)`,
                    3,
                );
                dispatchBackgroundEvent('background-job:done', {
                    id: record.id,
                    reason: 'external_abort',
                });
                return;
            case 'cached_error':
                await db.completeBackgroundJob(record.id);
                logger(
                    `BackgroundExtractor: job id=${record.id} done (cached_error:${result.code})`,
                    3,
                );
                dispatchBackgroundEvent('background-job:done', {
                    id: record.id,
                    reason: `cached_error:${result.code}`,
                });
                return;
            case 'timeout':
                await this.recordFailure(
                    db,
                    record.id,
                    `timeout:${result.phase}`,
                );
                dispatchBackgroundEvent('background-job:failed', {
                    id: record.id,
                    error: `timeout:${result.phase}`,
                });
                return;
            case 'response_error': {
                if (isTransientResponseError(result.code)) {
                    await this.recordFailure(
                        db,
                        record.id,
                        `${result.code}: ${result.message}`,
                    );
                    dispatchBackgroundEvent('background-job:failed', {
                        id: record.id,
                        error: result.code,
                    });
                    return;
                }
                await db.completeBackgroundJob(record.id);
                logger(
                    `BackgroundExtractor: job id=${record.id} done (terminal:${result.code})`,
                    3,
                );
                dispatchBackgroundEvent('background-job:done', {
                    id: record.id,
                    reason: `terminal:${result.code}`,
                });
                return;
            }
        }
    }

    private async recordFailure(
        db: QueueDB,
        id: number,
        error: string,
    ): Promise<void> {
        if (this.shouldSkipDbWrites()) return;
        const outcome = await db.failBackgroundJob(id, error, {
            maxAttempts: MAX_ATTEMPTS,
            backoffMs: BACKOFF_MS,
            now: Date.now(),
        });
        if (outcome.dead) {
            logger(
                `BackgroundExtractor: job id=${id} dead-lettered: ${error}`,
                1,
            );
            dispatchBackgroundEvent('background-job:dead', { id, error });
        } else {
            logger(
                `BackgroundExtractor: job id=${id} failed, retry scheduled: ${error}`,
                2,
            );
        }
    }
}

function isTransientResponseError(code: string): boolean {
    return code === 'download_failed' || code === 'extraction_failed';
}

function dispatchBackgroundEvent(name: string, detail: unknown): void {
    const win = Zotero.getMainWindow?.() ?? null;
    if (!win) return;
    const bus = win.__beaverEventBus;
    if (!bus) return;
    try {
        const Ctor = (win as any).CustomEvent ?? CustomEvent;
        bus.dispatchEvent(new Ctor(name, { detail }));
    } catch (e) {
        logger(`background event dispatch failed for ${name}: ${e}`, 2);
    }
}

// Suppress unused warning — the DocumentCache module is required only at
// runtime by the extraction core; this `import type` keeps the dependency
// visible in tooling.
export type _DocumentCacheUsed = DocumentCache;
