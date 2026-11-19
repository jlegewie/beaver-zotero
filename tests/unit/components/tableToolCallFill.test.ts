// @vitest-environment jsdom
/**
 * The line of a table tool call: the tool's name, then the table's title or
 * the fill's status, live or parked alike; and what a click does before the
 * call returns: it opens the table.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, AgentRunStatus, ParkedDeferral, ToolCallPart } from '@beaver/agent-core/agents/types';
import type { JobResult } from '@beaver/agent-core/protocol/jobCallProtocol';
import type { TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';
import { threadRunsAtom, type ToolResult } from '@beaver/agent-core/run-state/atoms';
import { chatFillsAtom, recordChatFill } from '@beaver/agent-core/run-state/tableChatFills';
import { TableToolCallView } from '../../../react/components/agentRuns/TableToolCallView';
import { setHost } from '@beaver/agent-ui/host';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
});

const part: ToolCallPart = { part_kind: 'tool-call', tool_name: 'fill_table', tool_call_id: 'call-1', args: { title: 'Trials' } } as ToolCallPart;

function snapshot(overrides: Partial<TableFillJobSnapshot> = {}): TableFillJobSnapshot {
    return {
        job_id: 'job-1',
        plan_id: 'plan-1',
        table: { libraryID: 1, key: 'TABLE001', title: 'Trials' },
        origin: { kind: 'agent', run: { run_id: 'run-1', thread_id: 'thread-1', tool_call_id: 'call-1' } },
        state: 'running',
        rows_total: 10,
        rows_done: 3,
        rows_failed: 1,
        in_flight: 2,
        credits_charged: 0.4,
        credits_planned: 2,
        balance: null,
        started_at: 1,
        seconds_left: null,
        ...overrides,
    };
}

const done: JobResult = {
    kind: 'table_fill',
    job_id: 'job-1',
    status: 'done',
    progress: { state: 'done', rows_total: 10, rows_done: 10, rows_failed: 0, in_flight: 0, credits_charged: 2, credits_planned: 2, seconds_left: null },
    result: {
        rows_answered: 10, answered: 20, not_reported: 0, from_title_abstract: 0, documents_read: 10, credits_charged: 2,
        row_failures: {}, failed_row_ids: [], not_started: {}, not_written: 0, skipped_cells: {}, pending: null,
    },
};

function parkedRun(deferral: Partial<ParkedDeferral> = {}): AgentRun {
    return {
        id: 'run-1',
        thread_id: 'thread-1',
        status: 'completed',
        model_messages: [{ kind: 'response', parts: [part] }],
        parked: {
            version: 1,
            parked_at: '2026-11-18T12:00:00Z',
            reason: 'timeout',
            requests: [{
                kind: 'table_fill',
                tool_call_id: 'call-1',
                tool_name: 'fill_table',
                correlation_id: 'job-1',
                request: { type: 'background_job', kind: 'table_fill', job_id: 'job-1' },
                state: { job_id: 'job-1', title: 'Trials', device_name: 'Office iMac' },
                ...deferral,
            } as ParkedDeferral],
        },
        user_prompt: { content: 'Fill it' },
    } as unknown as AgentRun;
}

function render(
    store: ReturnType<typeof createStore>,
    runStatus: AgentRunStatus,
    result?: ToolResult,
    call: ToolCallPart = part,
): HTMLDivElement {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(React.createElement(Provider, { store },
        React.createElement(TableToolCallView, { part: call, result, runId: 'run-1', responseIndex: 0, runStatus }))));
    return container;
}

/** The call's line as it reads: the tool's name, then the title or the status. */
function line(view: HTMLDivElement): string {
    return Array.from(view.querySelector('.truncate')!.children).map((span) => span.textContent ?? '').join(' ');
}

describe('a table tool call line', () => {
    it('names the tool in bold and the table after it while the call runs without a fill', () => {
        const store = createStore();
        const create = { ...part, tool_name: 'create_table' } as ToolCallPart;
        const view = render(store, 'in_progress', undefined, create);
        expect(line(view)).toBe('Create Table Trials');
        expect(view.querySelector('.truncate')!.children[0].className).toContain('font-medium');
    });

    it('counts complete items, failed ones included, while the run waits on the fill live', () => {
        const store = createStore();
        store.set(chatFillsAtom, recordChatFill(new Map(), snapshot()));
        expect(line(render(store, 'in_progress'))).toBe('Fill Table: 3 of 10 items complete (1 failed)');
    });

    it('keeps counting once the run parked on the fill', () => {
        const store = createStore();
        store.set(threadRunsAtom, [parkedRun()]);
        store.set(chatFillsAtom, recordChatFill(new Map(), snapshot()));
        expect(line(render(store, 'parked'))).toBe('Fill Table: 3 of 10 items complete (1 failed)');
    });

    it('names the device for a fill another device runs', () => {
        const store = createStore();
        store.set(threadRunsAtom, [parkedRun()]);
        expect(line(render(store, 'parked'))).toBe('Fill Table: running on Office iMac');
    });

    it('shows the title for a stored result that completed every item', () => {
        const store = createStore();
        store.set(threadRunsAtom, [parkedRun({ result: done } as Partial<ParkedDeferral>)]);
        expect(line(render(store, 'parked'))).toBe('Fill Table Trials');
    });

    it('reads a stopped result stored on the parked call', () => {
        const store = createStore();
        const stopped: JobResult = {
            ...done,
            stopped: true,
            progress: { ...done.progress, rows_done: 4, rows_failed: 1 },
            result: { ...done.result, rows_answered: 3, row_failures: { unreadable: 1 }, stopped_by: 'stopped', not_started: { stopped: 6 } },
        };
        store.set(threadRunsAtom, [parkedRun({ result: stopped } as Partial<ParkedDeferral>)]);
        expect(line(render(store, 'parked'))).toBe('Fill Table: 4 of 10 items complete (stopped, 1 failed)');
    });

    it('reads a fill handed to its table as of the hand-off, stored or returned, though it runs on here', () => {
        const store = createStore();
        const handedOff: JobResult = { kind: 'table_fill', job_id: 'job-1', status: 'handed_off', progress: { ...done.progress, state: 'running', rows_done: 2, rows_failed: 0 } };
        store.set(threadRunsAtom, [parkedRun({ result: handedOff } as Partial<ParkedDeferral>)]);
        store.set(chatFillsAtom, recordChatFill(new Map(), snapshot()));
        expect(line(render(store, 'parked'))).toBe('Fill Table: 2 of 10 items complete (continued in the table)');
        act(() => root?.unmount());
        // The next message closed the call: its record says the same.
        const record = {
            reference: { kind: 'table', key: 'u-TABLE001', title: 'Trials' },
            change: 'Filled table',
            summary: { rows: 10 },
            run: 'fill',
            fill: { status: 'running', handed_off: true, rows: 10, rows_filled: 2, rows_failed: 0, rows_not_started: {}, rows_without_input: 0, rows_not_written: 0, answered: 2, not_reported: 0, from_title_abstract: 0, skipped: {}, documents_read: 0, credits_charged: 0 },
        };
        const returned = { part_kind: 'tool-return', tool_name: 'fill_table', tool_call_id: 'call-1', content: {}, metadata: { view: { view_type: 'table', record } } } as unknown as ToolResult;
        const closed = createStore();
        closed.set(chatFillsAtom, recordChatFill(new Map(), snapshot()));
        expect(line(render(closed, 'completed', returned))).toBe('Fill Table: 2 of 10 items complete (continued in the table)');
    });
});

describe('a fill tool call that has not returned', () => {
    it('opens its table on a click, and expands nothing', () => {
        const openTable = vi.fn(async () => ({ ok: true as const }));
        setHost({ navigation: { openTable } as any });
        const store = createStore();
        store.set(threadRunsAtom, [parkedRun({ state: { job_id: 'job-1', title: 'Trials', table: 'u-TABLE001' } } as Partial<ParkedDeferral>)]);
        store.set(chatFillsAtom, recordChatFill(new Map(), snapshot()));
        const view = render(store, 'parked');
        act(() => (view.querySelector('button[title="Open table"]') as HTMLElement).click());
        expect(openTable).toHaveBeenCalledWith('u-TABLE001', expect.anything());
        expect(view.querySelector('#tool-result-call-1')).toBeNull();
        setHost({});
    });
});
