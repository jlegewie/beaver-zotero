/**
 * The job call this window waits on, whether the open thread's answer is
 * still going, and the table a fill tool call opens. Kept apart from
 * `jobCalls.ts` so the run atoms and the tool call view can read it without
 * importing the composer's job state.
 */

import { atom } from 'jotai';
import { isJobDeferral } from '@beaver/agent-core/protocol/jobCallProtocol';
import { openParkedRunAtom } from '@beaver/agent-core/run-state/parkedRun';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import type { TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';
import type { createStore } from 'jotai';
import { libraryRefForLibraryID } from '../../src/utils/libraryIdentity';

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
 * the waited call still open. `store` is the run session's.
 */
export function settleJobWait(store: ReturnType<typeof createStore>, run: AgentRun | null): void {
    const wait = store.get(jobWaitAtom);
    if (!wait || !run || run.id !== wait.runId) return;
    const open = (run.parked?.requests ?? []).some(
        (deferral) => isJobDeferral(deferral) && deferral.tool_call_id === wait.toolCallId,
    );
    if (!open) store.set(jobWaitAtom, null);
}

/**
 * The open parked run while its answer is still going, else null. It goes
 * on while a card waits for the user, and, in the window waiting on a fill,
 * until that fill's result continues it. A run whose only open calls are
 * fills nobody waits on here has ended: the fill was stopped or left to its
 * table, or another window waits on it. Its footer and what it changed show,
 * though the next message still closes those calls.
 */
export const openAnswerRunIdAtom = atom((get): string | null => {
    const open = get(openParkedRunAtom);
    if (!open) return null;
    const wait = get(jobWaitAtom);
    const going = open.deferrals.some(
        (deferral) => !isJobDeferral(deferral) || wait?.toolCallId === deferral.tool_call_id,
    );
    return going ? open.runId : null;
});

/** The table a fill this device runs works on, as a table item id (`u-KEY`). */
export function chatFillTableKey(snapshot: TableFillJobSnapshot): string | null {
    const ref = libraryRefForLibraryID(snapshot.table.libraryID);
    return ref ? `${ref}-${snapshot.table.key}` : null;
}
