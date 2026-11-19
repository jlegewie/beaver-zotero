/**
 * This renderer's side of job calls: a table fill a chat run waits on, which
 * can outlast the run's live wait.
 *
 * Only the window that has been waiting on the fill since it started resumes
 * the run (`jobWaitAtom`). It waits from the run's `job_wait_request`,
 * through the park that ends the live wait, until the fill's result is stored
 * on the parked call; then it resumes the run, and the model continues the
 * same answer. Leaving the chat, Stop, and the resume itself end the wait.
 * Every other window shows the response as ended, and the result reaches the
 * model with the user's next message.
 *
 * While the window waits, the chat is busy as during any other tool call:
 * the composer's Stop stops the fill (`stopChatJobsAtom`).
 */

import { atom } from 'jotai';
import { selectAtom } from 'jotai/utils';
import { logger } from '@beaver/agent-core/platform/logger';
import {
    JOB_CALL_STORED_EVENT,
    JOB_WAITERS_CHANGED_EVENT,
    jobIdOf,
    type StoredJobCall,
} from '@beaver/agent-core/protocol/jobCallProtocol';
import { activeRunAtom, currentThreadIdAtom, getRunToolResults } from '@beaver/agent-core/run-state/atoms';
import { isStoppedJobResult, openJobCallsAtom } from '@beaver/agent-core/run-state/jobCalls';
import { chatFillsAtom } from '@beaver/agent-core/run-state/tableChatFills';
import { isRunActive } from '@beaver/agent-core/agents/types';
import { agentService } from '@beaver/agent-core/transport/agentService';
import { tryGetWindowRuntime } from '../runtime/windowRuntime';
import { store } from '../store';
import { userIdAtom } from './auth';
import { requestJobResume, waitsOnlyOnJobs } from './agentRunAtoms';
import { applyStoredJobResultAtom, jobWaitAtom, waitedJobsAtom } from './jobWait';
import { isThreadParkedAtom } from './parkedRuns';
import { watchChatFills } from './tableChatFills';

// ---------------------------------------------------------------------------
// The composer's Stop
// ---------------------------------------------------------------------------

/** A fill of the open chat that this window waits on, as the composer sees it. */
export interface ChatJob {
    jobId: string;
    /** Stop was pressed: it is winding down, or its stopped result is on its way. */
    stopping: boolean;
}

/**
 * Fills the user stopped from the composer, until their stopped results
 * reach the open chat (or `STOP_SETTLE_MS` passes). Until then the composer
 * stays busy, so a message cannot close the call before its result is stored.
 */
const stopRequestsAtom = atom<ReadonlySet<string>>(new Set<string>());
const STOP_SETTLE_MS = 15_000;

/** The run whose live fill wait Stop ended: it parks by itself, and is not stopped again. */
const jobStopRunIdAtom = atom<string | null>(null);

/** Whether Stop ended the running response's live fill wait, and the run is still parking. */
export const liveJobStoppingAtom = atom((get) => {
    const runId = get(jobStopRunIdAtom);
    const run = get(activeRunAtom);
    return !!runId && isRunActive(run) && run!.id === runId;
});

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
    const requested = get(stopRequestsAtom);
    const wait = get(jobWaitAtom);
    const jobs = new Map<string, ChatJob>();
    const add = (jobId: string, winding: boolean) =>
        jobs.set(jobId, { jobId, stopping: winding || requested.has(jobId) });
    for (const call of get(openJobCallsAtom)) {
        const jobId = jobIdOf(call);
        const waited = wait?.threadId === threadId && wait.toolCallId === call.tool_call_id;
        // Its result is stored and the window is about to resume the run.
        if (call.result) {
            if (waited) add(jobId, false);
            continue;
        }
        if (!waited && !requested.has(jobId)) continue;
        const fill = fills.get(jobId);
        if (!fill) continue;
        // Ended after Stop: busy until its stopped result is on the call.
        if (fill.snapshot.state !== 'done' || requested.has(jobId)) add(jobId, fill.snapshot.state === 'stopping');
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
 * composer shows Stop, which stops them.
 */
export const runningChatJobsAtom = selectAtom(chatJobsAtom, (jobs) => jobs, sameJobs);

/**
 * The composer's Stop, for a chat that waits on fills: stop the fills this
 * window waits on. A parked chat stops its fill; a run that waits on nothing
 * but its fills is left to park with their stopped results. Either way the
 * window stops waiting, so nothing resumes. Returns false when Stop should
 * stop the run instead.
 */
export const stopChatJobsAtom = atom(null, (get, set): boolean => {
    const parked = get(isThreadParkedAtom);
    if (!parked && !waitsOnlyOnJobs(get)) return false;
    const jobs = get(runningChatJobsAtom);
    if (!jobs.length) return false;
    const stopping = jobs.filter((job) => !job.stopping);
    for (const job of stopping) {
        logger(`jobCalls: stopping fill ${job.jobId} from the composer`, 1);
        Zotero.Beaver.tableFills?.stop(job.jobId);
    }
    set(jobWaitAtom, null);
    if (!parked) set(jobStopRunIdAtom, get(activeRunAtom)?.id ?? null);
    if (stopping.length) {
        const ids = stopping.map((job) => job.jobId);
        set(stopRequestsAtom, (held) => new Set([...held, ...ids]));
        setTimeout(() => {
            store.set(stopRequestsAtom, (held) => new Set([...held].filter((id) => !ids.includes(id))));
        }, STOP_SETTLE_MS);
    }
    return true;
});

// ---------------------------------------------------------------------------
// Stored results
// ---------------------------------------------------------------------------

/**
 * This device stored a fill's result on its parked call. A window showing the
 * thread shows it on the call; the window waiting on the fill resumes the
 * run with it, and waits until the resume starts. A fill the user stopped
 * resumes nothing.
 */
function onStored(stored: StoredJobCall): void {
    if (stored.userId !== store.get(userIdAtom)) return;
    store.set(applyStoredJobResultAtom, stored);
    const wait = store.get(jobWaitAtom);
    if (!wait || wait.threadId !== stored.threadId || wait.toolCallId !== stored.toolCallId) return;
    if (isStoppedJobResult(stored.result)) {
        store.set(jobWaitAtom, null);
        return;
    }
    logger(`jobCalls: the fill ${stored.jobId} ended; resuming the run`, 1);
    requestJobResume(stored);
}

let watching = false;

/**
 * Follow this window's job waits and the results stored for them, once per
 * renderer.
 */
export function watchJobCalls(): void {
    if (watching) return;
    const runtime = tryGetWindowRuntime();
    if (!runtime) return;
    try {
        watchChatFills();
        Zotero.Beaver.runtime.subscribeWindow(runtime, JOB_CALL_STORED_EVENT, onStored);
        const unsubscribeWaits = agentService.onJobWait((wait) => {
            const threadId = wait.threadId ?? store.get(currentThreadIdAtom);
            if (!threadId || threadId !== store.get(currentThreadIdAtom)) return;
            store.set(jobWaitAtom, { threadId, runId: wait.runId, toolCallId: wait.toolCallId, jobId: wait.jobId });
        });
        Zotero.Beaver.runtime.addWindowCleanup(runtime, unsubscribeWaits);
        // Leaving the chat ends the wait: the fill goes on, and nothing resumes.
        const unsubscribeThread = store.sub(currentThreadIdAtom, () => {
            const wait = store.get(jobWaitAtom);
            if (wait && wait.threadId !== store.get(currentThreadIdAtom)) store.set(jobWaitAtom, null);
        });
        Zotero.Beaver.runtime.addWindowCleanup(runtime, unsubscribeThread);
        // Tell the other windows which fill this one waits on, and follow theirs.
        Zotero.Beaver.runtime.subscribeWindow(runtime, JOB_WAITERS_CHANGED_EVENT, (jobIds: string[]) => {
            store.set(waitedJobsAtom, new Set(jobIds));
        });
        store.set(waitedJobsAtom, new Set(Zotero.Beaver.jobCalls?.waitedJobs() ?? []));
        const reportWait = () => Zotero.Beaver.jobCalls?.setWaiting(runtime.id, store.get(jobWaitAtom)?.jobId ?? null);
        const unsubscribeWait = store.sub(jobWaitAtom, reportWait);
        Zotero.Beaver.runtime.addWindowCleanup(runtime, () => {
            unsubscribeWait();
            Zotero.Beaver.jobCalls?.setWaiting(runtime.id, null);
        });
        watching = true;
    } catch (error) {
        logger(`jobCalls: could not follow job waits: ${String(error)}`, 1);
    }
}
