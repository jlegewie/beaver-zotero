/**
 * Table fills a chat run started, as the chat shows them: the fill tool
 * call's line and receipt, and the composer while a window waits on one.
 *
 * Fed by the fill job's own snapshots (the same ones the table's tab
 * follows), never by backend events: a snapshot names the run's thread and
 * tool call (`origin.run`). State is keyed by job and kept per renderer, so
 * the tool call can report a fill that went on after its run parked or
 * ended. Fills the user started in the tab have no run and never appear
 * here.
 */

import { atom } from 'jotai/vanilla';
import type { TableFillJobSnapshot } from '../protocol/tableFillProtocol';

export interface ChatFill {
    /** The job's latest snapshot. */
    snapshot: TableFillJobSnapshot;
    /** The thread whose run started the fill. */
    threadId: string;
    /** The tool call that started it (`fill_table`, or `create_table` approved with the fill ticked). */
    toolCallId: string;
}

/** Chat fills by job id. */
export const chatFillsAtom = atom<Map<string, ChatFill>>(new Map());

/**
 * Fold a snapshot into the chat fills. A fill without a run (started from
 * the tab) is ignored. A snapshot older than the one held is dropped: the
 * runtime can deliver a job's snapshots out of order across a hydration.
 */
export function recordChatFill(fills: Map<string, ChatFill>, snapshot: TableFillJobSnapshot): Map<string, ChatFill> {
    const run = snapshot?.origin?.kind === 'agent' ? snapshot.origin.run : undefined;
    if (!run?.thread_id || !run.tool_call_id) return fills;
    const held = fills.get(snapshot.job_id);
    if (held && isOlder(snapshot, held.snapshot)) return fills;
    const next = new Map(fills);
    next.set(snapshot.job_id, {
        snapshot,
        threadId: run.thread_id,
        toolCallId: run.tool_call_id,
    });
    return next;
}

/** Whether `a` describes an earlier state of the job than `b`. */
function isOlder(a: TableFillJobSnapshot, b: TableFillJobSnapshot): boolean {
    const rank = { running: 0, stopping: 1, done: 2 } as const;
    if (rank[a.state] !== rank[b.state]) return rank[a.state] < rank[b.state];
    return a.rows_done < b.rows_done;
}

export const recordChatFillAtom = atom(null, (get, set, snapshot: TableFillJobSnapshot) => {
    const current = get(chatFillsAtom);
    const next = recordChatFill(current, snapshot);
    if (next !== current) set(chatFillsAtom, next);
});

/**
 * The fill a run's tool call started, if this renderer has seen it. Scoped to
 * the run: some models reuse tool call ids across responses.
 */
export function fillForToolCall(fills: Map<string, ChatFill>, toolCallId: string, runId: string): ChatFill | null {
    for (const fill of fills.values())
        if (fill.toolCallId === toolCallId && fill.snapshot.origin.run?.run_id === runId) return fill;
    return null;
}
