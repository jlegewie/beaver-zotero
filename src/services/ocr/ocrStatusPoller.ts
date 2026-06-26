/**
 * Shared, batched poller for in-flight OCR jobs.
 *
 * Each OcrExecutor that reaches the "queued, just poll" phase registers its
 * backend `job_id` here and awaits a single `OcrPollResult`. One shared timer
 * collects every active job id and polls them in one `/ocr/status/batch` request
 * per cycle, instead of each job running its own `/ocr/status` loop. The win is
 * one batched request per machine per cycle (vs. one per in-flight job), which
 * compounds across many simultaneous signups; correctness is identical to N
 * independent loops.
 *
 * Part of the webpack bundle (it value-imports the Supabase-authenticated
 * `ocrApiClient`); the esbuild dispatcher never imports it.
 */

import { ocrApiClient, type OcrError } from './ocrApiClient';
import {
    OCR_POLL_BACKOFF,
    OCR_POLL_INITIAL_MS,
    OCR_POLL_MAX_MS,
    OCR_STATUS_BATCH_MAX,
} from './constants';
import { logger } from '../../utils/logger';

/** Thrown to unwind an aborted poll into the executor's `release` outcome. */
export class OcrAbort extends Error {}

export type OcrPollResult =
    | { kind: 'completed'; getUrl: string | null }
    | { kind: 'failed'; error: OcrError | null }
    | { kind: 'gone' }      // job id absent from the batch response (row deleted)
    | { kind: 'timeout' };  // poll budget exhausted

interface Registrant {
    jobId: string;
    deadline: number;
    signal: AbortSignal;
    resolve: (result: OcrPollResult) => void;
    reject: (error: unknown) => void;
    onAbort: () => void;
    done: boolean;
}

function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

export class OcrStatusPoller {
    /** jobId → registrants. A Set because two background records can dedupe to
     *  the same backend `(user, file_hash)` job and must both resolve. */
    private readonly registrants = new Map<string, Set<Registrant>>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    /**
     * True from the moment a tick's callback fires until that tick returns. The
     * callback nulls `timer` before awaiting `statusBatch`, so without this flag a
     * `poll()` landing during that in-flight window would see no timer and start a
     * second loop. The in-flight tick reschedules itself at the end and already
     * covers any registrant added meanwhile, so suppressing the duplicate is safe.
     */
    private ticking = false;
    private waitMs = OCR_POLL_INITIAL_MS;

    /**
     * Register a job for batched polling. Resolves when the job reaches a
     * terminal poll state (`completed`/`failed`), goes missing (`gone`), or its
     * `deadline` passes (`timeout`); rejects with `OcrAbort` if `signal` aborts.
     */
    poll(jobId: string, opts: { deadline: number; signal: AbortSignal }): Promise<OcrPollResult> {
        return new Promise<OcrPollResult>((resolve, reject) => {
            if (opts.signal.aborted) {
                reject(new OcrAbort());
                return;
            }
            const reg: Registrant = {
                jobId,
                deadline: opts.deadline,
                signal: opts.signal,
                resolve,
                reject,
                onAbort: () => undefined,
                done: false,
            };
            reg.onAbort = () => this.settle(reg, undefined, true);
            opts.signal.addEventListener('abort', reg.onAbort, { once: true });

            let set = this.registrants.get(jobId);
            if (!set) {
                set = new Set();
                this.registrants.set(jobId, set);
            }
            set.add(reg);
            this.ensureRunning();
        });
    }

    private ensureRunning(): void {
        // A scheduled timer or an in-flight tick already owns the single loop; the
        // in-flight tick reschedules itself and will pick up this registrant.
        if (this.timer !== undefined || this.ticking) return;
        // Cold start: poll promptly, then back off over subsequent ticks.
        this.waitMs = OCR_POLL_INITIAL_MS;
        this.scheduleTick(this.waitMs);
    }

    private scheduleTick(delayMs: number): void {
        const id = setTimeout(() => {
            this.timer = undefined;
            void this.tick();
        }, delayMs);
        (id as any)?.unref?.();
        this.timer = id;
    }

    private async tick(): Promise<void> {
        // Held until this tick returns so a registration during the in-flight
        // statusBatch (when `timer` is already null) cannot start a second loop.
        this.ticking = true;
        try {
            // 1. Time out registrants whose deadline has passed.
            const now = Date.now();
            for (const set of this.registrants.values()) {
                for (const reg of [...set]) {
                    if (!reg.done && now >= reg.deadline) {
                        this.settle(reg, { kind: 'timeout' });
                    }
                }
            }

            const ids = [...this.registrants.keys()];
            if (ids.length === 0) return; // nothing left → loop idles (timer undefined)

            // 2. Batched status. A throw is transient: keep registrants and retry
            //    on the next tick — each registrant's deadline still bounds its wait.
            try {
                for (const to of chunk(ids, OCR_STATUS_BATCH_MAX)) {
                    const resp = await ocrApiClient.statusBatch(to);
                    const byId = new Map(resp.jobs.map((j) => [j.job_id, j]));
                    for (const jobId of to) {
                        const set = this.registrants.get(jobId);
                        if (!set) continue;
                        const item = byId.get(jobId);
                        for (const reg of [...set]) {
                            if (reg.done) continue;
                            if (!item) {
                                this.settle(reg, { kind: 'gone' });
                            } else if (item.status === 'completed') {
                                this.settle(reg, { kind: 'completed', getUrl: item.get_url ?? null });
                            } else if (item.status === 'failed') {
                                this.settle(reg, { kind: 'failed', error: item.error ?? null });
                            }
                            // queued / pending → keep waiting
                        }
                    }
                }
            } catch (error) {
                logger(`OcrStatusPoller: statusBatch failed (will retry): ${error}`, 2);
            }

            // 3. Back off and reschedule while work remains.
            if (this.registrants.size > 0) {
                this.waitMs = Math.min(this.waitMs * OCR_POLL_BACKOFF, OCR_POLL_MAX_MS);
                this.scheduleTick(this.waitMs);
            }
        } finally {
            this.ticking = false;
        }
    }

    private settle(reg: Registrant, result: OcrPollResult | undefined, abort = false): void {
        if (reg.done) return;
        reg.done = true;
        reg.signal.removeEventListener('abort', reg.onAbort);
        const set = this.registrants.get(reg.jobId);
        if (set) {
            set.delete(reg);
            if (set.size === 0) this.registrants.delete(reg.jobId);
        }
        if (abort) reg.reject(new OcrAbort());
        else reg.resolve(result as OcrPollResult);
    }
}

export const ocrStatusPoller = new OcrStatusPoller();
