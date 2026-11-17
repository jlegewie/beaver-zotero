/**
 * Job calls of the open thread: the open parked run's calls that wait on a
 * job (a table fill, PDF retrieval) rather than on the user.
 *
 * A job call is open until a resume returns it or a message closes it. Its
 * stored result (`result`) arrives with the run's `parked` record: from the
 * thread's history, or patched in locally by the device that stored it.
 */

import { atom } from 'jotai/vanilla';
import type { AgentRun } from '../agents/types';
import {
    isJobDeferral,
    type JobDeferral,
    type JobResult,
    type PdfRetrievalJobResult,
    type TableFillJobResult,
    type TableFillJobState,
} from '../protocol/jobCallProtocol';
import type { TableFillJobSnapshot, TableFillResult } from '../protocol/tableFillProtocol';
import { openParkedRunAtom } from './parkedRun';

/** The open parked run's job calls, in call order. */
export const openJobCallsAtom = atom<readonly JobDeferral[]>((get) => {
    const open = get(openParkedRunAtom);
    if (!open) return EMPTY;
    const calls = open.deferrals.filter(isJobDeferral);
    return calls.length ? calls : EMPTY;
});
const EMPTY: readonly JobDeferral[] = [];

/** Whether a job call of the open parked run has its result stored: Continue can resume. */
export const hasReadyJobCallAtom = atom((get) => get(openJobCallsAtom).some((call) => !!call.result));

/**
 * The runs with `result` stored on the parked job call `toolCallId`, or null
 * when no run parks that call. Only the run's `parked` record changes.
 */
export function withStoredJobResult(
    runs: readonly AgentRun[],
    toolCallId: string,
    result: JobResult,
): AgentRun[] | null {
    let changed = false;
    const next = runs.map((run) => {
        const requests = run.parked?.requests;
        if (!requests?.some((deferral) => deferral.tool_call_id === toolCallId && isJobDeferral(deferral))) return run;
        changed = true;
        return {
            ...run,
            parked: {
                ...run.parked!,
                requests: requests.map((deferral) =>
                    deferral.tool_call_id === toolCallId ? ({ ...deferral, result } as JobDeferral) : deferral,
                ),
            },
        };
    });
    return changed ? next : null;
}

/** The single run variant of {@link withStoredJobResult}. */
export function runWithStoredJobResult(run: AgentRun | null, toolCallId: string, result: JobResult): AgentRun | null {
    if (!run) return null;
    return withStoredJobResult([run], toolCallId, result)?.[0] ?? null;
}

/**
 * A finished fill as a job snapshot, from the result a job call stored, so
 * the fill's copy (`resultSummary`, `resultTone`) reads it as it reads a live
 * job.
 */
export function fillSnapshotFromResult(result: TableFillJobResult, state?: TableFillJobState): TableFillJobSnapshot {
    const progress = result.progress;
    return {
        job_id: result.job_id,
        plan_id: state?.plan_id ?? '',
        table: { libraryID: 0, key: '', title: state?.title ?? '' },
        origin: { kind: 'agent' },
        state: 'done',
        rows_total: progress.rows_total,
        rows_done: progress.rows_done,
        rows_failed: progress.rows_failed,
        in_flight: 0,
        credits_charged: progress.credits_charged,
        credits_planned: progress.credits_planned,
        balance: null,
        started_at: 0,
        seconds_left: null,
        result: result.result,
    };
}

/** "12 items", "1 item". */
function items(n: number, noun = 'item'): string {
    return `${n.toLocaleString('en-US')} ${n === 1 ? noun : `${noun}s`}`;
}

/**
 * Whether a job ended because the user stopped it (the bar's Stop, or Stop in
 * the table). Such a result does not continue the chat by itself: the user
 * continues it, or writes.
 */
export function isStoppedJobResult(result: JobResult | null | undefined): boolean {
    if (!result) return false;
    if (result.kind === 'table_fill') return result.result.stopped_by === 'stopped';
    return result.items.some((item) => item.failure_reason === 'cancelled');
}

/** Line one of a fill's bar. */
export function fillLabel(result?: TableFillResult | null): string {
    if (!result) return 'Filling table';
    return result.stopped_by ? 'Fill stopped' : 'Table filled';
}

/**
 * How a fill ended, in one line, counting the items it filled: "Filled 11 of
 * 12 items", "Stopped after 6 of 12 items", "Out of credits after 6 of 12
 * items", "Zotero closed after 6 of 12 items".
 */
export function fillResultLine(result: TableFillResult, total: number): string {
    const after = `after ${result.rows_answered.toLocaleString('en-US')} of ${items(total)}`;
    switch (result.stopped_by) {
        case undefined:
            return result.rows_answered === total ? `Filled ${items(total)}` : `Filled ${result.rows_answered.toLocaleString('en-US')} of ${items(total)}`;
        case 'insufficient_credits':
            return `Out of credits ${after}`;
        case 'shutdown':
            return `Zotero closed ${after}`;
        case 'library_excluded':
            return `Stopped ${after}: the library was excluded`;
        case 'read_only':
            return `Stopped ${after}: the library became read-only`;
        case 'table_unavailable':
            return `Stopped ${after}: the table is no longer available`;
        default:
            return `Stopped ${after}`;
    }
}

/** How a finished fill reads in its glyph. */
export function fillTone(result: TableFillResult): 'clean' | 'warning' {
    return !result.stopped_by && result.failed_row_ids.length === 0 && !result.not_written ? 'clean' : 'warning';
}

/** PDF retrieval counts. */
export function pdfCounts(result: PdfRetrievalJobResult): { found: number; failed: number; pending: number; total: number } {
    let found = 0;
    let failed = 0;
    let pending = 0;
    for (const item of result.items) {
        if (item.attachment_status === 'available') found += 1;
        else if (item.attachment_status === 'failed') failed += 1;
        else pending += 1;
    }
    return { found, failed, pending, total: result.items.length };
}

/** Line one of a PDF retrieval's bar. */
export function pdfLabel(result?: PdfRetrievalJobResult | null): string {
    if (!result) return 'Fetching PDFs';
    return isStoppedJobResult(result) ? 'PDF fetch stopped' : 'PDFs fetched';
}

/** A running PDF retrieval: "Fetching 6 of 12 PDFs". */
export function pdfProgressLine(settled: number, total: number): string {
    return `Fetching ${settled.toLocaleString('en-US')} of ${items(total, 'PDF')}`;
}

/** The PDFs not found, for the warning part of a line: "1 not found". */
export function pdfMissingText(missing: number): string | undefined {
    return missing > 0 ? `${missing.toLocaleString('en-US')} not found` : undefined;
}

/** A finished PDF retrieval: "Found 11 of 12 PDFs", "Stopped after 6 of 12 PDFs". */
export function pdfResultSummary(result: PdfRetrievalJobResult): string {
    const { found, total } = pdfCounts(result);
    const of = `${found.toLocaleString('en-US')} of ${items(total, 'PDF')}`;
    if (isStoppedJobResult(result)) return `Stopped after ${of}`;
    if (result.interrupted) return `Zotero closed after ${of}`;
    if (total > 0 && found === total) return `Found ${items(total, 'PDF')}`;
    return `Found ${of}`;
}

/** How a finished PDF retrieval reads in its glyph. */
export function pdfResultTone(result: PdfRetrievalJobResult): 'clean' | 'warning' | 'error' {
    const { found, total } = pdfCounts(result);
    if (total > 0 && found === 0 && !isStoppedJobResult(result)) return 'error';
    return found === total && !result.interrupted ? 'clean' : 'warning';
}
