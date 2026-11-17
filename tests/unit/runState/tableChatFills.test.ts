import { describe, expect, it } from 'vitest';
import type { TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';
import {
    fillForToolCall,
    fillStatusLine,
    panelFill,
    recordChatFill,
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
        expect(panelFill(fills, 'thread-1', 'run-1')?.snapshot.job_id).toBe('new');
        expect(panelFill(fills, 'thread-2', 'run-1')?.snapshot.job_id).toBe('other');
        expect(panelFill(fills, 'thread-3', 'run-1')).toBeNull();
        expect(panelFill(fills, null, 'run-1')).toBeNull();
    });

    it('shows only the fills of the thread\'s active run', () => {
        let fills = recordChatFill(empty, snapshot({ job_id: 'earlier', run: 'run-1', started_at: 1 }));
        fills = recordChatFill(fills, snapshot({ job_id: 'current', run: 'run-2', started_at: 2, state: 'done' }));
        // The earlier run's fill still runs, but its run is over: its answer's receipt shows it.
        expect(panelFill(fills, 'thread-1', 'run-2')?.snapshot.job_id).toBe('current');
        expect(panelFill(fills, 'thread-1', 'run-1')?.snapshot.job_id).toBe('earlier');
        expect(panelFill(fills, 'thread-1', null)).toBeNull();
    });

    it('turns into the result line when the fill ends, until dismissed', () => {
        let fills = recordChatFill(empty, snapshot({ state: 'done', rows_done: 10 }));
        expect(panelFill(fills, 'thread-1', 'run-1')?.snapshot.state).toBe('done');
        fills = new Map(fills);
        fills.set('job-1', { ...fills.get('job-1')!, dismissed: true });
        expect(panelFill(fills, 'thread-1', 'run-1')).toBeNull();
        // A later snapshot of the same job keeps it dismissed.
        expect(recordChatFill(fills, snapshot({ state: 'done', rows_done: 10, credits_charged: 2 })).get('job-1')?.dismissed).toBe(true);
    });

    it('finds the fill a tool call started', () => {
        const fills = recordChatFill(empty, snapshot());
        expect(fillForToolCall(fills, 'call-1', 'run-1')?.snapshot.job_id).toBe('job-1');
        expect(fillForToolCall(fills, 'call-2', 'run-1')).toBeNull();
        // A model that reuses tool call ids: the same id in another run is another call.
        expect(fillForToolCall(fills, 'call-1', 'run-2')).toBeNull();
    });

    it('words the tool call status line without live counts', () => {
        expect(fillStatusLine('waiting', 46)).toBe('Filling 46 items…');
        expect(fillStatusLine('waiting', 1)).toBe('Filling 1 item…');
        expect(fillStatusLine('background')).toBe('Filling in the background');
        expect(fillStatusLine('started')).toBe('Started filling in the background');
    });
});
