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
}));

vi.mock('../../../react/store', async () => {
    const { createStore } = await import('jotai');
    h.store = createStore();
    return { store: h.store };
});
vi.mock('../../../react/atoms/agentRunAtoms', () => ({ continueParkedJobsAtom: atom(null, () => h.continued()) }));
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

import { currentThreadIdAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { openJobCallsAtom } from '@beaver/agent-core/run-state/jobCalls';
import { jobReadyNoticesAtom, openJobReadyChatAtom, watchJobCalls } from '../../../react/atoms/jobCalls';
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
    it('is put on the call but waits for the user to continue', () => {
        const stopped = { ...result, result: { ...result.result, stopped_by: 'stopped' } };
        h.subscribers.get('job-call:stored')!({ threadId: 'thread-1', toolCallId: 'call-1', kind: 'table_fill', jobId: 'job-1', userId: 'user-1', result: stopped, viewerWindowIds: ['win-1'] });
        expect(h.store.get(openJobCallsAtom)[0].result).toEqual(stopped);
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
