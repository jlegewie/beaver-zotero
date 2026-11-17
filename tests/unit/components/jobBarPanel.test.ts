// @vitest-environment jsdom

/**
 * The composer's job bar adapter: the fill the active run waits on, and the
 * parked run's job calls — running here, running on another device, or
 * finished with Continue.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider, atom, createStore } from 'jotai';
import type { TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';
import type { JobView } from '@beaver/agent-ui/chat/JobBar';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const continued = vi.fn();
vi.mock('../../../react/atoms/tableChatFills', () => ({ watchChatFills: vi.fn() }));
const { pdfJobsAtom } = vi.hoisted(() => ({ pdfJobsAtom: { current: null as any } }));
vi.mock('../../../react/atoms/jobCalls', async () => {
    const { atom } = await import('jotai');
    pdfJobsAtom.current = atom(new Map());
    return { watchJobCalls: vi.fn(), chatPdfJobsAtom: pdfJobsAtom.current };
});
vi.mock('../../../react/atoms/agentRunAtoms', () => ({
    continueParkedJobsAtom: atom(null, () => continued()),
}));
vi.mock('../../../src/utils/libraryIdentity', () => ({
    libraryRefForLibraryID: (id: number) => (id === 1 ? 'u' : null),
}));
vi.mock('../../../src/utils/zoteroInstanceIdentity', () => ({
    getZoteroUserIdentifier: () => ({ localUserKey: 'here' }),
}));
vi.mock('../../../react/ui/openPreferencesWindow', () => ({ openPreferencesWindow: vi.fn() }));

import { activeRunAtom, currentThreadIdAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { recordChatFillAtom } from '@beaver/agent-core/run-state/tableChatFills';
import { useJobViews } from '../../../react/components/input/JobBarPanel';

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

function parked(state: Record<string, unknown>, result?: unknown) {
    return {
        id: 'run-1',
        thread_id: 'thread-1',
        status: 'completed',
        model_messages: [{ kind: 'response', parts: [{ part_kind: 'tool-call', tool_name: 'fill_table', tool_call_id: 'call-1', args: {} }] }],
        parked: {
            version: 1,
            parked_at: '2026-11-15T12:00:00Z',
            reason: 'timeout',
            requests: [{
                kind: 'table_fill',
                tool_call_id: 'call-1',
                tool_name: 'fill_table',
                correlation_id: 'job-1',
                request: { type: 'background_job', kind: 'table_fill', job_id: 'job-1' },
                state: { job_id: 'job-1', table: 'u-TABLE001', title: 'Trials', ...state },
                ...(result ? { result } : {}),
            }],
        },
        user_prompt: { content: 'Fill it' },
    };
}

const doneResult = {
    kind: 'table_fill',
    job_id: 'job-1',
    status: 'done',
    progress: { state: 'done', rows_total: 46, rows_done: 46, rows_failed: 0, in_flight: 0, credits_charged: 9.2, credits_planned: 9.2, seconds_left: null },
    result: {
        rows_answered: 46, answered: 92, not_reported: 0, from_title_abstract: 0, documents_read: 46, credits_charged: 9.2,
        row_failures: {}, failed_row_ids: [], not_started: {}, not_written: 0, skipped_cells: {}, pending: null,
    },
};

let root: Root | null = null;
let container: HTMLDivElement;
let store: ReturnType<typeof createStore>;
let views: JobView[] = [];
const stop = vi.fn();

function Probe() {
    views = useJobViews();
    return null;
}

function render() {
    act(() => {
        root = createRoot(container);
        root.render(React.createElement(Provider, { store }, React.createElement(Probe)));
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    store = createStore();
    store.set(currentThreadIdAtom, 'thread-1');
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

describe('the job bar adapter', () => {
    it('shows the fill the active run waits on, with progress and Stop', () => {
        store.set(activeRunAtom, { id: 'run-1', status: 'in_progress', model_messages: [] } as never);
        store.set(recordChatFillAtom, snapshot());
        render();
        expect(views).toHaveLength(1);
        expect(views[0]).toMatchObject({
            kind: 'table_fill',
            verb: 'Filling table',
            subject: 'Trials',
            state: 'running',
            progress: { done: 11, failed: 1, total: 46 },
            status: 'Reading 11 of 46 items · about 3 minutes left',
            statusWarning: '1 failed',
        });
        act(() => views[0].actions.find((action) => action.id === 'stop')!.onClick());
        expect(stop).toHaveBeenCalledWith('job-1');
    });

    it('shows a parked fill this device runs from its live snapshot', () => {
        store.set(threadRunsAtom, [parked({ device_key: 'here' })] as never);
        store.set(recordChatFillAtom, snapshot());
        render();
        expect(views).toHaveLength(1);
        expect(views[0]).toMatchObject({ id: 'call-1', state: 'running', verb: 'Filling table' });
    });

    it('shows a parked fill on another device as running there', () => {
        store.set(threadRunsAtom, [parked({ device_key: 'elsewhere', device_name: 'Home-Mac' })] as never);
        render();
        expect(views[0]).toMatchObject({ state: 'elsewhere', status: 'Running on Home-Mac', actions: [] });
    });

    it('offers Continue once the result is stored', () => {
        store.set(threadRunsAtom, [parked({ device_key: 'elsewhere' }, doneResult)] as never);
        render();
        expect(views[0]).toMatchObject({ state: 'ready', verb: 'Table filled', tone: 'clean', status: 'Filled 46 items' });
        const action = views[0].actions[0];
        expect(action).toMatchObject({ id: 'continue', primary: true, disabled: false });
        act(() => action.onClick());
        expect(continued).toHaveBeenCalled();
    });

    it('shows nothing when the thread waits on no job', () => {
        render();
        expect(views).toEqual([]);
    });
});

describe('the job bar adapter for PDFs', () => {
    const pdfStop = vi.fn();
    const job = (overrides: Record<string, unknown> = {}) => ({
        job_id: 'pdf-1', thread_id: 'thread-1', tool_call_id: 'call-9', run_id: 'run-1',
        total: 4, found: 1, failed: 1, ended: false, ...overrides,
    });

    beforeEach(() => {
        (globalThis as any).Zotero.Beaver = { tableFills: { stop }, pdfJobs: { stop: pdfStop } };
    });

    it('shows the PDFs the active run waits on, with progress and Stop', () => {
        store.set(activeRunAtom, { id: 'run-1', status: 'in_progress', model_messages: [] } as never);
        store.set(pdfJobsAtom.current, new Map([['pdf-1', job()]]));
        render();
        expect(views).toHaveLength(1);
        expect(views[0]).toMatchObject({
            kind: 'pdf_retrieval',
            verb: 'Fetching PDFs',
            state: 'running',
            progress: { done: 1, failed: 1, total: 4 },
            status: 'Fetching 1 of 4 PDFs',
            statusWarning: '1 not found',
        });
        act(() => views[0].actions.find((action) => action.id === 'stop')!.onClick());
        expect(pdfStop).toHaveBeenCalledWith('pdf-1');
    });

    it('follows a parked retrieval this device runs, and offers Stop', () => {
        store.set(threadRunsAtom, [{
            ...parked({}),
            parked: {
                version: 1, parked_at: '2026-11-15T12:00:00Z', reason: 'timeout',
                requests: [{
                    kind: 'pdf_retrieval', tool_call_id: 'call-1', tool_name: 'create_items', correlation_id: 'pdf-1',
                    request: { type: 'background_job', kind: 'pdf_retrieval', job_id: 'pdf-1' },
                    state: { job_id: 'pdf-1', device_key: 'here', items: [{}, {}, {}, {}] },
                }],
            },
        }] as never);
        store.set(pdfJobsAtom.current, new Map([['pdf-1', job({ run_id: 'run-0' })]]));
        render();
        expect(views).toHaveLength(1);
        expect(views[0]).toMatchObject({ id: 'call-1', state: 'running', verb: 'Fetching PDFs' });
        expect(views[0].actions.map((action) => action.id)).toEqual(['stop']);
    });
});

describe('how a stopped fill reads', () => {
    it('says how far it got, counting filled items, and offers Continue', () => {
        const stopped = {
            ...doneResult,
            progress: { ...doneResult.progress, rows_done: 7, rows_failed: 1 },
            result: { ...doneResult.result, rows_answered: 6, failed_row_ids: ['r9'], stopped_by: 'stopped', not_started: { stopped: 39 } },
        };
        store.set(threadRunsAtom, [parked({ device_key: 'here' }, stopped)] as never);
        render();
        expect(views[0]).toMatchObject({ verb: 'Fill stopped', status: 'Stopped after 6 of 46 items', tone: 'warning' });
        expect(views[0].links.map((link) => link.label)).toEqual(['Show 1 failed']);
        expect(views[0].actions.map((action) => action.id)).toEqual(['continue']);
    });
});
