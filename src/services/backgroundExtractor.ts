/**
 * Background processing dispatcher.
 *
 * Owns the `"background"` MuPDFWorkerClient and drains registered lanes from
 * the `background_jobs` queue. The exported class name is kept stable because
 * addon lifecycle hooks and dev endpoints reach it through
 * `Zotero.Beaver?.backgroundExtractor`.
 */

import {
    disposeMuPDFWorker,
    getExistingMuPDFWorkerClient,
} from '../beaver-extract';
import type {
    BackgroundJobInput,
    BackgroundJobRecord,
    BackgroundJobType,
} from './database';
import { DocumentExtractExecutor } from './backgroundQueue/documentExtractExecutor';
import type {
    JobExecutionContext,
    JobExecutor,
    JobOutcome,
    QueueDB,
} from './backgroundQueue/jobExecutor';
import { MuPDFLane } from './backgroundQueue/muPDFLane';
import { logger } from '../utils/logger';
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

const STARTUP_DELAY_MS = 30_000;
const IDLE_THRESHOLD_MS = 30_000;
const IDLE_THRESHOLD_SEC = 30;
const LOW_PRIORITY_CEILING = 100;
const PREF_ENABLED = 'backgroundExtractorEnabled';
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

export type BackgroundLaneStatus = Partial<
    Record<BackgroundJobType, { inFlight: number; capacity: number }>
>;

type LaneEntry = {
    promise: Promise<void>;
    abort: AbortController;
};

type ExecutorRegistration = {
    executor: JobExecutor;
    maxInFlight: number;
};

export class BackgroundExtractor {
    private stopRequested = false;
    private started = false;
    private currentTickId: ReturnType<typeof setTimeout> | undefined;
    private tickRunning = false;
    private pendingWake = false;
    private dbWritesPermanentlyDisabled = false;
    private prefEnabled = true;
    private syncInProgress = false;
    private startupDelayUntil = 0;
    private prefObserverSymbol: symbol | null = null;
    private syncObserverId: string | null = null;
    private unregisterIdleObserver: (() => void) | null = null;
    private workerRunning = false;
    private readonly executors = new Map<BackgroundJobType, ExecutorRegistration>();
    private readonly laneInFlight = new Map<BackgroundJobType, Map<number, LaneEntry>>();
    private readonly muPDFLane = new MuPDFLane(RECYCLE_AFTER_N);

    constructor() {
        this.registerExecutor(new DocumentExtractExecutor(), { maxInFlight: 1 });
    }

    /** Return the current background worker activity state for UI subscribers. */
    getStatus(): { running: boolean } {
        return { running: this.workerRunning };
    }

    /** Return capacity and in-flight counts for registered lanes. */
    getLaneStatus(): BackgroundLaneStatus {
        const status: BackgroundLaneStatus = {};
        for (const [jobType, registration] of this.executors) {
            status[jobType] = {
                inFlight: this.laneInFlight.get(jobType)?.size ?? 0,
                capacity: registration.maxInFlight,
            };
        }
        return status;
    }

    /** Register a queue executor and activate its lane. */
    registerExecutor(
        executor: JobExecutor,
        options: { maxInFlight: number },
    ): void {
        const maxInFlight = Math.max(1, Math.floor(options.maxInFlight));
        this.executors.set(executor.jobType, { executor, maxInFlight });
        if (!this.laneInFlight.has(executor.jobType)) {
            this.laneInFlight.set(executor.jobType, new Map());
        }
        this.notify();
    }

    /** Schedule the first tick. Safe to call more than once. */
    start(): void {
        if (this.started) return;
        this.started = true;
        this.stopRequested = false;
        this.dbWritesPermanentlyDisabled = false;
        this.pendingWake = false;
        this.startupDelayUntil = Date.now() + STARTUP_DELAY_MS;

        this.prefEnabled = (getPref(PREF_ENABLED) as boolean | undefined) ?? true;

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

        try {
            this.prefObserverSymbol = Zotero.Prefs.registerObserver(
                'extensions.zotero.beaver.backgroundExtractorEnabled',
                (value: unknown) => {
                    const next = value !== false;
                    const wasEnabled = this.prefEnabled;
                    this.prefEnabled = next;
                    if (!wasEnabled && next) this.notify();
                },
                true,
            );
        } catch (e) {
            logger(`BackgroundExtractor: registerObserver(pref) failed: ${e}`, 1);
        }

        try {
            this.unregisterIdleObserver = registerIdleObserver(
                { onIdle: () => this.notify() },
                IDLE_THRESHOLD_SEC,
            );
        } catch (e) {
            logger(`BackgroundExtractor: registerIdleObserver failed: ${e}`, 1);
        }

        this.scheduleTick(STARTUP_DELAY_MS);
    }

    /**
     * Stop the dispatcher, abort all active lanes, and release the background
     * MuPDF worker.
     */
    async stop(): Promise<void> {
        this.stopRequested = true;
        if (Zotero.__beaverShuttingDown === true) {
            this.dbWritesPermanentlyDisabled = true;
        }

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
        this.setWorkerRunning(false);
        this.started = false;
        this.pendingWake = false;
    }

    /** Abort every active lane and wait for all jobs to settle. */
    async abortInFlight(): Promise<void> {
        await this.abortAndAwaitInFlight();
        this.setWorkerRunning(this.totalInFlight() > 0);
    }

    /**
     * Producer-side wake. In-flight IO jobs do not block scheduling because
     * free capacity in another lane may still be claimable.
     */
    notify(): void {
        if (!this.started || this.stopRequested) return;
        if (this.dbWritesPermanentlyDisabled) return;
        if (Zotero.__beaverShuttingDown === true) return;
        if (this.tickRunning) {
            this.pendingWake = true;
            return;
        }
        const delay = Math.max(0, this.startupDelayUntil - Date.now());
        this.scheduleTick(delay);
    }

    private async abortAndAwaitInFlight(): Promise<void> {
        const promises: Promise<void>[] = [];
        for (const lane of this.laneInFlight.values()) {
            for (const entry of lane.values()) {
                try {
                    entry.abort.abort();
                } catch {
                    // best-effort
                }
                promises.push(entry.promise);
            }
        }
        await Promise.allSettled(promises);
    }

    /** Skip DB writes once global shutdown has been observed. */
    private shouldSkipDbWrites(): boolean {
        if (this.dbWritesPermanentlyDisabled) return true;
        if (Zotero.__beaverShuttingDown === true) {
            this.dbWritesPermanentlyDisabled = true;
            return true;
        }
        return false;
    }

    private setWorkerRunning(running: boolean): void {
        if (this.workerRunning === running) return;
        this.workerRunning = running;
        dispatchBackgroundEvent('background-worker:status', { running });
    }

    /**
     * Drive one dispatcher pass. Tests can pass `awaitLaunchedJobs: true` to
     * await IO lanes; the dev endpoint uses the default non-blocking behavior.
     */
    async processOnce(
        options: {
            keepRunningAfterJob?: boolean;
            awaitLaunchedJobs?: boolean;
        } = {},
    ): Promise<ProcessOnceResult> {
        const inactive = (reason: ProcessOnceReason): ProcessOnceResult => {
            if (this.totalInFlight() === 0) this.setWorkerRunning(false);
            return { processed: false, reason };
        };

        if (this.stopRequested) return inactive('stopped');
        if (this.shouldSkipDbWrites()) return inactive('shutting_down');
        if (!this.prefEnabled) return inactive('disabled');

        const win = Zotero.getMainWindow?.() ?? null;
        if (!win) return inactive('no_window');

        if (this.syncInProgress) return inactive('sync_in_progress');

        if (COOPERATIVE_THROTTLE) {
            const hot = getExistingMuPDFWorkerClient('hot');
            if (hot && hot.getStats().pendingCount > 0) {
                return inactive('hot_busy');
            }
        }

        const db = Zotero.Beaver?.db;
        if (!db || this.executors.size === 0) return inactive('empty');

        const idleMs = getSystemIdleTimeMs();
        const maxPriority =
            idleMs >= IDLE_THRESHOLD_MS ? undefined : LOW_PRIORITY_CEILING;

        const launched = await this.dispatchPass({
            db,
            maxPriority,
            awaitLaunchedJobs: options.awaitLaunchedJobs === true,
        });

        if (launched === 0) return inactive('empty');
        if (!options.keepRunningAfterJob && this.totalInFlight() === 0) {
            this.setWorkerRunning(false);
        }
        return { processed: true, reason: 'job_done' };
    }

    private async dispatchPass(options: {
        db: QueueDB;
        maxPriority?: number;
        awaitLaunchedJobs: boolean;
    }): Promise<number> {
        let launched = 0;
        const waits: Promise<void>[] = [];
        for (const [jobType, registration] of this.executors) {
            const freeSlots = this.laneCapacityFree(jobType);
            for (let slot = 0; slot < freeSlots; slot += 1) {
                if (this.stopRequested) return launched;
                const record = await options.db.claimNextBackgroundJob(
                    Date.now(),
                    VISIBILITY_TIMEOUT_MS,
                    options.maxPriority,
                    [jobType],
                );
                if (!record) break;
                if (this.stopRequested) {
                    if (!this.shouldSkipDbWrites()) {
                        await options.db.releaseBackgroundJob(record.id, Date.now());
                    }
                    return launched;
                }

                logger(
                    `BackgroundExtractor: claimed job id=${record.id} type=${record.jobType} ${record.libraryId}-${record.zoteroKey} content_kind=${record.contentKind} payload_kind=${record.payloadKind} attempt=${record.attemptCount + 1}`,
                    3,
                );
                launched += 1;
                const shouldAwait =
                    jobType === 'document_extract' || options.awaitLaunchedJobs;
                const promise = this.launchJob(
                    record,
                    registration.executor,
                    jobType !== 'document_extract',
                );
                if (shouldAwait) {
                    waits.push(promise);
                }
            }
        }
        if (waits.length > 0) {
            await Promise.all(waits);
        }
        return launched;
    }

    private launchJob(
        record: BackgroundJobRecord,
        executor: JobExecutor,
        notifyOnSettle: boolean,
    ): Promise<void> {
        const abort = createAbortController();
        const lane = this.laneInFlight.get(record.jobType) ?? new Map<number, LaneEntry>();
        this.laneInFlight.set(record.jobType, lane);
        this.setWorkerRunning(true);

        const promise = this.executeAndPersist(record, executor, abort.signal)
            .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                logger(`BackgroundExtractor: job id=${record.id} threw: ${message}`, 1);
            })
            .finally(() => {
                lane.delete(record.id);
                if (this.totalInFlight() === 0 && !this.tickRunning) {
                    this.setWorkerRunning(false);
                }
                if (notifyOnSettle) {
                    this.notify();
                }
            });
        lane.set(record.id, { promise, abort });
        return promise;
    }

    private async executeAndPersist(
        record: BackgroundJobRecord,
        executor: JobExecutor,
        externalAbortSignal: AbortSignal,
    ): Promise<void> {
        dispatchBackgroundEvent('background-job:start', { id: record.id, record });
        const db = Zotero.Beaver?.db;
        if (!db) return;

        const ctx: JobExecutionContext = {
            db,
            runOnMuPDFWorker: (fn) => this.muPDFLane.run(fn),
            externalAbortSignal,
            shouldSkipDbWrites: () => this.shouldSkipDbWrites(),
            enqueue: async (input: BackgroundJobInput) => {
                await db.enqueueBackgroundJob(input);
                this.notify();
            },
        };

        let outcome: JobOutcome;
        try {
            outcome = await executor.execute(record, ctx);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            outcome = { kind: 'retry', error: `unexpected: ${message}` };
        }

        await this.persistOutcome(record, executor, outcome, db);
    }

    private async persistOutcome(
        record: BackgroundJobRecord,
        executor: JobExecutor,
        outcome: JobOutcome,
        db: QueueDB,
    ): Promise<void> {
        if (this.shouldSkipDbWrites()) return;

        switch (outcome.kind) {
            case 'complete':
                await db.completeBackgroundJob(record.id);
                logger(
                    `BackgroundExtractor: job id=${record.id} done (${outcome.reason})`,
                    3,
                );
                dispatchBackgroundEvent('background-job:done', {
                    id: record.id,
                    reason: outcome.reason,
                });
                return;
            case 'release':
                await db.releaseBackgroundJob(record.id, Date.now());
                logger(
                    `BackgroundExtractor: job id=${record.id} released (${outcome.reason})`,
                    3,
                );
                dispatchBackgroundEvent('background-job:done', {
                    id: record.id,
                    reason: outcome.reason,
                });
                return;
            case 'retry':
                await this.recordRetryFailure(record, executor, outcome, db);
                return;
            case 'failPermanent':
                await db.recordDocumentProcessingFailure(outcome.failure);
                await db.completeBackgroundJob(record.id);
                dispatchBackgroundEvent('background-job:done', {
                    id: record.id,
                    reason:
                        outcome.reason
                        ?? (
                            outcome.failure.terminalCode
                                ? `terminal:${outcome.failure.terminalCode}`
                                : 'terminal'
                        ),
                });
                return;
        }
    }

    private async recordRetryFailure(
        record: BackgroundJobRecord,
        executor: JobExecutor,
        outcome: Extract<JobOutcome, { kind: 'retry' }>,
        db: QueueDB,
    ): Promise<void> {
        const result = await db.failBackgroundJob(record.id, outcome.error, {
            maxAttempts: MAX_ATTEMPTS,
            backoffMs: BACKOFF_MS,
            now: Date.now(),
        });
        if (result.dead) {
            const failure = executor.describeFailure?.(record, outcome.error) ?? null;
            if (failure) {
                await db.recordDocumentProcessingFailure(failure);
            }
            logger(
                `BackgroundExtractor: job id=${record.id} dead-lettered: ${outcome.error}`,
                1,
            );
            dispatchBackgroundEvent('background-job:dead', {
                id: record.id,
                error: outcome.error,
                reason: outcome.reason,
            });
            return;
        }

        logger(
            `BackgroundExtractor: job id=${record.id} failed, retry scheduled: ${outcome.error}`,
            2,
        );
        dispatchBackgroundEvent('background-job:failed', {
            id: record.id,
            error: outcome.error,
            reason: outcome.reason,
        });
    }

    private scheduleTick(delayMs: number): void {
        if (this.stopRequested) return;
        if (this.currentTickId !== undefined) clearTimeout(this.currentTickId);
        const id = setTimeout(() => {
            this.currentTickId = undefined;
            this.tick().catch((e) => {
                logger(`BackgroundExtractor: tick threw: ${e}`, 1);
                this.scheduleTick(IDLE_INTERVAL_MS);
            });
        }, delayMs);
        (id as any)?.unref?.();
        this.currentTickId = id;
    }

    private async tick(): Promise<void> {
        if (this.stopRequested) return;
        if (this.tickRunning) return;
        this.tickRunning = true;
        try {
            const result = await this.processOnce({ keepRunningAfterJob: true });
            if (this.stopRequested) return;

            const wakeNow = this.pendingWake;
            this.pendingWake = false;
            if (wakeNow) {
                const delay = Math.max(0, this.startupDelayUntil - Date.now());
                this.scheduleTick(delay);
                return;
            }

            this.scheduleTick(
                result.processed || this.totalInFlight() > 0
                    ? BUSY_INTERVAL_MS
                    : IDLE_INTERVAL_MS,
            );
        } finally {
            this.tickRunning = false;
        }
    }

    private laneCapacityFree(jobType: BackgroundJobType): number {
        const registration = this.executors.get(jobType);
        if (!registration) return 0;
        const inFlight = this.laneInFlight.get(jobType)?.size ?? 0;
        return Math.max(0, registration.maxInFlight - inFlight);
    }

    private totalInFlight(): number {
        let total = 0;
        for (const lane of this.laneInFlight.values()) {
            total += lane.size;
        }
        return total;
    }
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
