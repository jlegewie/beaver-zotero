/**
 * Job calls: long-running Zotero work (a table fill, PDF retrieval) handled as
 * a parked tool call that the plugin answers instead of the user.
 *
 * A small job runs while the run waits for it (`job_wait_request`); a large
 * one, or one that overruns the wait, parks the call. When a parked job ends,
 * the device that ran it stores the result on the parked call (the parked-call
 * mailbox endpoint), and a window showing the thread resumes the run with
 * empty `deferred_results`; the backend takes the stored result as the call's
 * answer.
 *
 * The result has one shape whether it travels live (`job_wait_response`) or is
 * stored, so the backend renders both with one finisher.
 */

import type { ParkedDeferral } from '../agents/types';
import type { TableFillProgress, TableFillResult } from './tableFillProtocol';

export const JOB_KINDS = ['table_fill', 'pdf_retrieval'] as const;
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

export interface PdfRetrievalJobItem {
    action_id?: string;
    library_id: number;
    zotero_key: string;
    library_ref?: string;
    title?: string;
}

/** The stored state of a parked `pdf_retrieval` call. */
export interface PdfRetrievalJobState extends JobDevice {
    job_id: string;
    items?: PdfRetrievalJobItem[];
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
}

export type PdfAttachmentStatus = 'available' | 'failed' | 'pending';

export interface PdfRetrievalItemResult {
    action_id?: string;
    library_id: number;
    zotero_key: string;
    library_ref?: string;
    attachment_status: PdfAttachmentStatus;
    attachment_key?: string;
    access_method?: string;
    failure_reason?: string;
    elapsed_ms?: number;
}

export interface PdfRetrievalJobResult {
    kind: 'pdf_retrieval';
    job_id: string;
    status: 'done';
    items: PdfRetrievalItemResult[];
    /** The time cap ended the job with items still pending. */
    timed_out?: boolean;
    /** Derived from local state at startup: Zotero closed during the job. */
    interrupted?: boolean;
}

export type JobResult = TableFillJobResult | PdfRetrievalJobResult;

/** A parked job call: a deferral of a job kind, with its result once stored. */
export interface JobDeferral extends ParkedDeferral {
    kind: JobKind;
    state?: TableFillJobState | PdfRetrievalJobState;
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
    /** `done` once the job ended, `running` at the deadline, `not_found` for an unknown job. */
    status: 'done' | 'running' | 'not_found';
    result?: JobResult;
}

// ---------------------------------------------------------------------------
// PDF retrieval start
// ---------------------------------------------------------------------------

/** Backend → client: group the PDF fetches of these created items into one job. */
export interface WSPdfJobStartRequest {
    event: 'pdf_job_start_request';
    request_id: string;
    thread_id?: string | null;
    run_id?: string | null;
    tool_call_id: string;
    action_ids: string[];
}

export interface WSPdfJobStartResponse extends JobDevice {
    type: 'pdf_job_start_response';
    request_id: string;
    ok: boolean;
    error_code?: string;
    error?: string;
    job_id?: string;
    items?: PdfRetrievalItemResult[];
    /** Items whose fetch is still running. */
    fetching?: number;
}

// ---------------------------------------------------------------------------
// The parked-call mailbox
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
// Thread list
// ---------------------------------------------------------------------------

/** The `threads.awaiting_input` key of a job call whose result is stored. */
export const JOB_READY_KEY = 'job_ready';

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
 * its parked call. A window showing the thread resumes the run; the window
 * named `notifyWindowId` tells the user when none shows it.
 */
export const JOB_CALL_STORED_EVENT = 'job-call:stored';

export interface JobCallStoredNotification extends StoredJobCall {
    /** Windows that show the thread now. */
    viewerWindowIds: string[];
    /** The window that reports the result when no window shows the thread. */
    notifyWindowId?: string;
    /** For the notification: what the job worked on ("Soil carbon studies", "8 items"). */
    subject?: string;
}

/**
 * Published on the instance runtime whenever a PDF retrieval job changes, so
 * windows can show its progress (the job bar).
 */
export const PDF_JOB_CHANGED_EVENT = 'pdf-job:changed';

export interface PdfJobSnapshot {
    job_id: string;
    thread_id: string | null;
    tool_call_id: string;
    run_id: string | null;
    total: number;
    found: number;
    /** Looked for and not found. */
    failed: number;
    /** Stopped before they finished (the user stopped the job). */
    cancelled: number;
    ended: boolean;
}
