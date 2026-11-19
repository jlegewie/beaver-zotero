/**
 * The waiting window of a table fill job call: only the window that waited on
 * the fill resumes the run with its stored result, the composer is busy only
 * there, leaving ends the wait without stopping the fill, and Stop stops the
 * fill whether the run waits live or is parked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestJobResumeMock, waitsOnlyOnJobsMock, stopMock, leaveMock, hooks } = vi.hoisted(() => ({
    requestJobResumeMock: vi.fn(),
    waitsOnlyOnJobsMock: vi.fn(() => false),
    stopMock: vi.fn(() => true),
    leaveMock: vi.fn(async () => undefined),
    hooks: {
        onStored: null as null | ((stored: unknown) => void),
        onJobWait: null as null | ((wait: unknown) => void),
    },
}));

vi.mock('../../../react/atoms/agentRunAtoms', () => ({
    requestJobResume: requestJobResumeMock,
    waitsOnlyOnJobs: waitsOnlyOnJobsMock,
}));
vi.mock('../../../react/atoms/tableChatFills', () => ({ watchChatFills: vi.fn() }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ tryGetWindowRuntime: () => ({ id: 'window-1' }) }));
vi.mock('@beaver/agent-core/transport/agentService', () => ({
    agentService: {
        onJobWait: (listener: (wait: unknown) => void) => {
            hooks.onJobWait = listener;
            return () => undefined;
        },
    },
}));

import type { AgentRun, ParkedDeferral } from '@beaver/agent-core/agents/types';
import type { TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';
import type { JobResult, StoredJobCall } from '@beaver/agent-core/protocol/jobCallProtocol';
import { activeRunAtom, currentThreadIdAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { openJobCallsAtom } from '@beaver/agent-core/run-state/jobCalls';
import { chatFillsAtom, recordChatFill } from '@beaver/agent-core/run-state/tableChatFills';
import { store } from '../../../react/store';
import { sessionAtom } from '../../../react/atoms/auth';
import { jobWaitAtom, openAnswerRunIdAtom, settleJobWait } from '../../../react/atoms/jobWait';
import {
    liveJobStoppingAtom,
    runningChatJobsAtom,
    stopChatJobsAtom,
    watchJobCalls,
} from '../../../react/atoms/jobCalls';

const THREAD = 'thread-1';

(globalThis as any).Zotero = {
    ...(globalThis as any).Zotero,
    Beaver: {
        ...((globalThis as any).Zotero?.Beaver ?? {}),
        runtime: {
            subscribeWindow: (_runtime: unknown, name: string, callback: (stored: unknown) => void) => {
                if (name === 'job-call:stored') hooks.onStored = callback;
                return () => undefined;
            },
            addWindowCleanup: vi.fn(),
        },
        tableFills: { stop: stopMock },
        jobCalls: { leave: leaveMock },
        data: { env: 'production' },
    },
};

function snapshot(overrides: Partial<TableFillJobSnapshot> = {}, run = 'run-1'): TableFillJobSnapshot {
    return {
        job_id: 'job-1',
        plan_id: 'plan-1',
        table: { libraryID: 1, key: 'TABLE001', title: 'Trials' },
        origin: { kind: 'agent', run: { run_id: run, thread_id: THREAD, tool_call_id: 'call-1' } },
        state: 'running',
        rows_total: 10,
        rows_done: 2,
        rows_failed: 0,
        in_flight: 2,
        credits_charged: 0.4,
        credits_planned: 2,
        balance: null,
        started_at: 1,
        seconds_left: null,
        ...overrides,
    };
}

function fillCall(result?: JobResult): ParkedDeferral {
    return {
        kind: 'table_fill',
        tool_call_id: 'call-1',
        tool_name: 'fill_table',
        correlation_id: 'job-1',
        request: { type: 'background_job', kind: 'table_fill', job_id: 'job-1' },
        ...(result ? ({ result } as object) : {}),
    } as ParkedDeferral;
}

function parkedRun(result?: JobResult): AgentRun {
    return {
        id: 'run-1',
        thread_id: THREAD,
        status: 'completed',
        model_messages: [{ kind: 'response', parts: [{ part_kind: 'tool-call', tool_name: 'fill_table', tool_call_id: 'call-1', args: {} }] }],
        parked: { version: 1, parked_at: '2026-11-18T12:00:00Z', reason: 'timeout', requests: [fillCall(result)] },
        user_prompt: { content: 'Fill it' },
    } as unknown as AgentRun;
}

const fillResult = (stopped = false): JobResult => ({
    kind: 'table_fill',
    job_id: 'job-1',
    status: 'done',
    progress: { state: 'done', rows_total: 10, rows_done: 10, rows_failed: 0, in_flight: 0, credits_charged: 2, credits_planned: 2, seconds_left: null },
    result: {
        rows_answered: 10, answered: 20, not_reported: 0, from_title_abstract: 0, documents_read: 10, credits_charged: 2,
        row_failures: {}, failed_row_ids: [], not_started: {}, not_written: 0, skipped_cells: {}, pending: null,
    },
    ...(stopped ? { stopped: true } : {}),
});

function stored(result: JobResult, toolCallId = 'call-1'): StoredJobCall {
    return { threadId: THREAD, toolCallId, kind: 'table_fill', jobId: 'job-1', userId: 'user-1', result };
}

/** The run started the fill, waited 90 s, and parked; this window waited on it. */
function parkedWhileWaiting(): void {
    store.set(threadRunsAtom, [parkedRun()]);
    hooks.onJobWait!({ runId: 'run-1', threadId: THREAD, toolCallId: 'call-1', jobId: 'job-1' });
}

vi.useFakeTimers();

beforeEach(() => {
    // A Stop's settle window from an earlier test runs out.
    vi.runOnlyPendingTimers();
    vi.clearAllMocks();
    waitsOnlyOnJobsMock.mockReturnValue(false);
    store.set(sessionAtom, { user: { id: 'user-1' } } as any);
    store.set(currentThreadIdAtom, THREAD);
    store.set(threadRunsAtom, []);
    store.set(activeRunAtom, null);
    store.set(jobWaitAtom, null);
    store.set(chatFillsAtom, recordChatFill(new Map(), snapshot()));
    watchJobCalls();
});

describe('the window waiting on a fill', () => {
    it('resumes the run when the fill result is stored, busy until the resume starts', () => {
        parkedWhileWaiting();
        hooks.onStored!(stored(fillResult()));
        expect(requestJobResumeMock).toHaveBeenCalledTimes(1);
        expect(requestJobResumeMock).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: 'call-1' }));
        expect(store.get(openJobCallsAtom)[0].result).toEqual(fillResult());
        // The composer stays busy while the resume is admitted.
        expect(store.get(jobWaitAtom)).not.toBeNull();
        expect(store.get(runningChatJobsAtom)).toEqual([{ jobId: 'job-1', stopping: false }]);
        // The resume started: the window no longer waits, and a repeat resumes nothing.
        store.set(jobWaitAtom, null);
        hooks.onStored!(stored(fillResult()));
        expect(requestJobResumeMock).toHaveBeenCalledTimes(1);
    });

    it('does not resume in a window that did not wait, but shows the result on the call', () => {
        store.set(threadRunsAtom, [parkedRun()]);
        hooks.onStored!(stored(fillResult()));
        expect(requestJobResumeMock).not.toHaveBeenCalled();
        expect(store.get(openJobCallsAtom)[0].result).toEqual(fillResult());
    });

    it('does not resume with a result the user stopped', () => {
        parkedWhileWaiting();
        hooks.onStored!(stored(fillResult(true)));
        expect(requestJobResumeMock).not.toHaveBeenCalled();
        expect(store.get(jobWaitAtom)).toBeNull();
    });

    it('ignores a result stored for another account', () => {
        parkedWhileWaiting();
        hooks.onStored!({ ...stored(fillResult()), userId: 'user-2' });
        expect(requestJobResumeMock).not.toHaveBeenCalled();
        expect(store.get(jobWaitAtom)).not.toBeNull();
    });

    it('stops waiting when the window leaves the chat, which ends the fill\'s call, and resumes nothing', () => {
        parkedWhileWaiting();
        store.set(currentThreadIdAtom, 'thread-2');
        expect(store.get(jobWaitAtom)).toBeNull();
        // The table is not on screen: the fill stops (jobLeave.test.ts covers the rest).
        expect(leaveMock).toHaveBeenCalledWith(THREAD, 'call-1', 'table_fill', 'job-1', 'stop');
        store.set(currentThreadIdAtom, THREAD);
        hooks.onStored!(stored(fillResult()));
        expect(requestJobResumeMock).not.toHaveBeenCalled();
    });

    it('keeps waiting through a park on the fill, and stops when the run ends otherwise', () => {
        parkedWhileWaiting();
        settleJobWait(parkedRun());
        expect(store.get(jobWaitAtom)).not.toBeNull();
        settleJobWait({ ...parkedRun(), parked: undefined } as AgentRun);
        expect(store.get(jobWaitAtom)).toBeNull();
    });
});

describe('the composer while a window waits on a fill', () => {
    it('is busy only in the window that waits', () => {
        store.set(threadRunsAtom, [parkedRun()]);
        expect(store.get(runningChatJobsAtom)).toEqual([]);
        hooks.onJobWait!({ runId: 'run-1', threadId: THREAD, toolCallId: 'call-1', jobId: 'job-1' });
        expect(store.get(runningChatJobsAtom)).toEqual([{ jobId: 'job-1', stopping: false }]);
    });

    it('stops the fill of a parked wait, and stays busy until its stopped result is on the call', () => {
        parkedWhileWaiting();
        expect(store.set(stopChatJobsAtom)).toBe(true);
        expect(stopMock).toHaveBeenCalledWith('job-1');
        expect(store.get(jobWaitAtom)).toBeNull();
        expect(store.get(runningChatJobsAtom)).toEqual([{ jobId: 'job-1', stopping: true }]);
        hooks.onStored!(stored(fillResult(true)));
        expect(store.get(runningChatJobsAtom)).toEqual([]);
        expect(requestJobResumeMock).not.toHaveBeenCalled();
    });

    it('stops the fill of a live wait and lets the run park with it', () => {
        store.set(activeRunAtom, { ...parkedRun(), parked: undefined, status: 'in_progress' } as AgentRun);
        hooks.onJobWait!({ runId: 'run-1', threadId: THREAD, toolCallId: 'call-1', jobId: 'job-1' });
        expect(store.get(runningChatJobsAtom)).toEqual([{ jobId: 'job-1', stopping: false }]);
        waitsOnlyOnJobsMock.mockReturnValue(true);
        expect(store.set(stopChatJobsAtom)).toBe(true);
        expect(stopMock).toHaveBeenCalledWith('job-1');
        expect(store.get(liveJobStoppingAtom)).toBe(true);
        expect(store.get(jobWaitAtom)).toBeNull();
    });

    it('leaves Stop to the run when the run also waits on something else', () => {
        store.set(activeRunAtom, { ...parkedRun(), parked: undefined, status: 'in_progress' } as AgentRun);
        expect(store.set(stopChatJobsAtom)).toBe(false);
        expect(stopMock).not.toHaveBeenCalled();
    });
});

describe('whether the answer of a run parked on a fill has ended', () => {
    it('goes on while the fill runs, and ends once its result is stored and no window waits', () => {
        store.set(threadRunsAtom, [parkedRun()]);
        expect(store.get(openAnswerRunIdAtom)).toBe('run-1');
        store.set(threadRunsAtom, [parkedRun(fillResult(true))]);
        expect(store.get(openAnswerRunIdAtom)).toBeNull();
    });

    it('goes on in the window that waits to continue it with the stored result', () => {
        store.set(threadRunsAtom, [parkedRun(fillResult())]);
        hooks.onJobWait!({ runId: 'run-1', threadId: THREAD, toolCallId: 'call-1', jobId: 'job-1' });
        expect(store.get(openAnswerRunIdAtom)).toBe('run-1');
    });

    it('goes on while a card of the run waits for the user', () => {
        const run = parkedRun(fillResult(true));
        const card = { kind: 'ask_user_question', tool_call_id: 'call-2', tool_name: 'ask_user_question', correlation_id: 'q-1', request: {} };
        run.model_messages[0].parts.push({ part_kind: 'tool-call', tool_name: 'ask_user_question', tool_call_id: 'call-2', args: {} } as any);
        run.parked!.requests.push(card as ParkedDeferral);
        store.set(threadRunsAtom, [run]);
        expect(store.get(openAnswerRunIdAtom)).toBe('run-1');
    });
});
