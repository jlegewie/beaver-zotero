/**
 * Leaving a chat whose response waits on a table fill: the fill goes on as
 * the table's own when the table is open, and stops otherwise, after the
 * user confirms leaving. Both happen here, before the run is stopped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { confirmMock, isShownMock, releaseMock, stopMock } = vi.hoisted(() => ({
    confirmMock: vi.fn(() => true),
    isShownMock: vi.fn(() => false),
    releaseMock: vi.fn(),
    stopMock: vi.fn(() => true),
}));

vi.mock('@beaver/agent-ui/host', () => ({ getHost: () => ({ dialogs: { confirm: confirmMock } }) }));
vi.mock('../../../src/services/artifacts/tablesApi', () => ({
    getTablesApi: () => ({ isShown: isShownMock }),
}));


import type { TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { chatFillsAtom, recordChatFill } from '@beaver/agent-core/run-state/tableChatFills';
import { store } from '../../../react/store';
import { jobWaitAtom } from '../../../react/atoms/jobWait';
import { confirmLeaveJobWaitAtom, fillLeaveStops, leaveJobWait } from '../../../react/atoms/jobLeave';
import { chatStore } from '../../helpers/runSession';

const THREAD = 'thread-1';
const TABLE = { libraryID: 1, key: 'TABLE001' };

(globalThis as any).Zotero = {
    ...(globalThis as any).Zotero,
    Beaver: {
        ...((globalThis as any).Zotero?.Beaver ?? {}),
        tableFills: { stop: stopMock, agent: { release: releaseMock } },
        data: { env: 'production' },
    },
};

function snapshot(overrides: Partial<TableFillJobSnapshot> = {}): TableFillJobSnapshot {
    return {
        job_id: 'job-1',
        plan_id: 'plan-1',
        table: { ...TABLE, title: 'Soil carbon' },
        origin: { kind: 'agent', run: { run_id: 'run-1', thread_id: THREAD, tool_call_id: 'call-1' } },
        state: 'running',
        rows_total: 300,
        rows_done: 83,
        rows_failed: 2,
        in_flight: 3,
        credits_charged: 4,
        credits_planned: 60,
        balance: null,
        started_at: 1,
        seconds_left: null,
        ...overrides,
    };
}

const window = {} as Window;

beforeEach(() => {
    vi.clearAllMocks();
    isShownMock.mockReturnValue(false);
    confirmMock.mockReturnValue(true);
    chatStore().set(currentThreadIdAtom, THREAD);
    store.set(chatFillsAtom, recordChatFill(new Map(), snapshot()));
    chatStore().set(jobWaitAtom, { threadId: THREAD, runId: 'run-1', toolCallId: 'call-1', jobId: 'job-1' });
});

describe('leaving a chat that waits on a fill', () => {
    it('hands the fill to its table without asking when the table is open', () => {
        isShownMock.mockReturnValue(true);
        expect(store.set(confirmLeaveJobWaitAtom, { leave: 'new_chat', window })).toBe(true);
        expect(confirmMock).not.toHaveBeenCalled();
        expect(fillLeaveStops(store.get)).toBeNull();
        leaveJobWait();
        expect(store.get(jobWaitAtom)).toBeNull();
        expect(releaseMock).toHaveBeenCalledWith('job-1');
        expect(stopMock).not.toHaveBeenCalled();
    });

    it('confirms leaving like any response still going, naming the fill, and stays on Cancel', () => {
        expect(fillLeaveStops(store.get)?.job_id).toBe('job-1');
        confirmMock.mockReturnValue(false);
        expect(store.set(confirmLeaveJobWaitAtom, { leave: 'new_chat', window })).toBe(false);
        expect(confirmMock).toHaveBeenCalledWith({
            title: 'Start new chat?',
            text: 'Beaver is still working in this chat. Starting a new chat will stop it, and the fill of “Soil carbon” (the answers so far stay in the table). To keep the fill going, open the table first.',
            confirmLabel: 'Start New Chat',
            window,
        });
        store.set(confirmLeaveJobWaitAtom, { leave: 'switch_chat', window });
        expect(confirmMock).toHaveBeenLastCalledWith(expect.objectContaining({
            title: 'Switch chat?',
            text: expect.stringContaining('Switching chats will stop it, and the fill of “Soil carbon”'),
            confirmLabel: 'Switch Chat',
        }));
        expect(store.get(jobWaitAtom)).not.toBeNull();
        expect(stopMock).not.toHaveBeenCalled();
    });

    it('stops the fill once the user confirms and the chat changes', () => {
        expect(store.set(confirmLeaveJobWaitAtom, { leave: 'new_chat', window })).toBe(true);
        leaveJobWait();
        expect(stopMock).toHaveBeenCalledWith('job-1');
        expect(releaseMock).not.toHaveBeenCalled();
    });

    it('asks nothing and leaves the result alone for a fill that ended or is winding down after Stop', () => {
        for (const state of ['done', 'stopping'] as const) {
            chatStore().set(jobWaitAtom, { threadId: THREAD, runId: 'run-1', toolCallId: 'call-1', jobId: 'job-1' });
            store.set(chatFillsAtom, recordChatFill(new Map(), snapshot({ state })));
            expect(store.set(confirmLeaveJobWaitAtom, { leave: 'new_chat', window })).toBe(true);
            leaveJobWait();
            expect(store.get(jobWaitAtom)).toBeNull();
        }
        expect(confirmMock).not.toHaveBeenCalled();
        expect(stopMock).not.toHaveBeenCalled();
        expect(releaseMock).not.toHaveBeenCalled();
    });
});

describe('closing the window that waits on a fill', () => {
    it("does not count the closing window's own tabs", () => {
        leaveJobWait({ closing: window });
        expect(isShownMock).toHaveBeenLastCalledWith(expect.objectContaining(TABLE), window);
        expect(stopMock).toHaveBeenCalledWith('job-1');
    });

    it('hands the fill to a table open in another window', () => {
        isShownMock.mockReturnValue(true);
        leaveJobWait({ closing: window });
        expect(releaseMock).toHaveBeenCalledWith('job-1');
        expect(stopMock).not.toHaveBeenCalled();
    });
});
