/**
 * Job calls of the open thread: the open parked run's calls that wait on a
 * job (a table fill) rather than on the user, and how a fill's tool call
 * reads in the chat.
 *
 * A job call is open until a resume returns it or a message closes it.
 */

import { atom } from 'jotai/vanilla';
import { isJobDeferral, type JobDeferral } from '../protocol/jobCallProtocol';
import type { TableFillJobSnapshot, TableFillResult } from '../protocol/tableFillProtocol';
import type { TableFillRecord } from '../protocol/artifactProtocol';
import { openParkedRunAtom } from './parkedRun';
import { TOOL_BASE_LABELS } from './toolCallRequest';
import { readsAsStopped, shownStop } from './tableFillCopy';

/** The open parked run's job calls, in call order. */
export const openJobCallsAtom = atom<readonly JobDeferral[]>((get) => {
    const open = get(openParkedRunAtom);
    if (!open) return EMPTY;
    const calls = open.deferrals.filter(isJobDeferral);
    return calls.length ? calls : EMPTY;
});
const EMPTY: readonly JobDeferral[] = [];

// ---------------------------------------------------------------------------
// A table tool call's line
// ---------------------------------------------------------------------------

/**
 * How far a fill got: items complete (answered or failed) of those it works
 * on, and of those the items that failed.
 */
export interface FillCounts {
    complete: number;
    total: number;
    failed: number;
}

/** What a fill tool call shows: the fill's state, with its counts when known. */
export type FillCallState =
    | ({ kind: 'running'; stopping?: boolean } & FillCounts)
    /**
     * Started, with no counts known here: it runs on another device, or this
     * renderer no longer follows it (Zotero restarted since).
     */
    | { kind: 'started' }
    | ({ kind: 'done' | 'stopped' | 'interrupted' } & FillCounts);

/**
 * A table tool call's line: the tool's name, then either the table's title or
 * the call's status. The status takes the title's place while a fill runs
 * and when it ended short of a clean finish; the title shows otherwise.
 */
export interface TableCallLine {
    /** The tool's name, with a colon when a status follows: "Fill Table:". */
    label: string;
    /** What follows the label: the status, else the title. */
    text: string | null;
}

/** "45 of 150 items complete (stopped, 3 failed)": the phase, then any failures. */
function countsText({ complete, total, failed }: FillCounts, phase?: string): string {
    const items = `${complete.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} ${total === 1 ? 'item' : 'items'} complete`;
    const notes = [phase, failed > 0 ? `${failed.toLocaleString('en-US')} failed` : null].filter(Boolean);
    return notes.length ? `${items} (${notes.join(', ')})` : items;
}

/** The status of a fill, or null for a clean finish, which shows the title instead. */
function fillStatus(state: FillCallState): string | null {
    switch (state.kind) {
        case 'running':
            return countsText(state, state.stopping ? 'stopping' : undefined);
        case 'started':
            return 'running';
        case 'done':
            return state.failed > 0 || state.complete < state.total ? countsText(state) : null;
        case 'stopped':
        case 'interrupted':
            return countsText(state, state.kind);
    }
}

/**
 * The line of a table tool call (`create_table`, `edit_table`, `fill_table`):
 * "Fill Table: 45 of 150 items complete (3 failed)", "Create Table: 60 of
 * 150 items complete (stopped)", or, for a call without a fill or one that
 * filled every item, "Create Table Soil carbon studies".
 */
export function tableCallLine(toolName: string, fill: FillCallState | null, title: string | null): TableCallLine {
    const label = TOOL_BASE_LABELS[toolName] ?? 'Table';
    const status = fill ? fillStatus(fill) : null;
    return status ? { label: `${label}:`, text: status } : { label, text: title };
}

/** A table call's line as one string, for surfaces that show plain text (the status popup). */
export function tableCallText(line: TableCallLine): string {
    return line.text ? `${line.label} ${line.text}` : line.label;
}

/** How a finished fill reads: interrupted by a quit, stopped early, or done. */
function endedKind(result: TableFillResult): 'done' | 'stopped' | 'interrupted' {
    const stop = shownStop(result);
    if (stop === 'shutdown') return 'interrupted';
    return stop ? 'stopped' : 'done';
}

/** Items complete: the count reported, never below those answered or failed, nor above the total. */
function completeRows(reported: number, worked: number, total: number): number {
    return Math.min(total, Math.max(0, reported, worked));
}

/** A finished fill's state from its last counters and its result. */
function endedState(
    progress: Pick<TableFillJobSnapshot, 'rows_done' | 'rows_failed' | 'rows_total'>,
    result: TableFillResult,
): FillCallState {
    const failed = progress.rows_failed || failedRows(result);
    return {
        kind: endedKind(result),
        complete: completeRows(progress.rows_done, result.rows_answered + failed, progress.rows_total),
        total: progress.rows_total,
        failed,
    };
}

function failedRows(result: TableFillResult): number {
    return Object.values(result.row_failures ?? {}).reduce((sum, n) => sum + (n || 0), 0) || result.failed_row_ids.length;
}

/** A fill job's state from its live snapshot (this device runs it). */
export function fillStateFromSnapshot(snapshot: TableFillJobSnapshot): FillCallState {
    if (snapshot.state !== 'done' || !snapshot.result) {
        return {
            kind: 'running',
            stopping: snapshot.state === 'stopping',
            complete: snapshot.rows_done,
            total: snapshot.rows_total,
            failed: snapshot.rows_failed,
        };
    }
    return endedState(snapshot, snapshot.result);
}

/**
 * An open fill job call's state: the fill this device runs (`snapshot`),
 * else only that it started.
 */
export function jobCallFillState(snapshot?: TableFillJobSnapshot | null): FillCallState {
    return snapshot ? fillStateFromSnapshot(snapshot) : { kind: 'started' };
}

/** A finished fill's state from the call's recorded fill (the tool returned). */
export function fillStateFromRecord(fill: TableFillRecord): FillCallState {
    const kind = fill.stopped_by === 'shutdown'
        ? 'interrupted'
        : readsAsStopped(fill.stopped_by, fill.rows_not_started) ? 'stopped' : 'done';
    const failed = fill.rows_failed + (fill.rows_without_input ?? 0);
    // Every planned item the fill did not leave unstarted was worked on.
    const notStarted = Object.values(fill.rows_not_started ?? {}).reduce((sum, n) => sum + (n || 0), 0);
    return { kind, complete: completeRows(fill.rows - notStarted, fill.rows_filled + failed, fill.rows), total: fill.rows, failed };
}
