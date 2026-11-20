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
import type { TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';
import { threadRunsAtom, type ToolResult } from '@beaver/agent-core/run-state/atoms';
import { chatFillsAtom, recordChatFill } from '@beaver/agent-core/run-state/tableChatFills';
import { TableToolCallView } from '../../../react/components/agentRuns/TableToolCallView';
import { jobWaitAtom } from '../../../react/atoms/jobWait';
import { setHost } from '@beaver/agent-ui/host';
import { ArrowUpRightIcon } from '@beaver/agent-ui/icons';
import { renderToStaticMarkup } from 'react-dom/server';

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

/** A fill stopped after 4 of 10 items, one of them failed. */
const stoppedFill = snapshot({ state: 'done', rows_done: 4, result: { rows_answered: 3, answered: 6, not_reported: 0, from_title_abstract: 0, documents_read: 4, credits_charged: 1, row_failures: { unreadable: 1 }, failed_row_ids: [], not_started: { stopped: 6 }, not_written: 0, skipped_cells: {}, pending: null, stopped_by: 'stopped' } });

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
                state: { job_id: 'job-1', title: 'Trials' },
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

    it('keeps counting once the run parked on the fill this window waits on', () => {
        const store = createStore();
        store.set(threadRunsAtom, [parkedRun()]);
        store.set(jobWaitAtom, { threadId: 'thread-1', runId: 'run-1', toolCallId: 'call-1', jobId: 'job-1' });
        store.set(chatFillsAtom, recordChatFill(new Map(), snapshot()));
        const view = render(store, 'parked');
        expect(line(view)).toBe('Fill Table: 3 of 10 items complete (1 failed)');
        expect(view.querySelector('.shimmer-text')).not.toBeNull();
    });

    it('keeps counting when a resume parked on the fill before it wrote anything', () => {
        // The call sits in the run that parked on its card; the resume that ran
        // it parked on the fill with no transcript of its own.
        const store = createStore();
        const first = { ...parkedRun(), parked: null, status: 'completed' } as unknown as AgentRun;
        const resume = { ...parkedRun(), id: 'run-2', model_messages: [] } as unknown as AgentRun;
        store.set(threadRunsAtom, [first, resume]);
        store.set(jobWaitAtom, { threadId: 'thread-1', runId: 'run-2', toolCallId: 'call-1', jobId: 'job-1' });
        store.set(chatFillsAtom, recordChatFill(new Map(), snapshot()));
        expect(line(render(store, 'completed'))).toBe('Fill Table: 3 of 10 items complete (1 failed)');
    });

    it('shows the title once the answer ended while the fill still runs: stopped, or left to its table', () => {
        // Parked, but this window no longer waits on the call.
        const parked = createStore();
        parked.set(threadRunsAtom, [parkedRun()]);
        parked.set(chatFillsAtom, recordChatFill(new Map(), snapshot()));
        const view = render(parked, 'parked');
        expect(line(view)).toBe('Fill Table Trials');
        expect(view.querySelector('.shimmer-text')).toBeNull();
        act(() => root?.unmount());
        // Stopped live: the fill winds down after the run ended.
        const stopped = createStore();
        stopped.set(chatFillsAtom, recordChatFill(new Map(), snapshot({ state: 'stopping' })));
        expect(line(render(stopped, 'canceled'))).toBe('Fill Table Trials');
        act(() => root?.unmount());
        // A fill this device does not follow.
        const elsewhere = createStore();
        elsewhere.set(threadRunsAtom, [parkedRun()]);
        expect(line(render(elsewhere, 'parked'))).toBe('Fill Table Trials');
    });

    it('shows how a fill ended once it ends after the answer did', () => {
        const store = createStore();
        store.set(chatFillsAtom, recordChatFill(new Map(), stoppedFill));
        expect(line(render(store, 'canceled'))).toBe('Fill Table: 4 of 10 items complete (stopped, 1 failed)');
    });

    it('reads a call a message closed while the fill ran from the fill this device runs, else by its title', () => {
        // The closing text carries the table but no fill: the fill's end is unknown.
        const record = {
            reference: { kind: 'table', key: 'u-TABLE001', title: 'Trials' },
            change: 'Filled table',
            summary: { rows: 10 },
            run: 'fill',
            fill: null,
        };
        const returned = { part_kind: 'tool-return', tool_name: 'fill_table', tool_call_id: 'call-1', content: {}, metadata: { view: { view_type: 'table', record } } } as unknown as ToolResult;
        const here = createStore();
        here.set(chatFillsAtom, recordChatFill(new Map(), stoppedFill));
        expect(line(render(here, 'completed', returned))).toBe('Fill Table: 4 of 10 items complete (stopped, 1 failed)');
        act(() => root?.unmount());
        expect(line(render(createStore(), 'completed', returned))).toBe('Fill Table Trials');
    });
});

describe('a fill tool call that has not returned', () => {
    it('shows the open icon on hover while the fill runs, opens its table on a click, and expands nothing', () => {
        const openTable = vi.fn(async () => ({ ok: true as const }));
        setHost({ navigation: { openTable } as any });
        const store = createStore();
        store.set(threadRunsAtom, [parkedRun({ state: { job_id: 'job-1', title: 'Trials', table: 'u-TABLE001' } } as Partial<ParkedDeferral>)]);
        store.set(jobWaitAtom, { threadId: 'thread-1', runId: 'run-1', toolCallId: 'call-1', jobId: 'job-1' });
        store.set(chatFillsAtom, recordChatFill(new Map(), snapshot()));
        const view = render(store, 'parked');
        const button = view.querySelector('button[title="Open table"]') as HTMLElement;
        act(() => button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
        const openIcon = renderToStaticMarkup(React.createElement(ArrowUpRightIcon)).match(/<path d="([^"]+)"/)![1];
        expect(button.innerHTML).toContain(openIcon);
        act(() => button.click());
        expect(openTable).toHaveBeenCalledWith('u-TABLE001', expect.anything());
        expect(view.querySelector('#tool-result-call-1')).toBeNull();
        setHost({});
    });
});
