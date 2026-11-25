/**
 * The waiting window of a table fill job call: only the window that waited on
 * the fill resumes the run once the fill ends, with its result as the call's
 * answer; the composer is busy only there; leaving ends the wait; and Stop
 * stops a parked wait's fill, while a live run stops as any run does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestJobResumeMock, stopMock, releaseMock, hooks } = vi.hoisted(() => ({
    requestJobResumeMock: vi.fn(),
    stopMock: vi.fn(() => true),
    releaseMock: vi.fn(),
    hooks: {
        onJobWait: null as null | ((wait: unknown) => void),
    },
}));

vi.mock('../../../react/atoms/agentRunAtoms', () => ({
    requestJobResume: requestJobResumeMock,
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
import { activeRunAtom, currentThreadIdAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { chatFillsAtom, recordChatFill } from '@beaver/agent-core/run-state/tableChatFills';
import { store } from '../../../react/store';
import { jobWaitAtom, openAnswerRunIdAtom, settleJobWait } from '../../../react/atoms/jobWait';
import { runningChatJobsAtom, stopChatJobsAtom, watchJobCalls } from '../../../react/atoms/jobCalls';
import { isThreadParkedAtom } from '../../../react/atoms/parkedRuns';
import { chatStore } from '../../helpers/runSession';

const THREAD = 'thread-1';

(globalThis as any).Zotero = {
    ...(globalThis as any).Zotero,
    Beaver: {
        ...((globalThis as any).Zotero?.Beaver ?? {}),
        runtime: { addWindowCleanup: vi.fn() },
        tableFills: { stop: stopMock, agent: { release: releaseMock } },
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

const ended = (): TableFillJobSnapshot => snapshot({
    state: 'done',
    rows_done: 10,
    in_flight: 0,
    result: {
        rows_answered: 10, answered: 20, not_reported: 0, from_title_abstract: 0, documents_read: 10, credits_charged: 2,
        row_failures: {}, failed_row_ids: [], not_started: {}, not_written: 0, skipped_cells: {}, pending: null,
    },
});

function fillCall(): ParkedDeferral {
    return {
        kind: 'table_fill',
        tool_call_id: 'call-1',
        tool_name: 'fill_table',
        correlation_id: 'job-1',
        request: { type: 'background_job', kind: 'table_fill', job_id: 'job-1' },
    } as ParkedDeferral;
}

function parkedRun(): AgentRun {
    return {
        id: 'run-1',
        thread_id: THREAD,
        status: 'completed',
        model_messages: [{ kind: 'response', parts: [{ part_kind: 'tool-call', tool_name: 'fill_table', tool_call_id: 'call-1', args: {} }] }],
        parked: { version: 1, parked_at: '2026-11-18T12:00:00Z', reason: 'timeout', requests: [fillCall()] },
        user_prompt: { content: 'Fill it' },
    } as unknown as AgentRun;
}

/** The run started the fill, waited 90 s, and parked; this window waited on it. */
function parkedWhileWaiting(): void {
    chatStore().set(threadRunsAtom, [parkedRun()]);
    hooks.onJobWait!({ runId: 'run-1', threadId: THREAD, toolCallId: 'call-1', jobId: 'job-1' });
}

beforeEach(() => {
    chatStore().set(jobWaitAtom, null);
    chatStore().set(currentThreadIdAtom, THREAD);
    chatStore().set(threadRunsAtom, []);
    chatStore().set(activeRunAtom, null);
    vi.clearAllMocks();
    store.set(chatFillsAtom, recordChatFill(new Map(), snapshot()));
    watchJobCalls();
});

describe('the window waiting on a fill', () => {
    it('asks for the resume as the fill changes, busy until the resume starts', () => {
        parkedWhileWaiting();
        store.set(chatFillsAtom, recordChatFill(new Map(), ended()));
        expect(requestJobResumeMock).toHaveBeenCalledTimes(1);
        // The composer stays busy while the resume is admitted.
        expect(store.get(runningChatJobsAtom)).toEqual([{ jobId: 'job-1', stopping: false }]);
        // The resume started: the window no longer waits, and nothing resumes again.
        chatStore().set(jobWaitAtom, null);
        store.set(chatFillsAtom, recordChatFill(new Map(), ended()));
        expect(requestJobResumeMock).toHaveBeenCalledTimes(1);
    });

    it('asks for the resume when the park arrives after the fill ended', () => {
        // The fill ended while the run reattached; its park comes in after.
        hooks.onJobWait!({ runId: 'run-1', threadId: THREAD, toolCallId: 'call-1', jobId: 'job-1' });
        store.set(chatFillsAtom, recordChatFill(new Map(), ended()));
        requestJobResumeMock.mockClear();
        chatStore().set(threadRunsAtom, [parkedRun()]);
        expect(requestJobResumeMock).toHaveBeenCalled();
    });

    it('does not resume in a window that did not wait', () => {
        chatStore().set(threadRunsAtom, [parkedRun()]);
        store.set(chatFillsAtom, recordChatFill(new Map(), ended()));
        expect(requestJobResumeMock).not.toHaveBeenCalled();
    });

    it('stops waiting when the window leaves the chat, and resumes nothing', () => {
        parkedWhileWaiting();
        chatStore().set(currentThreadIdAtom, 'thread-2');
        expect(store.get(jobWaitAtom)).toBeNull();
        // The table is not on screen: the fill stops (jobLeave.test.ts covers the rest).
        expect(stopMock).toHaveBeenCalledWith('job-1');
        chatStore().set(currentThreadIdAtom, THREAD);
        store.set(chatFillsAtom, recordChatFill(new Map(), ended()));
        expect(requestJobResumeMock).not.toHaveBeenCalled();
    });

    it('keeps waiting through a park on the fill, and stops when the run ends otherwise', () => {
        parkedWhileWaiting();
        settleJobWait(chatStore(), parkedRun());
        expect(store.get(jobWaitAtom)).not.toBeNull();
        settleJobWait(chatStore(), { ...parkedRun(), parked: undefined } as AgentRun);
        expect(store.get(jobWaitAtom)).toBeNull();
    });
});

describe('the composer while a window waits on a fill', () => {
    it('is busy only in the window that waits', () => {
        chatStore().set(threadRunsAtom, [parkedRun()]);
        expect(store.get(runningChatJobsAtom)).toEqual([]);
        hooks.onJobWait!({ runId: 'run-1', threadId: THREAD, toolCallId: 'call-1', jobId: 'job-1' });
        expect(store.get(runningChatJobsAtom)).toEqual([{ jobId: 'job-1', stopping: false }]);
    });

    it('stops the fill of a parked wait, and stops waiting, so nothing resumes', () => {
        parkedWhileWaiting();
        expect(store.set(stopChatJobsAtom)).toBe(true);
        expect(stopMock).toHaveBeenCalledWith('job-1');
        expect(store.get(jobWaitAtom)).toBeNull();
        expect(store.get(runningChatJobsAtom)).toEqual([]);
        store.set(chatFillsAtom, recordChatFill(new Map(), ended()));
        expect(requestJobResumeMock).not.toHaveBeenCalled();
    });

    it('leaves Stop to the run while the run waits live, which stops its fill as it stops', () => {
        chatStore().set(activeRunAtom, { ...parkedRun(), parked: undefined, status: 'in_progress' } as AgentRun);
        hooks.onJobWait!({ runId: 'run-1', threadId: THREAD, toolCallId: 'call-1', jobId: 'job-1' });
        expect(store.get(runningChatJobsAtom)).toEqual([{ jobId: 'job-1', stopping: false }]);
        expect(store.set(stopChatJobsAtom)).toBe(false);
        expect(stopMock).not.toHaveBeenCalled();
    });

    it('leaves Stop to a live resume though the chat reads as parked', () => {
        parkedWhileWaiting();
        chatStore().set(activeRunAtom, {
            ...parkedRun(), id: 'run-2', parked: undefined, status: 'in_progress', user_prompt: { content: '', resumes_run_id: 'run-1' },
        } as AgentRun);
        expect(store.get(isThreadParkedAtom)).toBe(true);
        expect(store.set(stopChatJobsAtom)).toBe(false);
        expect(stopMock).not.toHaveBeenCalled();
    });
});

describe('whether the answer of a run parked on a fill has ended', () => {
    it('goes on only in the window that waits on the fill', () => {
        chatStore().set(threadRunsAtom, [parkedRun()]);
        expect(store.get(openAnswerRunIdAtom)).toBeNull();
        hooks.onJobWait!({ runId: 'run-1', threadId: THREAD, toolCallId: 'call-1', jobId: 'job-1' });
        expect(store.get(openAnswerRunIdAtom)).toBe('run-1');
    });

    it('goes on while a card of the run waits for the user', () => {
        const run = parkedRun();
        const card = { kind: 'ask_user_question', tool_call_id: 'call-2', tool_name: 'ask_user_question', correlation_id: 'q-1', request: {} };
        run.model_messages[0].parts.push({ part_kind: 'tool-call', tool_name: 'ask_user_question', tool_call_id: 'call-2', args: {} } as any);
        run.parked!.requests.push(card as ParkedDeferral);
        chatStore().set(threadRunsAtom, [run]);
        expect(store.get(openAnswerRunIdAtom)).toBe('run-1');
    });
});
