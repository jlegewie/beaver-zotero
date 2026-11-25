/**
 * This renderer's side of job calls: a table fill a chat run waits on, which
 * can outlast the run's live wait.
 *
 * Only the window that has been waiting on the fill since it started resumes
 * the run (`jobWaitAtom`). It waits from the run's `job_wait_request`,
 * through the park that ends the live wait, until the fill ends; then it
 * resumes the run with the fill's result as the call's answer, and the model
 * continues the same answer. Stop and the resume itself end the wait, and so
 * does leaving the chat, which leaves the fill to its open table or stops it
 * (`jobLeave.ts`). Every other window shows the answer as ended, and the next
 * message closes the call with a text saying the fill may still be running.
 *
 * While the window waits on a parked call, the chat is busy as during any
 * other tool call: the composer's Stop stops the fill (`stopChatJobsAtom`).
 * During the live wait, Stop stops the run, which stops the fill.
 */

import { atom } from 'jotai';
import { selectAtom } from 'jotai/utils';
import { logger } from '@beaver/agent-core/platform/logger';
import { jobIdOf } from '@beaver/agent-core/protocol/jobCallProtocol';
import { activeRunAtom, currentThreadIdAtom, getRunToolResults } from '@beaver/agent-core/run-state/atoms';
import { openJobCallsAtom } from '@beaver/agent-core/run-state/jobCalls';
import { openParkedRunAtom } from '@beaver/agent-core/run-state/parkedRun';
import { chatFillsAtom } from '@beaver/agent-core/run-state/tableChatFills';
import { isRunActive } from '@beaver/agent-core/agents/types';
import { agentService } from '@beaver/agent-core/transport/agentService';
import { tryGetWindowRuntime } from '../runtime/windowRuntime';
import { store } from '../store';
import { requestJobResume } from './agentRunAtoms';
import { jobWaitAtom } from '../../src/services/agentRuns/jobWait';
import { leaveJobWait } from './jobLeave';
import { isThreadParkedAtom } from '../../src/services/agentRuns/parkedRuns';
import { watchChatFills } from './tableChatFills';
import { runSessionStore } from '../../src/services/agentRuns/runSession';

// ---------------------------------------------------------------------------
// The composer's Stop
// ---------------------------------------------------------------------------

/** A fill of the open chat that this window waits on, as the composer sees it. */
export interface ChatJob {
    jobId: string;
    /** It is winding down after a Stop in its table. */
    stopping: boolean;
}

/**
 * The fills the open chat waits on in this window: those the run going now
 * waits for (its tool call has not returned), and the parked call this
 * window waits on. Recomputed on every fill snapshot and streamed frame;
 * read {@link runningChatJobsAtom}, which changes only when the list does.
 */
const chatJobsAtom = atom((get): readonly ChatJob[] => {
    const threadId = get(currentThreadIdAtom);
    if (!threadId) return NO_JOBS;
    const fills = get(chatFillsAtom);
    const wait = get(jobWaitAtom);
    const jobs = new Map<string, ChatJob>();
    const add = (jobId: string, stopping: boolean) => jobs.set(jobId, { jobId, stopping });
    for (const call of get(openJobCallsAtom)) {
        if (wait?.threadId !== threadId || wait.toolCallId !== call.tool_call_id) continue;
        const fill = fills.get(jobIdOf(call));
        // Ended, the fill stays here until the resume it starts takes over.
        if (fill) add(fill.snapshot.job_id, fill.snapshot.state === 'stopping');
    }
    const run = get(activeRunAtom);
    if (isRunActive(run)) {
        // Only this run's own results: some models reuse tool call ids across runs.
        const returned = getRunToolResults(run!);
        for (const fill of fills.values()) {
            if (fill.threadId !== threadId || fill.snapshot.state === 'done') continue;
            if (fill.snapshot.origin.run?.run_id === run!.id && !returned.has(fill.toolCallId)) {
                add(fill.snapshot.job_id, fill.snapshot.state === 'stopping');
            }
        }
    }
    return jobs.size ? [...jobs.values()] : NO_JOBS;
});
const NO_JOBS: readonly ChatJob[] = [];

function sameJobs(a: readonly ChatJob[], b: readonly ChatJob[]): boolean {
    return a.length === b.length && a.every((job, i) => job.jobId === b[i].jobId && job.stopping === b[i].stopping);
}

/**
 * The fills the open chat waits on in this window (see `chatJobsAtom`).
 * While any is going, the chat is busy as during any other tool call: the
 * composer shows Stop.
 */
export const runningChatJobsAtom = selectAtom(chatJobsAtom, (jobs) => jobs, sameJobs);

/**
 * The composer's Stop for a parked chat that waits on fills: stop them, and
 * stop waiting, so nothing resumes; the next message closes their calls.
 * Returns false when Stop should stop the run instead: a live run (a resume
 * can run while the chat reads as parked) stops its fills as it stops.
 */
export const stopChatJobsAtom = atom(null, (get): boolean => {
    if (!get(isThreadParkedAtom) || isRunActive(get(activeRunAtom))) return false;
    const jobs = get(runningChatJobsAtom);
    if (!jobs.length) return false;
    for (const job of jobs) {
        logger(`jobCalls: stopping fill ${job.jobId} from the composer`, 1);
        Zotero.Beaver.tableFills?.stop(job.jobId);
    }
    runSessionStore().set(jobWaitAtom, null);
    return true;
});

// ---------------------------------------------------------------------------
// Following the wait
// ---------------------------------------------------------------------------

let watching = false;

/**
 * Follow this window's job waits and the fills they wait on, once per
 * renderer.
 */
export function watchJobCalls(): void {
    if (watching) return;
    const runtime = tryGetWindowRuntime();
    if (!runtime) return;
    try {
        watchChatFills();
        const unsubscribeWaits = agentService.onJobWait((wait) => {
            const threadId = wait.threadId ?? store.get(currentThreadIdAtom);
            if (!threadId || threadId !== store.get(currentThreadIdAtom)) return;
            runSessionStore().set(jobWaitAtom, { threadId, runId: wait.runId, toolCallId: wait.toolCallId, jobId: wait.jobId });
        });
        Zotero.Beaver.runtime.addWindowCleanup(runtime, unsubscribeWaits);
        // The fill this window waits on may have ended, or its run's park
        // arrived after it did (a reattach): the parked run resumes.
        const resume = () => {
            if (store.get(jobWaitAtom)) requestJobResume();
        };
        Zotero.Beaver.runtime.addWindowCleanup(runtime, store.sub(chatFillsAtom, resume));
        Zotero.Beaver.runtime.addWindowCleanup(runtime, store.sub(openParkedRunAtom, resume));
        // Leaving the chat by any other way than the thread commands (which
        // end the wait before they stop the run) ends it too.
        const unsubscribeThread = store.sub(currentThreadIdAtom, () => {
            const wait = store.get(jobWaitAtom);
            if (wait && wait.threadId !== store.get(currentThreadIdAtom)) leaveJobWait();
        });
        Zotero.Beaver.runtime.addWindowCleanup(runtime, unsubscribeThread);
        watching = true;
    } catch (error) {
        logger(`jobCalls: could not follow job waits: ${String(error)}`, 1);
    }
}
