/**
 * `addon.pdfJobs`: groups the background PDF fetches of items Beaver created
 * into one job call (`pdf_retrieval`).
 *
 * The fetch tasks (`schedulePdfFetchTask` and its snapshot / attach-in-order
 * siblings) report here when they start and settle. When the agent's
 * `create_items` tool asks for a job (`start`), the fetches already scheduled
 * for its actions are grouped under one job id; the job ends when every fetch
 * settled or the time cap passed. The run waits on it live (`waitJob`) or, when
 * it parks, the job-call list stores the result (`jobCalls.jobEnded`).
 *
 * Plugin realm only. The class holds no Zotero globals: everything host-bound
 * arrives through `PdfJobsDeps` (wired in `./pdfJobsFactory`).
 */

import type {
    JobDevice,
    JobKind,
    JobResult,
    PdfJobSnapshot,
    PdfRetrievalItemResult,
    PdfRetrievalJobResult,
    WSJobWaitRequest,
    WSJobWaitResponse,
    WSPdfJobStartRequest,
    WSPdfJobStartResponse,
} from '@beaver/agent-core/protocol/jobCallProtocol';
import type { AgentDataRequestContext } from '@beaver/agent-core/transport/agentDataDispatch';
import type { JobCallEntry } from '../jobCalls/service';

/** How long a job waits for its fetches before reporting the rest as pending. */
export const PENDING_ATTACHMENT_TTL_MS = 5 * 60_000;
/** How long a settled fetch and an ended job stay answerable. */
export const PDF_JOB_RETENTION_MS = 30 * 60_000;

/** The slice of the job-call list (`addon.jobCalls`) that PDF jobs use. */
export interface PdfJobCallSeam {
    register(entry: {
        threadId: string;
        toolCallId: string;
        kind: JobKind;
        jobId: string;
        coverage: Record<string, unknown>;
    }): void | Promise<void>;
    jobEnded(kind: JobKind, jobId: string, result: JobResult): void | Promise<void>;
}

export interface PdfJobsDeps {
    /** The job-call list, or undefined while it is not running. */
    jobCalls(): PdfJobCallSeam | undefined;
    newId(): string;
    device(): JobDevice;
    signedIn(): boolean;
    /** Whether Beaver may send data of this library off the device. */
    librarySendable(libraryId: number): boolean;
    libraryRef(libraryId: number): string | null | undefined;
    /** Stop a fetch that is still running. */
    cancelFetch(libraryId: number, zoteroKey: string, taskId?: string): void;
    /** The key of the item's current PDF attachment, if it has one. */
    currentPdf(libraryId: number, zoteroKey: string): Promise<string | null>;
    setTimer(callback: () => void, ms: number): unknown;
    clearTimer(handle: unknown): void;
    now(): number;
    log(message: string): void;
    /** Tell windows a job changed (started, a fetch settled, ended). */
    publish?(snapshot: PdfJobSnapshot): void;
}

export interface PdfJobsSettings {
    /** The time cap of a job (`PENDING_ATTACHMENT_TTL`). */
    pendingTtlMs?: number;
    retentionMs?: number;
}

export interface PdfFetchStarted {
    actionId?: string;
    threadId?: string | null;
    libraryId: number;
    zoteroKey: string;
    /** The background task running the fetch, to cancel it with the job. */
    taskId?: string;
}

export interface PdfFetchSettled {
    actionId?: string;
    libraryId: number;
    zoteroKey: string;
    attachmentStatus: 'available' | 'failed';
    attachmentKey?: string;
    accessMethod?: string;
    failureReason?: string;
    elapsedMs?: number;
}

interface FetchRecord {
    actionId?: string;
    threadId?: string | null;
    libraryId: number;
    zoteroKey: string;
    taskId?: string;
    status: 'pending' | 'available' | 'failed';
    attachmentKey?: string;
    accessMethod?: string;
    failureReason?: string;
    elapsedMs?: number;
    settledAt?: number;
}

interface PdfJob {
    jobId: string;
    threadId: string | null;
    toolCallId: string;
    runId: string | null;
    records: FetchRecord[];
    /** Whether the job-call list holds an entry to report its end to. */
    registered: boolean;
    ended: boolean;
    endedAt?: number;
    result?: PdfRetrievalJobResult;
    capTimer?: unknown;
    waiters: Set<(reason: 'ended' | 'disposed') => void>;
}

function libraryKey(libraryId: number, zoteroKey: string): string {
    return `${libraryId}-${zoteroKey}`;
}

function recordKey(ref: { actionId?: string; libraryId: number; zoteroKey: string }): string {
    return ref.actionId || libraryKey(ref.libraryId, ref.zoteroKey);
}

export class InstancePdfJobs {
    private records = new Map<string, FetchRecord>();
    private jobs = new Map<string, PdfJob>();
    private readonly pendingTtlMs: number;
    private readonly retentionMs: number;
    private disposed = false;

    constructor(private readonly deps: PdfJobsDeps, settings: PdfJobsSettings = {}) {
        this.pendingTtlMs = settings.pendingTtlMs ?? PENDING_ATTACHMENT_TTL_MS;
        this.retentionMs = settings.retentionMs ?? PDF_JOB_RETENTION_MS;
    }

    // ----- registry fed by the fetch tasks -----

    fetchStarted(ref: PdfFetchStarted): void {
        if (this.disposed) return;
        this.sweep();
        this.records.set(recordKey(ref), {
            actionId: ref.actionId,
            threadId: ref.threadId,
            libraryId: ref.libraryId,
            zoteroKey: ref.zoteroKey,
            taskId: ref.taskId,
            status: 'pending',
        });
    }

    fetchSettled(outcome: PdfFetchSettled): void {
        if (this.disposed) return;
        const record = this.findRecord(outcome);
        if (!record || record.status !== 'pending') return;
        this.settle(record, {
            status: outcome.attachmentStatus,
            attachmentKey: outcome.attachmentKey,
            accessMethod: outcome.accessMethod,
            failureReason: outcome.failureReason,
            elapsedMs: outcome.elapsedMs,
        });
    }

    // ----- job calls -----

    /** Group the fetches already scheduled for `action_ids` into one job. */
    async start(request: WSPdfJobStartRequest, context?: AgentDataRequestContext): Promise<WSPdfJobStartResponse> {
        const base = { type: 'pdf_job_start_response' as const, request_id: request.request_id };
        if (!this.deps.signedIn()) {
            return { ...base, ok: false, error_code: 'signed_out', error: 'Beaver is signed out.' };
        }
        this.sweep();

        const records: FetchRecord[] = [];
        const seen = new Set<FetchRecord>();
        for (const actionId of request.action_ids ?? []) {
            const record = this.records.get(actionId);
            if (!record || seen.has(record)) continue;
            seen.add(record);
            records.push(record);
        }
        if (records.length === 0 && (request.action_ids?.length ?? 0) > 0) {
            return { ...base, ok: false, error_code: 'unknown_actions', error: 'No PDF fetch was scheduled for these actions.' };
        }
        // Items Beaver may not send are not part of the job at all.
        const covered = records.filter((record) => this.deps.librarySendable(record.libraryId));

        const threadId = request.thread_id ?? context?.run?.threadId ?? null;
        const job: PdfJob = {
            jobId: this.deps.newId(),
            threadId,
            toolCallId: request.tool_call_id,
            runId: request.run_id ?? context?.run?.runId ?? null,
            records: covered,
            registered: false,
            ended: false,
            waiters: new Set(),
        };
        this.jobs.set(job.jobId, job);

        const fetching = covered.filter((record) => record.status === 'pending').length;
        if (fetching > 0) {
            // Set before awaiting: a job that ends meanwhile still reports its end.
            job.registered = !!this.deps.jobCalls() && !!threadId && !!request.tool_call_id;
            if (job.registered && !(await this.register(job, threadId!, request.tool_call_id))) job.registered = false;
            if (!job.ended) {
                job.capTimer = this.deps.setTimer(() => {
                    job.capTimer = undefined;
                    this.endJob(job, true);
                }, this.pendingTtlMs);
            }
        } else {
            this.endJob(job, false);
        }
        this.publish(job);

        const items = this.itemsOf(job);
        return {
            ...base,
            ok: true,
            job_id: job.jobId,
            ...this.deps.device(),
            items,
            fetching: items.filter((item) => item.attachment_status === 'pending').length,
        };
    }

    /** Answer a live wait: `done` when the job ends, `running` at the deadline. */
    waitJob(request: WSJobWaitRequest, context?: AgentDataRequestContext): Promise<WSJobWaitResponse> {
        const base = { type: 'job_wait_response' as const, request_id: request.request_id, job_id: request.job_id };
        const job = this.jobs.get(request.job_id);
        if (!job) return Promise.resolve({ ...base, status: 'not_found' });

        const done = (): WSJobWaitResponse => ({ ...base, status: 'done', result: job.result && this.sendableResult(job.result) });
        if (!job.ended && context?.runStopped?.aborted) this.cancelJob(job);
        if (job.ended) return Promise.resolve(done());

        return new Promise<WSJobWaitResponse>((resolve) => {
            let timer: unknown;
            const cleanup = () => {
                job.waiters.delete(onEnd);
                if (timer !== undefined) this.deps.clearTimer(timer);
                context?.runStopped?.removeEventListener('abort', onStopped);
                context?.signal?.removeEventListener('abort', onAborted);
            };
            const onEnd = (reason: 'ended' | 'disposed') => {
                cleanup();
                resolve(reason === 'ended' ? done() : { ...base, status: 'running' });
            };
            // The user stopped the run: the fetches stop and the job ends now.
            const onStopped = () => this.cancelJob(job);
            // The request was withdrawn (the run parked, the socket closed).
            const onAborted = () => {
                cleanup();
                resolve({ ...base, status: 'running' });
            };

            job.waiters.add(onEnd);
            const deadline = (context?.receivedAt ?? this.deps.now()) + request.timeout_seconds * 1000;
            timer = this.deps.setTimer(() => {
                timer = undefined;
                cleanup();
                resolve({ ...base, status: 'running' });
            }, Math.max(0, deadline - this.deps.now()));
            context?.runStopped?.addEventListener('abort', onStopped, { once: true });
            if (context?.signal?.aborted) onAborted();
            else context?.signal?.addEventListener('abort', onAborted, { once: true });
        });
    }

    /** The user stopped the job (its bar's Stop): its fetches stop and it ends now. */
    stop(jobId: string): boolean {
        const job = this.jobs.get(jobId);
        if (!job || job.ended) return false;
        this.cancelJob(job);
        return true;
    }

    /** Every job still kept, for a window that starts following them. */
    listJobs(): PdfJobSnapshot[] {
        return [...this.jobs.values()].map((job) => this.snapshot(job));
    }

    /**
     * A result without the libraries Beaver may not send now: one kept since
     * the job ended may cover a library excluded since.
     */
    sendableResult(result: PdfRetrievalJobResult): PdfRetrievalJobResult {
        const items = result.items.filter((item) => this.deps.librarySendable(item.library_id));
        return items.length === result.items.length ? result : { ...result, items };
    }

    /** Whether this device is still running the job. */
    isLive(jobId: string): boolean {
        const job = this.jobs.get(jobId);
        return !!job && !job.ended;
    }

    /**
     * The result of a job cut off by a restart, from local state: an item that
     * now has a PDF is available, any other did not finish. Null when the
     * entry's coverage cannot be read.
     */
    async deriveInterrupted(entry: JobCallEntry): Promise<PdfRetrievalJobResult | null> {
        const covered = entry.coverage?.items;
        if (!Array.isArray(covered)) return null;
        const items: PdfRetrievalItemResult[] = [];
        for (const raw of covered) {
            const item = raw as Record<string, unknown> | null;
            if (!item || typeof item.library_id !== 'number' || typeof item.zotero_key !== 'string') return null;
            const libraryId = item.library_id;
            if (!this.deps.librarySendable(libraryId)) continue;
            let pdfKey: string | null = null;
            try {
                pdfKey = await this.deps.currentPdf(libraryId, item.zotero_key);
            } catch (error) {
                this.deps.log(`pdfJobs: could not read the attachments of ${libraryId}-${item.zotero_key}: ${String(error)}`);
            }
            items.push(
                this.itemResult({
                    actionId: typeof item.action_id === 'string' ? item.action_id : undefined,
                    libraryId,
                    zoteroKey: item.zotero_key,
                    libraryRef: typeof item.library_ref === 'string' ? item.library_ref : undefined,
                    status: pdfKey ? 'available' : 'failed',
                    attachmentKey: pdfKey ? libraryKey(libraryId, pdfKey) : undefined,
                    failureReason: pdfKey ? undefined : 'interrupted',
                }),
            );
        }
        return { kind: 'pdf_retrieval', job_id: entry.jobId, status: 'done', items, interrupted: true };
    }

    dispose(): void {
        this.disposed = true;
        for (const job of this.jobs.values()) {
            if (job.capTimer !== undefined) this.deps.clearTimer(job.capTimer);
            job.capTimer = undefined;
            for (const release of [...job.waiters]) release('disposed');
        }
        this.jobs.clear();
        this.records.clear();
    }

    // ----- internals -----

    private async register(job: PdfJob, threadId: string, toolCallId: string): Promise<boolean> {
        const seam = this.deps.jobCalls();
        if (!seam) return false;
        try {
            await seam.register({
                threadId,
                toolCallId,
                kind: 'pdf_retrieval',
                jobId: job.jobId,
                coverage: {
                    items: job.records.map((record) => ({
                        action_id: record.actionId,
                        library_id: record.libraryId,
                        zotero_key: record.zoteroKey,
                        library_ref: this.deps.libraryRef(record.libraryId) ?? undefined,
                    })),
                },
            });
            return true;
        } catch (error) {
            this.deps.log(`pdfJobs: could not register job ${job.jobId}: ${String(error)}`);
            return false;
        }
    }

    private findRecord(ref: { actionId?: string; libraryId: number; zoteroKey: string }): FetchRecord | undefined {
        if (ref.actionId) {
            const byAction = this.records.get(ref.actionId);
            if (byAction) return byAction;
        }
        for (const record of this.records.values()) {
            if (record.libraryId === ref.libraryId && record.zoteroKey === ref.zoteroKey) return record;
        }
        return undefined;
    }

    private settle(
        record: FetchRecord,
        outcome: Pick<FetchRecord, 'status' | 'attachmentKey' | 'accessMethod' | 'failureReason' | 'elapsedMs'>,
    ): void {
        Object.assign(record, outcome, { settledAt: this.deps.now() });
        for (const job of this.jobs.values()) {
            if (job.ended || !job.records.includes(record)) continue;
            if (job.records.every((r) => r.status !== 'pending')) this.endJob(job, false);
            else this.publish(job);
        }
    }

    private snapshot(job: PdfJob): PdfJobSnapshot {
        const sendable = job.records.filter((record) => this.deps.librarySendable(record.libraryId));
        return {
            job_id: job.jobId,
            thread_id: job.threadId,
            tool_call_id: job.toolCallId,
            run_id: job.runId,
            total: sendable.length,
            found: sendable.filter((record) => record.status === 'available').length,
            failed: sendable.filter((record) => record.status === 'failed' && record.failureReason !== 'cancelled').length,
            cancelled: sendable.filter((record) => record.status === 'failed' && record.failureReason === 'cancelled').length,
            ended: job.ended,
        };
    }

    private publish(job: PdfJob): void {
        try {
            this.deps.publish?.(this.snapshot(job));
        } catch (error) {
            this.deps.log(`pdfJobs: could not publish job ${job.jobId}: ${String(error)}`);
        }
    }

    /** Cancel the fetches still running and end the job with them as cancelled. */
    private cancelJob(job: PdfJob): void {
        for (const record of job.records) {
            if (record.status !== 'pending') continue;
            try {
                this.deps.cancelFetch(record.libraryId, record.zoteroKey, record.taskId);
            } catch (error) {
                this.deps.log(`pdfJobs: could not cancel the fetch of ${record.libraryId}-${record.zoteroKey}: ${String(error)}`);
            }
            this.settle(record, { status: 'failed', failureReason: 'cancelled' });
        }
        this.endJob(job, false);
    }

    private endJob(job: PdfJob, capped: boolean): void {
        if (job.ended) return;
        job.ended = true;
        job.endedAt = this.deps.now();
        if (job.capTimer !== undefined) this.deps.clearTimer(job.capTimer);
        job.capTimer = undefined;

        const result: PdfRetrievalJobResult = {
            kind: 'pdf_retrieval',
            job_id: job.jobId,
            status: 'done',
            items: this.itemsOf(job),
            ...(capped ? { timed_out: true } : {}),
        };
        job.result = result;
        for (const release of [...job.waiters]) release('ended');
        this.publish(job);

        if (job.registered) {
            const seam = this.deps.jobCalls();
            Promise.resolve()
                .then(() => seam?.jobEnded('pdf_retrieval', job.jobId, result))
                .catch((error) => this.deps.log(`pdfJobs: could not report the end of job ${job.jobId}: ${String(error)}`));
        }
    }

    /** The job's items as the backend sees them, without libraries Beaver may not send. */
    private itemsOf(job: PdfJob): PdfRetrievalItemResult[] {
        return job.records
            .filter((record) => this.deps.librarySendable(record.libraryId))
            .map((record) => this.itemResult({ ...record, libraryRef: undefined }));
    }

    private itemResult(
        item: {
            actionId?: string;
            libraryId: number;
            zoteroKey: string;
            libraryRef?: string;
            status: 'pending' | 'available' | 'failed';
            attachmentKey?: string;
            accessMethod?: string;
            failureReason?: string;
            elapsedMs?: number;
        },
    ): PdfRetrievalItemResult {
        const libraryRef = item.libraryRef ?? this.deps.libraryRef(item.libraryId) ?? undefined;
        return {
            ...(item.actionId ? { action_id: item.actionId } : {}),
            library_id: item.libraryId,
            zotero_key: item.zoteroKey,
            ...(libraryRef ? { library_ref: libraryRef } : {}),
            attachment_status: item.status,
            ...(item.attachmentKey ? { attachment_key: item.attachmentKey } : {}),
            ...(item.accessMethod ? { access_method: item.accessMethod } : {}),
            ...(item.failureReason ? { failure_reason: item.failureReason } : {}),
            ...(item.elapsedMs !== undefined ? { elapsed_ms: item.elapsedMs } : {}),
        };
    }

    /** Forget fetches and jobs that ended longer ago than the retention. */
    private sweep(): void {
        const cutoff = this.deps.now() - this.retentionMs;
        for (const [id, job] of this.jobs) {
            if (job.ended && (job.endedAt ?? 0) < cutoff) this.jobs.delete(id);
        }
        for (const [key, record] of this.records) {
            if (record.settledAt !== undefined && record.settledAt < cutoff) this.records.delete(key);
        }
    }
}
