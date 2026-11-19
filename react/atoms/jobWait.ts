/**
 * The job call this window waits on, the stored results it shows on the open
 * thread's parked calls, and the fill controls a tool call's receipt uses.
 * Kept apart from `jobCalls.ts` so the run atoms and the tool call view can
 * read it without importing the composer's job state.
 */

import { atom } from 'jotai';
import { isJobDeferral, type JobResult } from '@beaver/agent-core/protocol/jobCallProtocol';
import { activeRunAtom, currentThreadIdAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { runWithStoredJobResult, withStoredJobResult } from '@beaver/agent-core/run-state/jobCalls';
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

/** The jobs some window of this Zotero waits on (this one included), by job id. */
export const waitedJobsAtom = atom<ReadonlySet<string>>(new Set<string>());

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

/** Stop a fill this device runs: rows in flight finish, no new ones start. */
export const stopChatFillAtom = atom(null, (_get, _set, jobId: string) => {
    Zotero.Beaver?.tableFills?.stop(jobId);
});
