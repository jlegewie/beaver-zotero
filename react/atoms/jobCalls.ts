/**
 * This renderer's side of job calls: a table fill a chat run waits on, which
 * can outlast the run's live wait.
 *
 * The run's session waits on the fill (`agentRuns` registry), from the run's
 * `job_wait_request`, through the park that ends the live wait, until the
 * fill ends; then it resumes the run with the fill's result as the call's
 * answer, and the model continues the same answer. That happens whether or
 * not a window shows the chat. Stop and the resume itself end the wait.
 *
 * While the session waits on a parked call, the chat is busy as during any
 * other tool call: the composer's Stop stops the fill (`stopChatJobsAtom`).
 * During the live wait, Stop stops the run, which stops the fill.
 */

import { atom } from 'jotai';
import { selectAtom } from 'jotai/utils';
import { logger } from '@beaver/agent-core/platform/logger';
import { jobIdOf } from '@beaver/agent-core/protocol/jobCallProtocol';
import { activeRunAtom, currentThreadIdAtom, getRunToolResults } from '@beaver/agent-core/run-state/atoms';
import { openJobCallsAtom } from '@beaver/agent-core/run-state/jobCalls';
import { chatFillsAtom } from '@beaver/agent-core/run-state/tableChatFills';
import { isRunActive } from '@beaver/agent-core/agents/types';
import { jobWaitAtom } from '../../src/services/agentRuns/jobWait';
import { isThreadParkedAtom } from '../../src/services/agentRuns/parkedRuns';
import { runSessionStore } from '../runtime/runSessionStore';

// ---------------------------------------------------------------------------
// The composer's Stop
// ---------------------------------------------------------------------------

/** A fill the open chat waits on, as the composer sees it. */
export interface ChatJob {
    jobId: string;
    /** It is winding down after a Stop in its table. */
    stopping: boolean;
}

/**
 * The fills the open chat waits on: those the run going now waits for (its
 * tool call has not returned), and the parked call its session waits on. Recomputed on every fill snapshot and streamed frame;
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
 * The fills the open chat waits on (see `chatJobsAtom`).
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
