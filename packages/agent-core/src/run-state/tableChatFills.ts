/**
 * Table fills a chat run started, as the chat shows them: the progress panel
 * above the composer and the `fill_table` tool call's status line.
 *
 * Fed by the fill job's own snapshots (the same ones the table's tab
 * follows), never by backend events: a snapshot names the run's thread and
 * tool call (`origin.run`). State is keyed by job and kept per renderer, so a
 * fill stays visible past the end of its run, while the user keeps chatting
 * and when they leave the thread and come back. A finished fill stays as its
 * result line until the user dismisses it. Fills the user started in the tab
 * have no run and never appear here.
 */

import { atom } from 'jotai/vanilla';
import type { TableFillJobSnapshot } from '../protocol/tableFillProtocol';
import { activeRunAtom, getRunToolResults } from './atoms';

export interface ChatFill {
    /** The job's latest snapshot. */
    snapshot: TableFillJobSnapshot;
    /** The thread whose run started the fill. */
    threadId: string;
    /** The tool call that started it (`fill_table`, or `create_table`'s "Create and fill"). */
    toolCallId: string;
    /** The user dismissed its result line. */
    dismissed: boolean;
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
        dismissed: held?.dismissed ?? false,
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

/** The user closed a finished fill's result line. */
export const dismissChatFillAtom = atom(null, (get, set, jobId: string) => {
    const current = get(chatFillsAtom);
    const fill = current.get(jobId);
    if (!fill || fill.dismissed) return;
    const next = new Map(current);
    next.set(jobId, { ...fill, dismissed: true });
    set(chatFillsAtom, next);
});

/**
 * The fill the panel shows in `threadId`: a running one first, else the most
 * recently started finished one the user has not dismissed. Other threads'
 * fills never show.
 */
export function panelFill(fills: Map<string, ChatFill>, threadId: string | null): ChatFill | null {
    if (!threadId) return null;
    let running: ChatFill | null = null;
    let finished: ChatFill | null = null;
    for (const fill of fills.values()) {
        if (fill.threadId !== threadId) continue;
        if (fill.snapshot.state !== 'done') {
            if (!running || fill.snapshot.started_at > running.snapshot.started_at) running = fill;
        } else if (!fill.dismissed) {
            if (!finished || fill.snapshot.started_at > finished.snapshot.started_at) finished = fill;
        }
    }
    return running ?? finished;
}

/**
 * The running fill the active run waits on: one whose tool call has not
 * returned yet. Stop response stops it too (the plugin does that itself).
 */
export function waitingFill(
    fills: Map<string, ChatFill>,
    runId: string | null,
    returned: (toolCallId: string) => boolean,
): ChatFill | null {
    if (!runId) return null;
    for (const fill of fills.values()) {
        if (fill.snapshot.state === 'done') continue;
        if (fill.snapshot.origin.run?.run_id !== runId) continue;
        if (!returned(fill.toolCallId)) return fill;
    }
    return null;
}

/**
 * Whether the active run waits on a table fill, for the composer's stop. A
 * boolean, so a streamed frame that changes the run but not the answer
 * re-renders nothing; only the active run's own results count, since some
 * models reuse tool call ids across runs.
 */
export const waitsOnFillAtom = atom((get) => {
    const fills = get(chatFillsAtom);
    if (!fills.size) return false;
    const run = get(activeRunAtom);
    if (!run) return false;
    const returned = getRunToolResults(run);
    return waitingFill(fills, run.id, (id) => returned.has(id)) !== null;
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

/**
 * The `fill_table` tool call's status line: "Filling 46 papers…" while the
 * tool waits on its fill, "Filling in the background" once it returned
 * `running`. No live counts: those are in the panel.
 */
export function fillStatusLine(state: 'waiting' | 'background' | 'started', rows?: number): string {
    if (state === 'background') return 'Filling in the background';
    // A fill this renderer no longer follows (Zotero restarted since): what is known is that it started.
    if (state === 'started') return 'Started filling in the background';
    return rows && rows > 0 ? `Filling ${rows.toLocaleString('en-US')} ${rows === 1 ? 'paper' : 'papers'}…` : 'Filling…';
}
