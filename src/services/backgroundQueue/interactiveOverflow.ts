/**
 * Routes interactive PDF requests (the agent's document reads, page images,
 * views and searches) between the hot MuPDF worker and the background worker.
 *
 * Routing is per request (`acquire`, called at the request's first worker op);
 * every op of that request stays on the chosen worker. A request that arrives
 * while the hot worker is idle uses hot. One that finds hot busy uses the
 * background worker when it can take the request right now:
 *
 * - the background MuPDF lane is free and is taken without waiting, so the
 *   request is one more exclusive user of the background worker;
 * - no background job that uses the worker is in flight (running jobs are
 *   never interrupted, and their next lane use must not queue behind
 *   interactive work);
 * - the background worker is started and warm. A cold worker can be slower
 *   than waiting for hot, so a request never runs on a starting worker.
 *
 * Otherwise the request waits in a request-level queue (first in, first out)
 * that the workers claim from: the hot worker when the request routed to it
 * finishes, the background worker when its warm-up completes, when it finishes
 * an interactive request, or when the background job using it settles. A
 * request that finds the background worker cold starts its warm-up. When both
 * workers are free, a request prefers the one that last handled the same file,
 * which may still have it open.
 *
 * A request waits only while a request routed to hot is open, so a wake-up is
 * guaranteed. When hot is busy with other work only (UI features that use the
 * hot worker directly), or the kill switch is off, it goes to hot at once and
 * waits in that worker's op queue, as before.
 *
 * While interactive work is pending or waiting, holds the background lane, or
 * an interactive warm-up runs, the background extractor does not claim new
 * jobs (`blocksBackgroundJobs`). Releasing the last of these wakes the
 * dispatcher.
 */

import {
    WorkerAbortError,
    getExistingMuPDFWorkerClient,
    getMuPDFWorkerClient,
    type PDFWorkerSlotName,
} from '../../beaver-extract';
import { logger } from '@beaver/agent-core/platform/logger';
import { getPref } from '../../utils/prefs';
import type { MuPDFSerialLane } from './muPDFSerialLane';

/** Why a request that found the hot worker busy could not use the background worker. */
export type OverflowSkipReason = 'lane_busy' | 'bg_not_warm' | 'disabled';

/**
 * Routing counters: how requests arrived (`hot_idle`, `affinity` (hot idle,
 * but the background worker last had the file), `overflow`, or a skip
 * reason), how many of the skipped ones waited (`queued`), and how waiting
 * requests ended (`claimed_hot`, `claimed_background`, `aborted`).
 */
export type OverflowDecision =
    | 'hot_idle'
    | 'affinity'
    | 'overflow'
    | OverflowSkipReason
    | 'queued'
    | 'claimed_hot'
    | 'claimed_background'
    | 'aborted';

/** The worker one interactive request uses for all of its ops. */
export interface InteractiveWorkerRoute {
    slot: PDFWorkerSlotName;
    /** Set when the hot worker was busy but the request still ran on it. */
    overflowSkip?: OverflowSkipReason;
    /** Release the route once the request and its worker ops are done. Idempotent. */
    release(): void;
}

export interface InteractiveRouteRequest {
    /** Abandons the wait (the request's deadline); rejects with `WorkerAbortError`. */
    signal?: AbortSignal;
    /** Identifies the request's file, for worker affinity (`libraryID/key`). */
    affinityKey?: string;
}

export interface InteractiveOverflowStats {
    hotRoutes: number;
    overflowRoutes: number;
    waiting: number;
    prewarming: boolean;
    decisions: Record<OverflowDecision, number>;
}

export interface InteractiveOverflowDeps {
    lane: MuPDFSerialLane;
    /** Whether the background extractor accepts work (started, not stopping). */
    isAvailable(): boolean;
    /** Whether a background job that may use the background worker is in flight. */
    hasWorkerJobInFlight(): boolean;
    /** Interactive work stopped blocking job claims. */
    onDrained(): void;
}

interface Waiter {
    affinityKey?: string;
    skip: OverflowSkipReason;
    resolve(route: InteractiveWorkerRoute): void;
    detach(): void;
}

/**
 * How long a worker counts as still having a file open: the worker keeps an
 * opened document for 60 s after its last op on it.
 */
const AFFINITY_MS = 60_000;
const AFFINITY_MAX_ENTRIES = 64;
/**
 * Most requests that wait at once, matching the worker's op queue. Beyond it
 * a request goes to hot, whose op queue applies its own limit
 * (`WorkerQueueFullError`), as before requests could wait here.
 */
const MAX_WAITING = 32;

export class InteractiveOverflow {
    /** Open requests routed to hot (counted from their first op until they finish). */
    private hotRoutes = 0;
    /** Open requests holding the lane for the background worker. */
    private overflowRoutes = 0;
    private prewarming = false;
    private readonly waiters: Waiter[] = [];
    /** Which worker last finished a request for each file, and when. */
    private readonly recent = new Map<string, { slot: PDFWorkerSlotName; at: number }>();
    private readonly decisions: Record<OverflowDecision, number> = {
        hot_idle: 0,
        affinity: 0,
        overflow: 0,
        lane_busy: 0,
        bg_not_warm: 0,
        disabled: 0,
        queued: 0,
        claimed_hot: 0,
        claimed_background: 0,
        aborted: 0,
    };

    constructor(private readonly deps: InteractiveOverflowDeps) {}

    /**
     * Whether the hot worker is occupied: an interactive request routed to it
     * is still open, or any hot op is pending or queued.
     */
    isHotBusy(): boolean {
        if (this.hotRoutes > 0) return true;
        const hot = getExistingMuPDFWorkerClient('hot');
        return hot !== null && hot.inFlight + hot.queued > 0;
    }

    /** Whether new background jobs must wait for interactive work. */
    blocksBackgroundJobs(): boolean {
        return this.overflowRoutes > 0
            || this.prewarming
            || this.waiters.length > 0
            || this.isHotBusy();
    }

    /** Choose the worker for one interactive request, waiting for one if needed. */
    acquire(request: InteractiveRouteRequest = {}): Promise<InteractiveWorkerRoute> {
        const { signal, affinityKey } = request;
        if (signal?.aborted) return Promise.reject(new WorkerAbortError());
        // Catch up on capacity freed without a wake-up (pref or availability changes).
        this.pump();
        if (this.waiters.length > 0) {
            // Requests ahead are waiting; this one queues behind them.
            const skip = this.backgroundBlocker() ?? 'lane_busy';
            this.decisions[skip] += 1;
            if (skip === 'bg_not_warm') this.startPrewarm();
            return this.waitOrQueueOnHot(skip, request);
        }
        const blocker = this.backgroundBlocker();
        if (!this.isHotBusy()) {
            if (blocker === null && this.lastSlot(affinityKey) === 'background') {
                const route = this.backgroundRoute(affinityKey);
                if (route) {
                    this.decisions.affinity += 1;
                    return Promise.resolve(route);
                }
            }
            this.decisions.hot_idle += 1;
            return Promise.resolve(this.hotRoute(affinityKey));
        }
        if (blocker === null) {
            const route = this.backgroundRoute(affinityKey);
            if (route) {
                this.decisions.overflow += 1;
                logger('InteractiveOverflow: hot worker busy, request runs on the background worker', 3);
                return Promise.resolve(route);
            }
        }
        const skip = blocker ?? 'lane_busy';
        this.decisions[skip] += 1;
        if (skip === 'bg_not_warm') this.startPrewarm();
        if (skip !== 'disabled' && this.hotRoutes > 0) return this.waitOrQueueOnHot(skip, request);
        logger(`InteractiveOverflow: hot worker busy, request queues on hot (${skip})`, 3);
        return Promise.resolve(this.hotRoute(affinityKey, skip));
    }

    /** A background job that uses the background worker settled; waiting requests may take it. */
    onJobSettled(): void {
        this.pump();
    }

    getStats(): InteractiveOverflowStats {
        return {
            hotRoutes: this.hotRoutes,
            overflowRoutes: this.overflowRoutes,
            waiting: this.waiters.length,
            prewarming: this.prewarming,
            decisions: { ...this.decisions },
        };
    }

    private waitOrQueueOnHot(skip: OverflowSkipReason, request: InteractiveRouteRequest): Promise<InteractiveWorkerRoute> {
        if (this.waiters.length < MAX_WAITING) return this.wait(skip, request);
        logger(`InteractiveOverflow: ${MAX_WAITING} requests waiting, request queues on hot (${skip})`, 2);
        return Promise.resolve(this.hotRoute(request.affinityKey, skip));
    }

    private wait(skip: OverflowSkipReason, request: InteractiveRouteRequest): Promise<InteractiveWorkerRoute> {
        this.decisions.queued += 1;
        logger(`InteractiveOverflow: both workers busy, request waits (${skip}, ${this.waiters.length} ahead)`, 3);
        const { signal, affinityKey } = request;
        return new Promise<InteractiveWorkerRoute>((resolve, reject) => {
            const onAbort = () => {
                const index = this.waiters.indexOf(waiter);
                if (index < 0) return;
                this.waiters.splice(index, 1);
                this.decisions.aborted += 1;
                reject(new WorkerAbortError());
                this.notifyIfDrained();
            };
            const waiter: Waiter = {
                affinityKey,
                skip,
                resolve,
                detach: () => signal?.removeEventListener('abort', onAbort),
            };
            this.waiters.push(waiter);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    /**
     * Hand waiting requests, oldest first, to whichever worker is free. When
     * requests are left waiting and the background worker is only cold, start
     * its warm-up (`mayWarm`; false after a warm-up, so a failing one is not
     * retried in a loop: the next release tries again).
     */
    private pump(mayWarm = true): void {
        while (this.waiters.length > 0) {
            const head = this.waiters[0];
            const hotFree = this.hotRoutes === 0;
            const backgroundFree = this.backgroundBlocker() === null;
            const slot: PDFWorkerSlotName | null = hotFree && backgroundFree
                ? this.lastSlot(head.affinityKey) ?? 'hot'
                : hotFree ? 'hot' : backgroundFree ? 'background' : null;
            if (slot === null) {
                if (mayWarm && this.backgroundBlocker() === 'bg_not_warm') this.startPrewarm();
                return;
            }
            const route = slot === 'background'
                ? this.backgroundRoute(head.affinityKey)
                : this.hotRoute(head.affinityKey, head.skip);
            if (!route) return;
            this.waiters.shift();
            head.detach();
            this.decisions[slot === 'background' ? 'claimed_background' : 'claimed_hot'] += 1;
            logger(`InteractiveOverflow: waiting request runs on the ${slot} worker`, 3);
            head.resolve(route);
        }
    }

    private backgroundBlocker(): OverflowSkipReason | null {
        if (getPref('pdf.backgroundOverflow') === false || !this.deps.isAvailable()) return 'disabled';
        if (!this.deps.lane.isFree || this.deps.hasWorkerJobInFlight()) return 'lane_busy';
        const background = getExistingMuPDFWorkerClient('background');
        if (!background?.isWarm()) return 'bg_not_warm';
        if (background.inFlight + background.queued > 0) return 'lane_busy';
        return null;
    }

    private lastSlot(affinityKey: string | undefined): PDFWorkerSlotName | undefined {
        if (!affinityKey) return undefined;
        const entry = this.recent.get(affinityKey);
        if (!entry) return undefined;
        if (Date.now() - entry.at > AFFINITY_MS) {
            this.recent.delete(affinityKey);
            return undefined;
        }
        return entry.slot;
    }

    private remember(affinityKey: string | undefined, slot: PDFWorkerSlotName): void {
        if (!affinityKey) return;
        this.recent.delete(affinityKey);
        this.recent.set(affinityKey, { slot, at: Date.now() });
        if (this.recent.size > AFFINITY_MAX_ENTRIES) {
            const oldest = this.recent.keys().next().value;
            if (oldest !== undefined) this.recent.delete(oldest);
        }
    }

    private hotRoute(affinityKey: string | undefined, overflowSkip?: OverflowSkipReason): InteractiveWorkerRoute {
        this.hotRoutes += 1;
        let released = false;
        return {
            slot: 'hot',
            ...(overflowSkip ? { overflowSkip } : {}),
            release: () => {
                if (released) return;
                released = true;
                this.hotRoutes -= 1;
                this.remember(affinityKey, 'hot');
                this.pump();
                this.notifyIfDrained();
            },
        };
    }

    /** Take the lane for the background worker; null if it is not free after all. */
    private backgroundRoute(affinityKey: string | undefined): InteractiveWorkerRoute | null {
        const releaseLane = this.deps.lane.tryAcquire();
        if (!releaseLane) return null;
        this.overflowRoutes += 1;
        let released = false;
        return {
            slot: 'background',
            release: () => {
                if (released) return;
                released = true;
                this.overflowRoutes -= 1;
                releaseLane();
                this.remember(affinityKey, 'background');
                this.pump();
                this.notifyIfDrained();
            },
        };
    }

    /**
     * Start the background worker and warm it up, fire-and-forget. The lane
     * stays free meanwhile; job claims wait, and waiting requests can claim
     * the worker once it is warm.
     */
    private startPrewarm(): void {
        if (this.prewarming) return;
        let warmup: Promise<void>;
        try {
            warmup = getMuPDFWorkerClient('background').prewarm();
        } catch (e) {
            logger(`InteractiveOverflow: background pre-warm failed: ${e}`, 2);
            return;
        }
        this.prewarming = true;
        warmup
            .catch((e) => logger(`InteractiveOverflow: background pre-warm failed: ${e}`, 2))
            .finally(() => {
                this.prewarming = false;
                this.pump(false);
                this.notifyIfDrained();
            });
    }

    private notifyIfDrained(): void {
        if (this.blocksBackgroundJobs()) return;
        try {
            this.deps.onDrained();
        } catch (e) {
            logger(`InteractiveOverflow: dispatcher wake failed: ${e}`, 1);
        }
    }
}
