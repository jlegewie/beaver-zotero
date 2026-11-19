/**
 * Job calls: long-running Zotero work (a table fill) handled as a tool call
 * that can park while the work goes on in Zotero.
 *
 * The call waits for its job live (`job_wait_request`). When the wait ends
 * before the job does, the run parks with the call open. When the job ends,
 * the device that ran it stores the result on the parked call (the
 * parked-call endpoint). The window that has been waiting on the job resumes
 * the run with empty `deferred_results`, and the backend takes the stored
 * result as the call's answer. Every other result reaches the model with the
 * user's next message.
 *
 * The result has one shape whether it travels live (`job_wait_response`) or is
 * stored, so the backend renders both with one finisher.
 */

import type { ParkedDeferral } from '../agents/types';
import type { TableFillProgress, TableFillResult } from './tableFillProtocol';

export const JOB_KINDS = ['table_fill'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export function isJobKind(kind: unknown): kind is JobKind {
    return typeof kind === 'string' && (JOB_KINDS as readonly string[]).includes(kind);
}

/** The device running a job: Zotero's local user key, and its host name if known. */
export interface JobDevice {
    device_key?: string;
    device_name?: string;
}

/** The stored state of a parked `table_fill` call. */
export interface TableFillJobState extends JobDevice {
    job_id: string;
    plan_id?: string;
    /** The table's item id (`u-KEY` / `g<id>-KEY`). */
    table?: string;
    title?: string;
    rows?: number;
    papers?: number;
    columns?: string[];
    credits_planned?: number;
    started_at?: string;
}

export interface TableFillJobResult {
    kind: 'table_fill';
    job_id: string;
    status: 'done';
    progress: TableFillProgress;
    result: TableFillResult;
    /** Derived from local state at startup: Zotero closed during the fill. */
    interrupted?: boolean;
    /**
     * The user stopped the job. Its result never resumes the run: a live
     * wait parks with it, and only a message closes the call.
     */
    stopped?: boolean;
}

export type JobResult = TableFillJobResult;

/** A parked job call: a deferral of a job kind, with its result once stored. */
export interface JobDeferral extends ParkedDeferral {
    kind: JobKind;
    state?: TableFillJobState;
    result?: JobResult | null;
}

export function isJobDeferral(deferral: ParkedDeferral | null | undefined): deferral is JobDeferral {
    return !!deferral && isJobKind(deferral.kind);
}

/** The job id of a job deferral: its correlation id, else its state's. */
export function jobIdOf(deferral: JobDeferral): string {
    return deferral.correlation_id || (deferral.state?.job_id ?? '');
}

// ---------------------------------------------------------------------------
// Live wait
// ---------------------------------------------------------------------------

/** Backend → client: wait for a job, live, as part of the run. Parkable. */
export interface WSJobWaitRequest {
    event: 'job_wait_request';
    request_id: string;
    kind: JobKind;
    job_id: string;
    tool_call_id: string;
    timeout_seconds: number;
}

export interface WSJobWaitResponse {
    type: 'job_wait_response';
    request_id: string;
    job_id: string;
    /**
     * `done` once the job ended (a job the user stopped carries `stopped` on
     * its result, and the backend parks the call), `running` at the deadline,
     * `not_found` for an unknown job.
     */
    status: 'done' | 'running' | 'not_found';
    result?: JobResult;
}

// ---------------------------------------------------------------------------
// The parked-call result endpoint
// ---------------------------------------------------------------------------

/** Body of `POST /api/v1/threads/{thread_id}/parked-calls/{tool_call_id}/result`. */
export interface StoreJobResultRequest {
    kind: JobKind;
    job_id: string;
    result: JobResult;
}

/**
 * `stored`: the result is on the parked call (or already was). `busy`: a run
 * holds the thread; retry once it ends. `gone`: the call is no longer open;
 * drop the result.
 */
export type StoreJobResultOutcome = 'stored' | 'busy' | 'gone';

export interface StoreJobResultResponse {
    outcome: StoreJobResultOutcome;
}

// ---------------------------------------------------------------------------
// Plugin runtime notification
// ---------------------------------------------------------------------------

/** A job result this device stored on its parked call. */
export interface StoredJobCall {
    threadId: string;
    toolCallId: string;
    kind: JobKind;
    jobId: string;
    userId: string;
    result: JobResult;
}

/**
 * Published on the instance runtime when this device stored a job's result on
 * its parked call. Windows showing the thread put the result on the call; the
 * window that has been waiting on the job resumes the run.
 */
export const JOB_CALL_STORED_EVENT = 'job-call:stored';

/**
 * Published on the instance runtime when the set of jobs some window waits on
 * changes; carries their job ids. A fill's receipt offers Stop only while no
 * window waits on it (Stop is then in that window's composer).
 */
export const JOB_WAITERS_CHANGED_EVENT = 'job-call:waiters';
