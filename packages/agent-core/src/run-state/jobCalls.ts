/**
 * Job calls of the open thread: the open parked run's calls that wait on a
 * job (a table fill) rather than on the user, and how a fill's tool call
 * reads in the chat.
 *
 * A job call is open until a resume returns it or a message closes it. Its
 * stored result (`result`) arrives with the run's `parked` record: from the
 * thread's history, or patched in locally by the device that stored it.
 */

import { atom } from 'jotai/vanilla';
import type { AgentRun } from '../agents/types';
import { isJobDeferral, type JobDeferral, type JobResult } from '../protocol/jobCallProtocol';
import type { TableFillJobSnapshot, TableFillResult } from '../protocol/tableFillProtocol';
import type { TableFillRecord } from '../protocol/artifactProtocol';
import { openParkedRunAtom } from './parkedRun';
import { readsAsStopped, shownStop } from './tableFillCopy';

/** The open parked run's job calls, in call order. */
export const openJobCallsAtom = atom<readonly JobDeferral[]>((get) => {
    const open = get(openParkedRunAtom);
    if (!open) return EMPTY;
    const calls = open.deferrals.filter(isJobDeferral);
    return calls.length ? calls : EMPTY;
});
const EMPTY: readonly JobDeferral[] = [];

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
 * Whether a job ended because the user stopped it (Stop in the composer, in
 * the receipt, or in the table). Such a result never resumes the run: the
 * next message closes the call with it.
 */
export function isStoppedJobResult(result: JobResult | null | undefined): boolean {
    return result?.stopped === true;
}

// ---------------------------------------------------------------------------
// The fill's tool call line
// ---------------------------------------------------------------------------

/** How far a fill got: items filled of those it works on, and rows that failed. */
export interface FillCounts {
    filled: number;
    total: number;
    failed: number;
}

/** What a fill tool call shows: the fill's state, with its counts when known. */
export type FillCallState =
    | ({ kind: 'running' } & FillCounts)
    /** Running on another device: no counts reach this one. */
    | { kind: 'elsewhere'; device?: string | null }
    /** Running, with no counts known here (an older call this renderer no longer follows). */
    | { kind: 'started' }
    | ({ kind: 'done' | 'stopped' | 'interrupted' } & FillCounts);

/**
 * A fill tool call's line: the verb, the table's title, and what follows the
 * title (`": 45 of 150 papers · 3 failed"`, `" on Office iMac"`).
 */
export interface FillCallLine {
    label: string;
    title: string | null;
    detail: string | null;
}

function countsText({ filled, total, failed }: FillCounts): string {
    const papers = `${filled.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} ${total === 1 ? 'paper' : 'papers'}`;
    return failed > 0 ? `${papers} · ${failed.toLocaleString('en-US')} failed` : papers;
}

/**
 * The line of a fill tool call: "Filling *Soil carbon*: 45 of 150 papers ·
 * 3 failed", "Filling *Soil carbon* on *Office iMac*", "Filled *Soil carbon*:
 * 147 of 150 papers", "Stopped filling *Soil carbon*: 60 of 150 papers",
 * "Fill interrupted: 60 of 150 papers".
 */
export function fillCallLine(state: FillCallState, title: string | null): FillCallLine {
    switch (state.kind) {
        case 'running':
            return { label: 'Filling', title, detail: `: ${countsText(state)}` };
        case 'elsewhere':
            return { label: 'Filling', title, detail: state.device ? ` on ${state.device}` : null };
        case 'started':
            return { label: 'Filling', title, detail: null };
        case 'done':
            return { label: 'Filled', title, detail: `: ${countsText(state)}` };
        case 'stopped':
            return { label: 'Stopped filling', title, detail: `: ${countsText(state)}` };
        case 'interrupted':
            return { label: 'Fill interrupted', title: null, detail: `: ${countsText(state)}` };
    }
}

/** A fill line as one string, for surfaces that show plain text (the status popup). */
export function fillCallText(line: FillCallLine): string {
    return `${[line.label, line.title].filter(Boolean).join(' ')}${line.detail ?? ''}`;
}

/** How a finished fill reads: interrupted by a quit, stopped early, or done. */
function endedKind(result: TableFillResult, interrupted = false): 'done' | 'stopped' | 'interrupted' {
    const stop = shownStop(result);
    if (interrupted || stop === 'shutdown') return 'interrupted';
    return stop ? 'stopped' : 'done';
}

function failedRows(result: TableFillResult): number {
    return Object.values(result.row_failures ?? {}).reduce((sum, n) => sum + (n || 0), 0) || result.failed_row_ids.length;
}

/** A fill job's state from its live snapshot (this device runs it). */
export function fillStateFromSnapshot(snapshot: TableFillJobSnapshot): FillCallState {
    if (snapshot.state !== 'done' || !snapshot.result) {
        return {
            kind: 'running',
            filled: Math.max(0, snapshot.rows_done - snapshot.rows_failed),
            total: snapshot.rows_total,
            failed: snapshot.rows_failed,
        };
    }
    return {
        kind: endedKind(snapshot.result),
        filled: snapshot.result.rows_answered,
        total: snapshot.rows_total,
        failed: snapshot.rows_failed || failedRows(snapshot.result),
    };
}

/** A fill job's state from the result stored on its parked call. */
export function fillStateFromResult(result: JobResult): FillCallState {
    return {
        kind: endedKind(result.result, result.interrupted),
        filled: result.result.rows_answered,
        total: result.progress.rows_total,
        failed: result.progress.rows_failed || failedRows(result.result),
    };
}

/**
 * An open fill job call's state: its stored result, else the fill this
 * device runs (`snapshot`), else running on the device its state names.
 */
export function jobCallFillState(call: JobDeferral, snapshot?: TableFillJobSnapshot | null): FillCallState {
    if (call.result) return fillStateFromResult(call.result);
    if (snapshot) return fillStateFromSnapshot(snapshot);
    return { kind: 'elsewhere', device: call.state?.device_name };
}

/** A finished fill's state from the call's recorded fill (the tool returned). */
export function fillStateFromRecord(fill: TableFillRecord): FillCallState {
    const kind = fill.stopped_by === 'shutdown'
        ? 'interrupted'
        : readsAsStopped(fill.stopped_by, fill.rows_not_started) ? 'stopped' : 'done';
    return { kind, filled: fill.rows_filled, total: fill.rows, failed: fill.rows_failed };
}

/**
 * A finished fill as a job snapshot, from the result its job call stored, so
 * the fill's copy (`resultSummary`, `failedRowsLink`) reads it as it reads a
 * live job.
 */
export function fillSnapshotFromResult(result: JobResult, title = ''): TableFillJobSnapshot {
    const progress = result.progress;
    return {
        job_id: result.job_id,
        plan_id: '',
        table: { libraryID: 0, key: '', title },
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
