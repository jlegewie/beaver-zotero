/**
 * Interactive overflow: an interactive PDF document request that would queue
 * behind a busy hot MuPDF worker runs on the idle background worker instead.
 *
 * Routing is per request (`route`, called at the request's first worker op);
 * every op of that request stays on the chosen worker. A request overflows
 * only when the background worker can take it right now:
 *
 * - the background MuPDF lane is free and is taken without waiting, so an
 *   overflow request is one more exclusive user of the background worker;
 * - no background job that uses the worker is in flight (running jobs are
 *   never interrupted, and their next lane use must not queue behind
 *   interactive work);
 * - the background worker is started and warm. A cold worker can be slower
 *   than waiting for hot, so a request that finds it cold stays on hot and
 *   starts a warm-up for the next one.
 *
 * While interactive work is pending or queued on hot, an overflow request
 * holds the lane, or an overflow warm-up runs, the background extractor does
 * not claim new jobs (`blocksBackgroundJobs`). Releasing the last of these
 * wakes the dispatcher.
 */

import {
    getExistingMuPDFWorkerClient,
    getMuPDFWorkerClient,
    type PDFWorkerSlotName,
} from '../../beaver-extract';
import { logger } from '@beaver/agent-core/platform/logger';
import { getPref } from '../../utils/prefs';
import type { MuPDFSerialLane } from './muPDFSerialLane';

/** Why a request that found the hot worker busy still queued on it. */
export type OverflowSkipReason = 'lane_busy' | 'bg_not_warm' | 'disabled';

export type OverflowDecision = 'hot_idle' | 'overflow' | OverflowSkipReason;

/** The worker one interactive request uses for all of its ops. */
export interface InteractiveWorkerRoute {
    slot: PDFWorkerSlotName;
    /** Set when the hot worker was busy but the request stayed on it. */
    overflowSkip?: OverflowSkipReason;
    /** Release the route once the request and its worker ops are done. Idempotent. */
    release(): void;
}

export interface InteractiveOverflowStats {
    hotRoutes: number;
    overflowRoutes: number;
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

export class InteractiveOverflow {
    /** Open requests routed to hot (counted from their first op until they finish). */
    private hotRoutes = 0;
    /** Open requests holding the lane for the background worker. */
    private overflowRoutes = 0;
    private prewarming = false;
    private readonly decisions: Record<OverflowDecision, number> = {
        hot_idle: 0,
        overflow: 0,
        lane_busy: 0,
        bg_not_warm: 0,
        disabled: 0,
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
        return this.overflowRoutes > 0 || this.prewarming || this.isHotBusy();
    }

    /** Choose the worker for one interactive request. */
    route(): InteractiveWorkerRoute {
        if (!this.isHotBusy()) {
            this.decisions.hot_idle += 1;
            return this.hotRoute();
        }
        let skip = this.overflowBlocker();
        if (skip === null) {
            const releaseLane = this.deps.lane.tryAcquire();
            if (releaseLane) {
                this.decisions.overflow += 1;
                logger('InteractiveOverflow: hot worker busy, request runs on the background worker', 3);
                return this.overflowRoute(releaseLane);
            }
            skip = 'lane_busy';
        }
        if (skip === 'bg_not_warm') this.startPrewarm();
        this.decisions[skip] += 1;
        logger(`InteractiveOverflow: hot worker busy, request queues on hot (${skip})`, 3);
        return this.hotRoute(skip);
    }

    getStats(): InteractiveOverflowStats {
        return {
            hotRoutes: this.hotRoutes,
            overflowRoutes: this.overflowRoutes,
            prewarming: this.prewarming,
            decisions: { ...this.decisions },
        };
    }

    private overflowBlocker(): OverflowSkipReason | null {
        if (getPref('pdf.backgroundOverflow') === false || !this.deps.isAvailable()) return 'disabled';
        if (!this.deps.lane.isFree || this.deps.hasWorkerJobInFlight()) return 'lane_busy';
        const background = getExistingMuPDFWorkerClient('background');
        if (!background?.isWarm()) return 'bg_not_warm';
        if (background.inFlight + background.queued > 0) return 'lane_busy';
        return null;
    }

    private hotRoute(overflowSkip?: OverflowSkipReason): InteractiveWorkerRoute {
        this.hotRoutes += 1;
        let released = false;
        return {
            slot: 'hot',
            ...(overflowSkip ? { overflowSkip } : {}),
            release: () => {
                if (released) return;
                released = true;
                this.hotRoutes -= 1;
                this.notifyIfDrained();
            },
        };
    }

    private overflowRoute(releaseLane: () => void): InteractiveWorkerRoute {
        this.overflowRoutes += 1;
        let released = false;
        return {
            slot: 'background',
            release: () => {
                if (released) return;
                released = true;
                this.overflowRoutes -= 1;
                releaseLane();
                this.notifyIfDrained();
            },
        };
    }

    /**
     * Start the background worker and warm it up, fire-and-forget, so the next
     * request can overflow. The lane stays free meanwhile; job claims wait.
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
