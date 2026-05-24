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
import { safeIsInTrash } from '../utils/zoteroUtils';

const IDLE_INTERVAL_MS = 30_000;
const BUSY_INTERVAL_MS = 250;
const VISIBILITY_TIMEOUT_MS = 6 * 60_000;
const RECYCLE_AFTER_N = 8;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = (attempt: number) =>
    Math.min(60_000 * Math.pow(2, attempt - 1), 30 * 60_000);

/**
 * Cooperative throttle: when the hot worker has pending dispatches, the
 * background processor skips its claim and waits a tick. Kept behind a
 * const flag so it's easy to disable if it starves the queue.
 */
const COOPERATIVE_THROTTLE = true;

export type ProcessOnceReason =
    | 'stopped'
    | 'shutting_down'
    | 'no_window'
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
     * Latched once shutdown is observed (via `Zotero.__beaverShuttingDown`
     * or `stop()` called during shutdown).
     */
    private dbWritesPermanentlyDisabled = false;

    /** Schedule the first tick. Safe to call more than once (idempotent). */
    start(): void {
        if (this.started) return;
        this.started = true;
        this.stopRequested = false;
        this.dbWritesPermanentlyDisabled = false;
        this.scheduleTick(BUSY_INTERVAL_MS);
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
    }

    /**
     * Abort any in-flight job and wait for it to settle
     */
    async abortInFlight(): Promise<void> {
        await this.abortAndAwaitInFlight();
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

        const win = Zotero.getMainWindow?.() ?? null;
        if (!win) return { processed: false, reason: 'no_window' };

        if (COOPERATIVE_THROTTLE) {
            const hot = getExistingMuPDFWorkerClient('hot');
            if (hot && hot.getStats().pendingCount > 0) {
                return { processed: false, reason: 'hot_busy' };
            }
        }

        const db = Zotero.Beaver?.db;
        if (!db) return { processed: false, reason: 'empty' };

        const record = await db.claimNextBackgroundJob(
            Date.now(),
            VISIBILITY_TIMEOUT_MS,
        );
        if (!record) return { processed: false, reason: 'empty' };

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
            this.scheduleTick(BUSY_INTERVAL_MS);
            return;
        }

        this.scheduleTick(IDLE_INTERVAL_MS);
    }

    private async runJob(record: BackgroundJobRecord, db: QueueDB): Promise<void> {
        const abortController = new AbortController();
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
                dispatchBackgroundEvent('background-job:done', {
                    id: record.id,
                    reason: 'ok',
                });
                return;
            case 'external_abort':
                await db.releaseBackgroundJob(record.id, Date.now());
                dispatchBackgroundEvent('background-job:done', {
                    id: record.id,
                    reason: 'external_abort',
                });
                return;
            case 'cached_error':
                await db.completeBackgroundJob(record.id);
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
            dispatchBackgroundEvent('background-job:dead', { id, error });
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
