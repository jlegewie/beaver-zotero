/**
 * The job call this window waits on, the stored results it shows on the open
 * thread's parked calls, and the table a fill tool call opens. Kept apart
 * from `jobCalls.ts` so the run atoms and the tool call view can read it
 * without importing the composer's job state.
 */

import { atom } from 'jotai';
import { isJobDeferral, type JobResult } from '@beaver/agent-core/protocol/jobCallProtocol';
import { activeRunAtom, currentThreadIdAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { runWithStoredJobResult, withStoredJobResult } from '@beaver/agent-core/run-state/jobCalls';
import { openParkedRunAtom } from '@beaver/agent-core/run-state/parkedRun';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import type { TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';
import { libraryRefForLibraryID } from '../../src/utils/libraryIdentity';
import { store } from '../store';

/** The job call this window waits on: the run that waited, and its tool call. */
export interface JobWait {
    threadId: string;
    runId: string;
    toolCallId: string;
    jobId: string;
}

/**
 * The fill this window waits on, or null. Set when the run's job wait
 * starts and kept when the run parks for the wait's timeout; cleared when
 * the window leaves the chat, on Stop, and when the resume starts.
 */
export const jobWaitAtom = atom<JobWait | null>(null);

/**
 * A run of this window ended: the wait goes on only when the run parked with
 * the waited call still open and its result not stored yet.
 */
export function settleJobWait(run: AgentRun | null): void {
    const wait = store.get(jobWaitAtom);
    if (!wait || !run || run.id !== wait.runId) return;
    const open = (run.parked?.requests ?? []).some(
        (deferral) => isJobDeferral(deferral) && deferral.tool_call_id === wait.toolCallId && !deferral.result,
    );
    if (!open) store.set(jobWaitAtom, null);
}

/**
 * The open parked run while its answer is still going, else null. It goes
 * on while a card waits for the user, while a fill it started still runs
 * (its result is not stored yet), and while this window waits to continue
 * it with a fill's result. A run whose only open calls hold stored fill
 * results has ended: the fill was stopped, handed to the table, cut off by a
 * quit, or ended with nobody waiting. Its footer and what it changed show,
 * though the next message still closes those calls.
 */
export const openAnswerRunIdAtom = atom((get): string | null => {
    const open = get(openParkedRunAtom);
    if (!open) return null;
    const wait = get(jobWaitAtom);
    const going = open.deferrals.some(
        (deferral) => !isJobDeferral(deferral) || !deferral.result || wait?.toolCallId === deferral.tool_call_id,
    );
    return going ? open.runId : null;
});

/** Put a stored job result on the open thread's parked call. Returns whether it was there. */
export const applyStoredJobResultAtom = atom(
    null,
    (get, set, { threadId, toolCallId, result }: { threadId: string; toolCallId: string; result: JobResult }): boolean => {
        if (get(currentThreadIdAtom) !== threadId) return false;
        const runs = withStoredJobResult(get(threadRunsAtom), toolCallId, result);
        if (runs) set(threadRunsAtom, runs);
        const active = runWithStoredJobResult(get(activeRunAtom), toolCallId, result);
        if (active) set(activeRunAtom, active);
        return !!(runs || active);
    },
);

/** The table a fill this device runs works on, as a table item id (`u-KEY`). */
export function chatFillTableKey(snapshot: TableFillJobSnapshot): string | null {
    const ref = libraryRefForLibraryID(snapshot.table.libraryID);
    return ref ? `${ref}-${snapshot.table.key}` : null;
}
