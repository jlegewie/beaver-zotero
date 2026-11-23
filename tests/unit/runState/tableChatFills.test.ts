import { describe, expect, it } from 'vitest';
import type { TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';
import { fillForToolCall, recordChatFill, type ChatFill } from '@beaver/agent-core/run-state/tableChatFills';

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
        expect(fills.get('job-1')).toMatchObject({ threadId: 'thread-1', toolCallId: 'call-1' });
        expect(recordChatFill(empty, { ...snapshot(), origin: { kind: 'user' } })).toBe(empty);
    });

    it('keeps the latest state of a job and drops a snapshot older than the one held', () => {
        let fills = recordChatFill(empty, snapshot({ rows_done: 4 }));
        expect(recordChatFill(fills, snapshot({ rows_done: 2 }))).toBe(fills);
        fills = recordChatFill(fills, snapshot({ state: 'done', rows_done: 10 }));
        expect(recordChatFill(fills, snapshot({ state: 'running', rows_done: 10 }))).toBe(fills);
        expect(fills.get('job-1')?.snapshot.state).toBe('done');
    });

    it('finds the fill a tool call started', () => {
        const fills = recordChatFill(empty, snapshot());
        expect(fillForToolCall(fills, 'call-1', 'run-1')?.snapshot.job_id).toBe('job-1');
        expect(fillForToolCall(fills, 'call-2', 'run-1')).toBeNull();
        // A model that reuses tool call ids: the same id in another run is another call.
        expect(fillForToolCall(fills, 'call-1', 'run-2')).toBeNull();
    });
});
