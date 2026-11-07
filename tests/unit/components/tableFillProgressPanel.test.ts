// @vitest-environment jsdom

/**
 * The chat's fill progress panel: shown only in the thread whose run started
 * the fill, while that run lasts; the table and its actions on line one, what
 * is happening on line two; the result with its follow-ups (failed rows,
 * adding credits) until dismissed or the run ends.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider, createStore } from 'jotai';
import type { TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../../react/atoms/tableChatFills', () => ({ watchChatFills: vi.fn() }));
vi.mock('../../../src/utils/libraryIdentity', () => ({
    libraryRefForLibraryID: (id: number) => (id === 1 ? 'u' : null),
}));
const openPreferences = vi.fn();
vi.mock('../../../react/ui/openPreferencesWindow', () => ({ openPreferencesWindow: (...args: unknown[]) => openPreferences(...args) }));

import { setHost } from '@beaver/agent-ui/host';
import { activeRunAtom, currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { chatFillsAtom, recordChatFillAtom } from '@beaver/agent-core/run-state/tableChatFills';
import TableFillProgressPanel from '../../../react/components/input/TableFillProgressPanel';

function snapshot(overrides: Partial<TableFillJobSnapshot> = {}): TableFillJobSnapshot {
    return {
        job_id: 'job-1',
        plan_id: 'plan-1',
        table: { libraryID: 1, key: 'TABLE001', title: 'Trials' },
        origin: { kind: 'agent', run: { run_id: 'run-1', thread_id: 'thread-1', tool_call_id: 'call-1' } },
        state: 'running',
        rows_total: 46,
        rows_done: 12,
        rows_failed: 1,
        in_flight: 3,
        credits_charged: 2.4,
        credits_planned: 9.2,
        balance: 10,
        started_at: 1,
        seconds_left: 150,
        ...overrides,
    };
}

let root: Root | null = null;
let container: HTMLDivElement;
let store: ReturnType<typeof createStore>;
const stop = vi.fn();

/** Renders the panel in `threadId`, with `runId` as its active run (null: no run is active). */
function render(threadId: string, runId: string | null = 'run-1') {
    store.set(currentThreadIdAtom, threadId);
    store.set(activeRunAtom, runId ? ({ id: runId, status: 'in_progress', model_messages: [] } as never) : null);
    act(() => {
        root = createRoot(container);
        root.render(React.createElement(Provider, { store }, React.createElement(TableFillProgressPanel)));
    });
}

function button(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
    ) as HTMLButtonElement | undefined;
}

beforeEach(() => {
    vi.clearAllMocks();
    store = createStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    (globalThis as any).Zotero.Beaver = { tableFills: { stop } };
});

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    delete (globalThis as any).Zotero.Beaver;
});

function result(overrides: Partial<NonNullable<TableFillJobSnapshot['result']>> = {}): NonNullable<TableFillJobSnapshot['result']> {
    return {
        rows_answered: 44,
        answered: 88,
        not_reported: 0,
        from_title_abstract: 0,
        documents_read: 44,
        credits_charged: 8.8,
        row_failures: {},
        failed_row_ids: [],
        not_started: {},
        not_written: 0,
        skipped_cells: {},
        pending: null,
        ...overrides,
    };
}

function opener() {
    const opened: Array<{ key: string; options: unknown }> = [];
    setHost({
        navigation: {
            openTable: async (key: string, _origin: unknown, options: unknown) => {
                opened.push({ key, options });
                return { ok: true };
            },
        },
    } as any);
    return opened;
}

function lines(): string[] {
    return [
        container.querySelector('.table-fill-progress-head')?.textContent ?? '',
        container.querySelector('.table-fill-progress-status')?.textContent ?? '',
    ];
}

describe('the fill progress panel', () => {
    it('puts the table, an Open arrow and Stop on line one and the progress on line two', async () => {
        store.set(recordChatFillAtom, snapshot({ rows_failed: 0, seconds_left: 45 }));
        const opened = opener();
        render('thread-1');
        expect(lines()).toEqual(['TrialsStop', 'Reading 12 of 46 items']);
        expect(container.textContent).not.toContain('Filling');
        expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('12');
        await act(async () => button('Stop fill')!.click());
        expect(stop).toHaveBeenCalledWith('job-1');
        await act(async () => button('Open table')!.click());
        expect(opened).toEqual([{ key: 'u-TABLE001', options: undefined }]);
    });

    it('names failures as they happen and draws them on the rule', () => {
        store.set(recordChatFillAtom, snapshot({ rows_done: 5, rows_total: 12, rows_failed: 1, seconds_left: 30 }));
        render('thread-1');
        expect(lines()[1]).toBe('Reading 5 of 12 items · 1 failed');
        expect(container.querySelector('.table-fill-progress-status .table-fill-progress-warning')?.textContent).toBe(
            ' · 1 failed',
        );
        const failed = container.querySelector('.table-fill-progress-failed') as HTMLElement;
        expect(failed.style.width).toBe(`${(1 / 12) * 100}%`);
    });

    it('sweeps the rule and claims no time before the first row finishes', () => {
        store.set(recordChatFillAtom, snapshot({ rows_done: 0, rows_failed: 0, seconds_left: null }));
        render('thread-1');
        expect(lines()[1]).toBe('Starting to read 46 items');
        expect(container.querySelector('.batch-progress-indeterminate')).toBeTruthy();
    });

    it('shows the estimate only for a long fill', () => {
        store.set(recordChatFillAtom, snapshot({ rows_done: 8, rows_total: 40, rows_failed: 0, seconds_left: 240 }));
        render('thread-1');
        expect(lines()[1]).toBe('Reading 8 of 40 items · about 4 minutes left');
    });

    it('shows nothing in another thread', () => {
        store.set(recordChatFillAtom, snapshot());
        render('thread-2');
        expect(container.textContent).toBe('');
    });

    it('goes when the run that started the fill ends, leaving the fill to the receipt', () => {
        store.set(recordChatFillAtom, snapshot());
        render('thread-1', null);
        expect(container.textContent).toBe('');
        act(() => store.set(activeRunAtom, { id: 'run-1', status: 'in_progress', model_messages: [] } as never));
        expect(lines()[0]).toContain('Trials');
        // The run ends while the fill goes on in the background.
        act(() => store.set(activeRunAtom, { id: 'run-1', status: 'completed', model_messages: [] } as never));
        expect(container.textContent).toBe('');
        // A later run in the same thread does not bring it back.
        act(() => store.set(activeRunAtom, { id: 'run-2', status: 'in_progress', model_messages: [] } as never));
        expect(container.textContent).toBe('');
    });

    it('says it is finishing the papers in flight after a stop', () => {
        store.set(recordChatFillAtom, snapshot({ state: 'stopping', in_flight: 3, rows_failed: 0 }));
        render('thread-1');
        expect(lines()[1]).toBe('Stopping: finishing 3 items already underway');
        expect(button('Stop fill')!.disabled).toBe(true);
        expect(container.querySelector('.table-fill-progress-rule-stopping')).toBeTruthy();
    });

    it('becomes a short clean result with a tick, no rule, and dismiss in place of Stop', async () => {
        store.set(recordChatFillAtom, snapshot({ state: 'done', rows_done: 46, in_flight: 0, result: result() }));
        opener();
        render('thread-1');
        expect(lines()[1]).toBe('Filled 44 rows');
        expect(container.querySelector('[role="progressbar"]')).toBeNull();
        expect(container.querySelector('.table-fill-progress-glyph.font-color-green')).toBeTruthy();
        expect(button('Stop fill')).toBeUndefined();
        expect(button('Open table')).toBeTruthy();
        await act(async () => button('Dismiss')!.click());
        expect(container.textContent).toBe('');
        expect(store.get(chatFillsAtom).get('job-1')?.dismissed).toBe(true);
    });

    it('links a result with failed rows to those rows in the table', async () => {
        store.set(
            recordChatFillAtom,
            snapshot({
                state: 'done',
                rows_done: 46,
                in_flight: 0,
                result: result({ row_failures: { encrypted: 2 }, failed_row_ids: ['r1', 'r2'] }),
            }),
        );
        const opened = opener();
        render('thread-1');
        expect(lines()[1]).toBe('Filled 44 rowsShow 2 failed');
        expect(container.querySelector('.table-fill-progress-glyph.table-fill-progress-warning')).toBeTruthy();
        await act(async () => button('Show 2 failed')!.click());
        expect(opened).toEqual([{ key: 'u-TABLE001', options: { request: { kind: 'show_failed', job_id: 'job-1', row_ids: ['r1', 'r2'] } } }]);
    });

    it('offers to add credits after running out', async () => {
        store.set(
            recordChatFillAtom,
            snapshot({
                state: 'done',
                rows_done: 7,
                rows_total: 12,
                in_flight: 0,
                credits_charged: 1.4,
                balance: 0.1,
                result: result({ rows_answered: 7, credits_charged: 1.4, stopped_by: 'insufficient_credits' }),
            }),
        );
        render('thread-1');
        expect(lines()[1]).toBe('Out of credits after 7 of 12 items' + 'Add credits');
        await act(async () => button('Add credits')!.click());
        expect(openPreferences).toHaveBeenCalledWith('billing');
    });

    it('marks a fill the user stopped with neither a tick nor a warning', () => {
        store.set(
            recordChatFillAtom,
            snapshot({ state: 'done', rows_done: 30, in_flight: 0, result: result({ stopped_by: 'stopped', credits_charged: 6 }) }),
        );
        render('thread-1');
        expect(lines()[1]).toBe('Stopped after 30 of 46 items');
        expect(container.querySelector('.table-fill-progress-glyph.font-color-secondary')).toBeTruthy();
    });
});
