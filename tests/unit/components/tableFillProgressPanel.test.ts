// @vitest-environment jsdom

/**
 * The chat's fill progress panel: shown only in the thread whose run started
 * the fill, Stop fill and Open table while it runs, "Stopping… finishing N
 * papers" after a stop, and the result line until dismissed.
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

import { setHost } from '@beaver/agent-ui/host';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
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

function render(threadId: string) {
    store.set(currentThreadIdAtom, threadId);
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

describe('the fill progress panel', () => {
    it('follows a running fill in its own thread, with Stop fill and Open table', async () => {
        store.set(recordChatFillAtom, snapshot());
        const opened: string[] = [];
        setHost({ navigation: { openTable: async (key: string) => { opened.push(key); return { ok: true }; } } } as any);
        render('thread-1');
        expect(container.textContent).toContain('Filling Trials');
        expect(container.textContent).toContain('12 of 46 papers');
        expect(container.textContent).toContain('1 failed');
        expect(container.textContent).toContain('About 3 minutes left');
        await act(async () => button('Stop fill')!.click());
        expect(stop).toHaveBeenCalledWith('job-1');
        await act(async () => button('Open table')!.click());
        expect(opened).toEqual(['u-TABLE001']);
    });

    it('shows nothing in another thread', () => {
        store.set(recordChatFillAtom, snapshot());
        render('thread-2');
        expect(container.textContent).toBe('');
    });

    it('says it is finishing the papers in flight after a stop', () => {
        store.set(recordChatFillAtom, snapshot({ state: 'stopping', in_flight: 3 }));
        render('thread-1');
        expect(container.textContent).toContain('Stopping… finishing 3 papers');
        expect(button('Stop fill')!.disabled).toBe(true);
    });

    it('becomes the result line when the fill ends, until dismissed', async () => {
        store.set(
            recordChatFillAtom,
            snapshot({
                state: 'done',
                rows_done: 46,
                in_flight: 0,
                result: {
                    rows_answered: 44,
                    answered: 88,
                    not_reported: 0,
                    from_title_abstract: 0,
                    documents_read: 44,
                    credits_charged: 8.8,
                    row_failures: { encrypted: 2 },
                    failed_row_ids: ['r1', 'r2'],
                    not_started: {},
                    not_written: 0,
                    skipped_cells: {},
                    pending: null,
                },
            }),
        );
        render('thread-1');
        expect(container.textContent).toContain("Filled 44 rows · 2 couldn't be read · 8.8 credits");
        expect(button('Stop fill')).toBeUndefined();
        expect(button('Open table')).toBeTruthy();
        await act(async () => button('Dismiss')!.click());
        expect(container.textContent).toBe('');
        expect(store.get(chatFillsAtom).get('job-1')?.dismissed).toBe(true);
    });
});
