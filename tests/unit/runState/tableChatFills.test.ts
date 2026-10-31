import { describe, expect, it } from 'vitest';
import { createStore } from 'jotai';
import type { AgentRun, ModelMessage } from '@beaver/agent-core/agents/types';
import type { TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';
import { activeRunAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import {
    chatFillsAtom,
    waitsOnFillAtom,
    fillForToolCall,
    fillStatusLine,
    panelFill,
    recordChatFill,
    waitingFill,
    type ChatFill,
} from '@beaver/agent-core/run-state/tableChatFills';

function snapshot(overrides: Partial<TableFillJobSnapshot> & { thread?: string; call?: string; run?: string } = {}): TableFillJobSnapshot {
    const { thread = 'thread-1', call = 'call-1', run = 'run-1', ...rest } = overrides;
    return {
        job_id: 'job-1',
        plan_id: 'plan-1',
        table: { libraryID: 1, key: 'TABLE001', title: 'Trials' },
        origin: { kind: 'agent', run: { run_id: run, thread_id: thread, tool_call_id: call } },
        state: 'running',
        rows_total: 10,
        rows_done: 0,
        rows_failed: 0,
        in_flight: 3,
        credits_charged: 0,
        credits_planned: 2,
        balance: 10,
        started_at: 1,
        seconds_left: null,
        ...rest,
    };
}

const empty = new Map<string, ChatFill>();

describe('chat fills', () => {
    it('records fills a chat run started, by job, and ignores fills started in the tab', () => {
        const fills = recordChatFill(empty, snapshot());
        expect(fills.get('job-1')).toMatchObject({ threadId: 'thread-1', toolCallId: 'call-1', dismissed: false });
        expect(recordChatFill(empty, { ...snapshot(), origin: { kind: 'user' } })).toBe(empty);
    });

    it('keeps the latest state of a job and drops a snapshot older than the one held', () => {
        let fills = recordChatFill(empty, snapshot({ rows_done: 4 }));
        expect(recordChatFill(fills, snapshot({ rows_done: 2 }))).toBe(fills);
        fills = recordChatFill(fills, snapshot({ state: 'done', rows_done: 10 }));
        expect(recordChatFill(fills, snapshot({ state: 'running', rows_done: 10 }))).toBe(fills);
        expect(fills.get('job-1')?.snapshot.state).toBe('done');
    });

    it('shows the panel only in the thread that started the fill, a running fill first', () => {
        let fills = recordChatFill(empty, snapshot({ job_id: 'old', state: 'done', started_at: 1 }));
        fills = recordChatFill(fills, snapshot({ job_id: 'new', started_at: 2 }));
        fills = recordChatFill(fills, snapshot({ job_id: 'other', thread: 'thread-2', started_at: 3 }));
        expect(panelFill(fills, 'thread-1')?.snapshot.job_id).toBe('new');
        expect(panelFill(fills, 'thread-2')?.snapshot.job_id).toBe('other');
        expect(panelFill(fills, 'thread-3')).toBeNull();
        expect(panelFill(fills, null)).toBeNull();
    });

    it('turns into the result line when the fill ends, until dismissed', () => {
        let fills = recordChatFill(empty, snapshot({ state: 'done', rows_done: 10 }));
        expect(panelFill(fills, 'thread-1')?.snapshot.state).toBe('done');
        fills = new Map(fills);
        fills.set('job-1', { ...fills.get('job-1')!, dismissed: true });
        expect(panelFill(fills, 'thread-1')).toBeNull();
        // A later snapshot of the same job keeps it dismissed.
        expect(recordChatFill(fills, snapshot({ state: 'done', rows_done: 10, credits_charged: 2 })).get('job-1')?.dismissed).toBe(true);
    });

    it('finds the fill a tool call started, and the one the active run still waits on', () => {
        const fills = recordChatFill(empty, snapshot());
        expect(fillForToolCall(fills, 'call-1', 'run-1')?.snapshot.job_id).toBe('job-1');
        expect(fillForToolCall(fills, 'call-2', 'run-1')).toBeNull();
        // A model that reuses tool call ids: the same id in another run is another call.
        expect(fillForToolCall(fills, 'call-1', 'run-2')).toBeNull();
        expect(waitingFill(fills, 'run-1', () => false)?.toolCallId).toBe('call-1');
        // Its tool call returned (`running`): the response no longer waits on it.
        expect(waitingFill(fills, 'run-1', () => true)).toBeNull();
        expect(waitingFill(fills, 'run-2', () => false)).toBeNull();
        const done = recordChatFill(fills, snapshot({ state: 'done', rows_done: 10 }));
        expect(waitingFill(done, 'run-1', () => false)).toBeNull();
    });

    it('words the tool call status line without live counts', () => {
        expect(fillStatusLine('waiting', 46)).toBe('Filling 46 papers…');
        expect(fillStatusLine('waiting', 1)).toBe('Filling 1 paper…');
        expect(fillStatusLine('background')).toBe('Filling in the background');
        expect(fillStatusLine('started')).toBe('Started filling in the background');
    });
});

describe('whether the active run waits on a fill', () => {
    const call = (id: string) =>
        ({ kind: 'response', run_id: 'r', parts: [{ part_kind: 'tool-call', tool_name: 'fill_table', tool_call_id: id, args: {} }] }) as unknown as ModelMessage;
    const ret = (id: string) =>
        ({ kind: 'request', run_id: 'r', instructions: '', parts: [{ part_kind: 'tool-return', tool_name: 'fill_table', tool_call_id: id, content: {} }] }) as unknown as ModelMessage;
    const text = (content: string) =>
        ({ kind: 'response', run_id: 'r', parts: [{ part_kind: 'text', content }] }) as unknown as ModelMessage;
    const run = (id: string, messages: ModelMessage[], status = 'in_progress') =>
        ({ id, thread_id: 'thread-1', status, model_messages: messages, user_prompt: { content: 'q', is_resume: false } }) as unknown as AgentRun;

    it('counts only the active run\'s own results, when an earlier run reused the tool call id', () => {
        const store = createStore();
        // An earlier run's call with the same id returned long ago.
        store.set(threadRunsAtom, [run('run-0', [call('call-1'), ret('call-1')], 'completed')]);
        store.set(activeRunAtom, run('run-1', [call('call-1')]));
        store.set(chatFillsAtom, recordChatFill(empty, snapshot()));
        expect(store.get(waitsOnFillAtom)).toBe(true);
        store.set(activeRunAtom, run('run-1', [call('call-1'), ret('call-1')]));
        expect(store.get(waitsOnFillAtom)).toBe(false);
    });

    it('notifies nobody while streamed frames leave the answer unchanged', () => {
        const store = createStore();
        store.set(activeRunAtom, run('run-1', [call('call-1')]));
        store.set(chatFillsAtom, recordChatFill(empty, snapshot()));
        let notified = 0;
        store.sub(waitsOnFillAtom, () => notified++);
        store.set(activeRunAtom, run('run-1', [call('call-1'), text('Filling')]));
        store.set(activeRunAtom, run('run-1', [call('call-1'), text('Filling the table')]));
        expect(store.get(waitsOnFillAtom)).toBe(true);
        expect(notified).toBe(0);
    });
});

