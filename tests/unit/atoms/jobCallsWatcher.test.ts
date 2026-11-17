/**
 * A window's side of job calls: a result stored on this device, or on another
 * device (learned from the thread's `awaiting_input`), resumes the run in the
 * window that shows the thread.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { atom, createStore } from 'jotai';

const h = vi.hoisted(() => ({
    store: null as any,
    continued: vi.fn(),
    getThreadRuns: vi.fn(),
    subscribers: new Map<string, (detail: any) => void>(),
    viewers: [] as { windowId: string; threadId: string }[],
    entities: null as any,
    messages: [] as any[],
    removed: [] as string[],
    dispatched: [] as unknown[][],
    popupMessages: null as any,
    getThread: vi.fn(async () => ({})),
    waitsOnly: false,
}));

vi.mock('../../../react/store', async () => {
    const { createStore } = await import('jotai');
    h.store = createStore();
    return { store: h.store };
});
vi.mock('../../../react/atoms/agentRunAtoms', async () => {
    const { hasReadyJobCallAtom } = await import('@beaver/agent-core/run-state/jobCalls');
    // As the real atom: only a result that continues the chat resumes it.
    return {
        continueParkedJobsAtom: atom(null, (get) => {
            if (get(hasReadyJobCallAtom)) h.continued();
        }),
        waitsOnlyOnJobs: () => h.waitsOnly,
    };
});
vi.mock('../../../react/atoms/threads', () => ({ loadThreadAtom: atom(null, () => {}) }));
vi.mock('../../../react/atoms/auth', () => ({ userIdAtom: atom('user-1') }));
vi.mock('../../../react/atoms/ui', async () => {
    const { atom } = await import('jotai');
    h.popupMessages = atom<any[]>([]);
    return { isSidebarVisibleAtom: atom(true), popupMessagesAtom: h.popupMessages };
});
vi.mock('../../../react/atoms/threadList', async () => {
    const { atom } = await import('jotai');
    h.entities = atom(new Map());
    return { threadEntitiesAtom: h.entities };
});
vi.mock('../../../react/utils/popupMessageUtils', () => ({
    addPopupMessageAtom: atom(null, (_get, _set, message: any) => h.messages.push(message)),
    removePopupMessageAtom: atom(null, (_get, _set, id: string) => h.removed.push(id)),
}));
vi.mock('../../../react/events/eventManager', () => ({ eventManager: { dispatch: (...args: unknown[]) => h.dispatched.push(args) } }));
vi.mock('../../../src/services/systemNotifications', () => ({ notifyJobReady: vi.fn() }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ tryGetWindowRuntime: () => ({ id: 'win-1' }) }));
vi.mock('@beaver/agent-core/transport/agentService', () => ({ agentRunService: { getThreadRuns: (...args: unknown[]) => h.getThreadRuns(...args) } }));

import { activeRunAtom, currentThreadIdAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { openJobCallsAtom } from '@beaver/agent-core/run-state/jobCalls';
import { chatFillsAtom } from '@beaver/agent-core/run-state/tableChatFills';
import {
    applyStoredJobResultAtom,
    jobReadyNoticesAtom,
    jobStopRunIdAtom,
    openJobReadyChatAtom,
    runningChatJobsAtom,
    stopChatJobsAtom,
    watchJobCalls,
} from '../../../react/atoms/jobCalls';
import { userIdAtom } from '../../../react/atoms/auth';

const result = { kind: 'table_fill', job_id: 'job-1', status: 'done', progress: { rows_total: 2 }, result: { rows_answered: 2, failed_row_ids: [] } };

function parkedRun(withResult: boolean) {
    return {
        id: 'run-1',
        thread_id: 'thread-1',
        status: 'completed',
        model_messages: [{ kind: 'response', parts: [{ part_kind: 'tool-call', tool_name: 'fill_table', tool_call_id: 'call-1', args: {} }] }],
        parked: {
            version: 1, parked_at: '2026-11-15T12:00:00Z', reason: 'timeout',
            requests: [{
                kind: 'table_fill', tool_call_id: 'call-1', tool_name: 'fill_table', correlation_id: 'job-1',
                request: { type: 'background_job', kind: 'table_fill', job_id: 'job-1' },
                ...(withResult ? { result } : {}),
            }],
        },
        user_prompt: { content: 'fill' },
    };
}

beforeEach(() => {
    (globalThis as any).Zotero.Beaver = {
        runtime: {
            subscribeWindow: (_runtime: unknown, name: string, callback: (detail: any) => void) => h.subscribers.set(name, callback),
            addWindowCleanup: () => {},
        },
        presence: { getSnapshot: () => ({ viewers: h.viewers }) },
        pdfJobs: { listJobs: () => [] },
        threads: { getThread: h.getThread },
        data: { env: 'test' },
    };
    watchJobCalls();
    h.continued.mockReset();
    h.viewers = [{ windowId: 'win-1', threadId: 'thread-1' }];
    h.store.set(currentThreadIdAtom, 'thread-1');
    h.store.set(threadRunsAtom, [parkedRun(false)]);
});

describe('a stored job result', () => {
    it('stored on this device: the window showing the thread puts it on the call and resumes', () => {
        h.subscribers.get('job-call:stored')!({ threadId: 'thread-1', toolCallId: 'call-1', kind: 'table_fill', jobId: 'job-1', userId: 'user-1', result, viewerWindowIds: ['win-1'] });
        expect(h.store.get(openJobCallsAtom)[0].result).toEqual(result);
        expect(h.continued).toHaveBeenCalledTimes(1);
    });

    it('stored on another device: the window showing the thread reloads it and resumes', async () => {
        h.getThreadRuns.mockResolvedValue({ runs: [parkedRun(true)] });
        h.store.set(h.entities, new Map([['thread-1', { id: 'thread-1', awaitingInput: { job_ready: 1 } }]]));
        await vi.waitFor(() => expect(h.continued).toHaveBeenCalledTimes(1));
        expect(h.store.get(openJobCallsAtom)[0].result).toEqual(result);
    });

    it('stored on another device: a second window showing the thread does not resume too', async () => {
        h.viewers = [{ windowId: 'win-0', threadId: 'thread-1' }, { windowId: 'win-1', threadId: 'thread-1' }];
        h.getThreadRuns.mockResolvedValue({ runs: [parkedRun(true)] });
        h.store.set(h.entities, new Map([['thread-1', { id: 'thread-1', awaitingInput: { job_ready: 1 } }]]));
        await vi.waitFor(() => expect(h.store.get(openJobCallsAtom)[0].result).toEqual(result));
        expect(h.continued).not.toHaveBeenCalled();
    });
});

describe('a finished job of a chat no window shows', () => {
    it('is reported once, and opening it opens Beaver and clears both notices', () => {
        h.store.set(currentThreadIdAtom, 'thread-2');
        h.subscribers.get('job-call:stored')!({
            threadId: 'thread-1', toolCallId: 'call-1', kind: 'table_fill', jobId: 'job-1', userId: 'user-1', result,
            viewerWindowIds: [], notifyWindowId: 'win-1', subject: 'Trials',
        });
        expect(h.store.get(jobReadyNoticesAtom).map((notice: any) => notice.threadId)).toEqual(['thread-1']);
        expect(h.messages.at(-1)).toMatchObject({ id: 'job-ready-thread-1', title: 'Table filled · Trials' });
        h.store.set(openJobReadyChatAtom, 'thread-1');
        expect(h.store.get(jobReadyNoticesAtom)).toEqual([]);
        expect(h.removed).toContain('job-ready-thread-1');
        expect(h.dispatched).toContainEqual(['toggleChat', { forceOpen: true }]);
        expect(h.continued).not.toHaveBeenCalled();
    });
});

describe('a result stored before any window could report it', () => {
    it('is reported by the renderer once it knows the account', () => {
        const held = [{
            threadId: 'thread-9', toolCallId: 'call-9', kind: 'table_fill', jobId: 'job-9', userId: 'user-1', result,
            viewerWindowIds: [], subject: 'Startup fill',
        }];
        (globalThis as any).Zotero.Beaver.jobCalls = { takeHeld: vi.fn(() => held.splice(0)) };
        h.getThread.mockClear();
        h.store.set(currentThreadIdAtom, null);
        h.store.set(userIdAtom as any, null);
        h.store.set(userIdAtom as any, 'user-1');
        expect(h.store.get(jobReadyNoticesAtom).map((notice: any) => notice.threadId)).toContain('thread-9');
        expect(h.messages.at(-1)).toMatchObject({ id: 'job-ready-thread-9', title: 'Table filled · Startup fill' });
        // The thread list may not be loaded at startup: the chat is loaded so the notice can name it.
        expect(h.getThread).toHaveBeenCalledWith('thread-9');
    });
});

describe('a job the user stopped', () => {
    const stopped = { ...result, result: { ...result.result, stopped_by: 'stopped' }, stopped: true };

    it('is put on the call but continues nothing', () => {
        h.subscribers.get('job-call:stored')!({ threadId: 'thread-1', toolCallId: 'call-1', kind: 'table_fill', jobId: 'job-1', userId: 'user-1', result: stopped, viewerWindowIds: ['win-1'] });
        expect(h.store.get(openJobCallsAtom)[0].result).toEqual(stopped);
        expect(h.continued).not.toHaveBeenCalled();
    });

    it('of a chat no window shows is reported nowhere', () => {
        h.store.set(currentThreadIdAtom, 'thread-2');
        h.subscribers.get('job-call:stored')!({
            threadId: 'thread-3', toolCallId: 'call-3', kind: 'table_fill', jobId: 'job-3', userId: 'user-1', result: stopped,
            viewerWindowIds: [], notifyWindowId: 'win-1',
        });
        expect(h.store.get(jobReadyNoticesAtom).some((notice: any) => notice.threadId === 'thread-3')).toBe(false);
        expect(h.messages.some((message: any) => message.id === 'job-ready-thread-3')).toBe(false);
    });

    it('stored on another device: the window showing the thread reloads it, and continues nothing', async () => {
        // Let a reload an earlier test's `job_ready` started settle first.
        h.store.set(h.entities, new Map());
        await new Promise((resolve) => setTimeout(resolve, 0));
        h.store.set(threadRunsAtom, [parkedRun(false)]);
        h.continued.mockReset();
        const stoppedRun = parkedRun(true);
        stoppedRun.parked.requests[0] = { ...stoppedRun.parked.requests[0], result: stopped } as any;
        h.getThreadRuns.mockResolvedValue({ runs: [stoppedRun] });
        h.store.set(h.entities, new Map([['thread-1', { id: 'thread-1', awaitingInput: { table_fill: 1 } }]]));
        // A stopped result counts under no key: the job count goes away.
        h.store.set(h.entities, new Map([['thread-1', { id: 'thread-1', awaitingInput: null }]]));
        await vi.waitFor(() => expect(h.store.get(openJobCallsAtom)[0].result).toEqual(stopped));
        expect(h.continued).not.toHaveBeenCalled();
    });
});

describe('closing the sidebar message', () => {
    it('closes the notice everywhere, so the popup card does not come back', () => {
        h.store.set(currentThreadIdAtom, 'thread-2');
        h.subscribers.get('job-call:stored')!({
            threadId: 'thread-3', toolCallId: 'call-3', kind: 'table_fill', jobId: 'job-3', userId: 'user-1', result,
            viewerWindowIds: [], notifyWindowId: 'win-1',
        });
        expect(h.store.get(jobReadyNoticesAtom).some((notice: any) => notice.threadId === 'thread-3')).toBe(true);
        h.store.set(h.popupMessages, [{ id: 'job-ready-thread-3' }]);
        h.store.set(h.popupMessages, []);
        expect(h.store.get(jobReadyNoticesAtom).some((notice: any) => notice.threadId === 'thread-3')).toBe(false);
    });
});

describe("the composer's Stop for a chat that waits on jobs", () => {
    const fillStop = vi.fn();
    const fill = (state: 'running' | 'stopping' | 'done', runId = 'run-1', jobId = 'job-1') => new Map([[jobId, {
        threadId: 'thread-1', toolCallId: 'call-1', dismissed: false,
        snapshot: { job_id: jobId, state, origin: { kind: 'agent', run: { thread_id: 'thread-1', run_id: runId, tool_call_id: 'call-1' } } },
    }]]) as any;

    beforeEach(() => {
        (globalThis as any).Zotero.Beaver.tableFills = { stop: fillStop };
        fillStop.mockReset();
        h.waitsOnly = false;
        h.store.set(activeRunAtom, null);
        h.store.set(chatFillsAtom, new Map());
    });

    it('lists a parked fill this device runs, and stops it', () => {
        h.store.set(chatFillsAtom, fill('running'));
        expect(h.store.get(runningChatJobsAtom)).toEqual([{ kind: 'table_fill', jobId: 'job-1', stopping: false }]);
        expect(h.store.set(stopChatJobsAtom)).toBe(true);
        expect(fillStop).toHaveBeenCalledWith('job-1');
        expect(h.store.get(runningChatJobsAtom)).toEqual([{ kind: 'table_fill', jobId: 'job-1', stopping: true }]);
    });

    it('stays busy after the stopped fill ended, until its result is on the call', () => {
        h.store.set(chatFillsAtom, fill('running'));
        h.store.set(stopChatJobsAtom);
        h.store.set(chatFillsAtom, fill('done'));
        expect(h.store.get(runningChatJobsAtom)).toEqual([{ kind: 'table_fill', jobId: 'job-1', stopping: true }]);
        h.store.set(applyStoredJobResultAtom, { threadId: 'thread-1', toolCallId: 'call-1', result: { ...result, stopped: true } as any });
        expect(h.store.get(runningChatJobsAtom)).toEqual([]);
    });

    it('does not list a parked job running on another device', () => {
        expect(h.store.get(runningChatJobsAtom)).toEqual([]);
        expect(h.store.set(stopChatJobsAtom)).toBe(false);
    });

    it('lets a live run that waits on more than its jobs be stopped as a run', () => {
        h.store.set(threadRunsAtom, []);
        h.store.set(activeRunAtom, { id: 'run-2', status: 'in_progress', model_messages: [] } as any);
        h.store.set(chatFillsAtom, fill('running', 'run-2'));
        expect(h.store.get(runningChatJobsAtom)).toHaveLength(1);
        expect(h.store.set(stopChatJobsAtom)).toBe(false);
        expect(fillStop).not.toHaveBeenCalled();
    });

    it("lists a live run's fill only while its tool call has not returned in that run", () => {
        const call = { kind: 'response', parts: [{ part_kind: 'tool-call', tool_name: 'fill_table', tool_call_id: 'call-1', args: {} }] };
        const ret = { kind: 'request', parts: [{ part_kind: 'tool-return', tool_name: 'fill_table', tool_call_id: 'call-1', content: {} }] };
        // An earlier run's call with the same id returned long ago.
        h.store.set(threadRunsAtom, [{ id: 'run-0', thread_id: 'thread-1', status: 'completed', model_messages: [call, ret] }] as any);
        h.store.set(activeRunAtom, { id: 'run-2', status: 'in_progress', model_messages: [call] } as any);
        h.store.set(chatFillsAtom, fill('running', 'run-2', 'job-ids'));
        expect(h.store.get(runningChatJobsAtom).map((job) => job.jobId)).toEqual(['job-ids']);
        h.store.set(activeRunAtom, { id: 'run-2', status: 'in_progress', model_messages: [call, ret] } as any);
        expect(h.store.get(runningChatJobsAtom)).toEqual([]);
    });

    it('notifies nobody while streamed frames and progress leave the jobs unchanged', () => {
        h.store.set(threadRunsAtom, []);
        h.store.set(activeRunAtom, { id: 'run-2', status: 'in_progress', model_messages: [] } as any);
        h.store.set(chatFillsAtom, fill('running', 'run-2', 'job-quiet'));
        let notified = 0;
        const unsubscribe = h.store.sub(runningChatJobsAtom, () => notified++);
        h.store.set(activeRunAtom, { id: 'run-2', status: 'in_progress', model_messages: [{ kind: 'response', parts: [] }] } as any);
        h.store.set(chatFillsAtom, fill('running', 'run-2', 'job-quiet'));
        expect(h.store.get(runningChatJobsAtom)).toHaveLength(1);
        expect(notified).toBe(0);
        unsubscribe();
    });

    it('stops the jobs of a live run that waits on nothing else, and leaves the run to park', () => {
        h.waitsOnly = true;
        h.store.set(threadRunsAtom, []);
        h.store.set(activeRunAtom, { id: 'run-2', status: 'in_progress', model_messages: [] } as any);
        h.store.set(chatFillsAtom, fill('running', 'run-2', 'job-live'));
        expect(h.store.set(stopChatJobsAtom)).toBe(true);
        expect(fillStop).toHaveBeenCalledWith('job-live');
        expect(h.store.get(jobStopRunIdAtom)).toBe('run-2');
    });
});
