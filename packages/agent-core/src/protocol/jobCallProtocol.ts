/**
 * Job calls: long-running Zotero work (a table fill) handled as a tool call
 * that can park while the work goes on in Zotero.
 *
 * The call waits for its job live (`job_wait_request`). When the wait ends
 * before the job does, the run parks with the call open. The window that has
 * been waiting on the job resumes the run once the job ends, answering the
 * call in `deferred_results` with the same `job_wait_response` the live wait
 * gets. Otherwise the call is closed by the next message (or by the run
 * being cut off) with a text saying the job may have stopped or may still be
 * running; nothing about the job is stored on the call.
 */

import type { ParkedDeferral } from '../agents/types';
import type { TableFillProgress, TableFillResult } from './tableFillProtocol';

export const JOB_KINDS = ['table_fill'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export function isJobKind(kind: unknown): kind is JobKind {
    return typeof kind === 'string' && (JOB_KINDS as readonly string[]).includes(kind);
}

/** The stored state of a parked `table_fill` call. */
export interface TableFillJobState {
    job_id: string;
    /** The table's item id (`u-KEY` / `g<id>-KEY`). */
    table?: string;
    title?: string;
    rows?: number;
    columns?: string[];
}

export interface TableFillJobResult {
    kind: 'table_fill';
    job_id: string;
    status: 'done';
    progress: TableFillProgress;
    result: TableFillResult;
}

/** A parked job call: a deferral of a job kind. */
export interface JobDeferral extends ParkedDeferral {
    kind: JobKind;
    state?: TableFillJobState;
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
     * `done` once the job ended, `running` at the deadline, `not_found` for
     * an unknown job. Also the answer the waiting window resumes a parked
     * job call with (always `done`).
     */
    status: 'done' | 'running' | 'not_found';
    result?: TableFillJobResult;
}
