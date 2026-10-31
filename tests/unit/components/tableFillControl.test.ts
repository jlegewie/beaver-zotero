// @vitest-environment jsdom

/**
 * The tab's Fill control: the button's count and its idle state, the popover
 * showing a plan with its cost and starting exactly that plan, the Stop
 * button while a job runs, and the result banner.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Row, TableSpec } from '@beaver/agent-core/layouts/table';
import type { TableFillJobSnapshot, TableFillPlanSummary } from '@beaver/agent-core/protocol/tableFillProtocol';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../../react/runtime/windowRuntime', () => ({ getWindowRuntime: () => ({}) }));

import { TableFillBanner, TableFillButton } from '../../../react/components/tables/TableFillControl';

const ref = { libraryID: 1, key: 'TABLE001' };

const row = (id: string, cells: Row['cells'] = {}, extra: Partial<Row> = {}): Row => ({ id, cells, ...extra });
const answered = { outcome: 'answered', provenance: 'model', value: { kind: 'text', text: 'x' }, documents: ['u-A'] } as const;

function spec(rows: Row[]): TableSpec {
    return { id: 't', title: 'Trials', columns: [{ id: 'method', header: 'Method', type: 'text' }], rows };
}

const plan: TableFillPlanSummary = {
    plan_id: 'plan-1',
    table: { ...ref, title: 'Trials' },
    scope: { kind: 'pending' },
    rows: 2,
    cells: 2,
    documents: 2,
    document_kinds: { pdf: 2 },
    title_abstract: 0,
    no_input: 0,
    unavailable: 0,
    credits: 0.4,
    prices: { document: 0.2, title_abstract: 0.05 },
    pending: { rows: 2, cells: 2, new_rows: 2, columns: [], retry_rows: 0, blocked_rows: 0 },
    balance: 0.2,
    expires_at: Date.now() + 60_000,
};

const running: TableFillJobSnapshot = {
    job_id: 'job-1',
    plan_id: 'plan-1',
    table: { ...ref, title: 'Trials' },
    origin: { kind: 'user' },
    state: 'running',
    rows_total: 46,
    rows_done: 12,
    rows_failed: 0,
    in_flight: 3,
    credits_charged: 2.4,
    credits_planned: 9.2,
    balance: 10,
    started_at: 0,
    seconds_left: 200,
};

let container: HTMLDivElement;
let root: Root;
const fills = {
    plan: vi.fn(async () => ({ ok: true, plan })),
    start: vi.fn(async () => ({ ok: true, job: running })),
    stop: vi.fn(() => true),
    dismiss: vi.fn(),
    jobForTable: vi.fn(() => null),
};

beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).Zotero = { Beaver: { tableFills: fills, runtime: { subscribeWindow: () => () => {} } } };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const render = (element: React.ReactElement) => act(() => root.render(element));
/** A button's own text: icons (a spinner carries a stylesheet) left out. */
const label = (button: Element) =>
    [...button.childNodes]
        .filter((node) => (node as Element).tagName?.toLowerCase() !== 'svg' && !(node as Element).querySelector?.('svg'))
        .map((node) => node.textContent)
        .join('')
        .trim();
const buttonNamed = (text: string) =>
    [...container.querySelectorAll('button')].find((b) => label(b) === text) as HTMLButtonElement | undefined;

describe('TableFillButton', () => {
    it('counts the new and stale rows, and reads "Fill" when everything is up to date', () => {
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec([row('a'), row('b')]), job: null, improvableRows: new Set<string>() }));
        expect(buttonNamed('Fill 2 rows')).toBeDefined();
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec([row('a', { method: answered }, { documents: ['u-A'] })]), job: null, improvableRows: new Set<string>() }));
        const idle = buttonNamed('Fill')!;
        expect(label(idle)).toBe('Fill');
        expect(idle.getAttribute('title')).toBe('Everything is up to date');
    });

    it('does not light for a row that only needs a retry', () => {
        render(
            React.createElement(TableFillButton, {
                tableRef: ref,
                table: spec([row('a', {}, { failure: { code: 'no_source', message: 'x' } })]),
                job: null,
                improvableRows: new Set<string>(),
            }),
        );
        expect(buttonNamed('Fill')).toBeDefined();
        expect(buttonNamed('Fill 1 row')).toBeUndefined();
    });

    it('shows the plan with its cost and balance, and starts exactly that plan', async () => {
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec([row('a'), row('b')]), job: null, improvableRows: new Set<string>() }));
        await act(async () => buttonNamed('Fill 2 rows')!.click());
        expect(fills.plan).toHaveBeenCalledWith(ref, { kind: 'pending' });
        const popover = container.querySelector('[role="dialog"]')!;
        expect(popover.textContent).toContain('Fill 2 papers · 0.4 credits');
        expect(popover.textContent).toContain('Reads 2 papers: 2 from the PDF');
        expect(popover.textContent).toContain('Filling costs 0.2 credits per paper');
        expect(popover.textContent).toContain('Your 0.2 credits cover about 1 of 2 papers');
        await act(async () => buttonNamed('Fill 2')!.click());
        expect(fills.start).toHaveBeenCalledWith('plan-1');
        expect(container.querySelector('[role="dialog"]')).toBeNull();
    });

    it('keeps the popover open with the reason when the start is refused', async () => {
        fills.start.mockResolvedValueOnce({ ok: false, code: 'fill_in_progress', message: 'This table is already being filled.' } as any);
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec([row('a')]), job: null, improvableRows: new Set<string>() }));
        await act(async () => buttonNamed('Fill 1 row')!.click());
        await act(async () => buttonNamed('Fill 2')!.click());
        expect(container.querySelector('[role="alert"]')?.textContent).toBe('This table is already being filled.');
    });

    it('is the Stop button while a job runs, and says it is stopping after Stop', () => {
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec([row('a')]), job: running, improvableRows: new Set<string>() }));
        act(() => buttonNamed('Stop · 12/46')!.click());
        expect(fills.stop).toHaveBeenCalledWith('job-1');
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec([row('a')]), job: { ...running, state: 'stopping' }, improvableRows: new Set<string>() }));
        const stopping = buttonNamed('Stopping… finishing 3 papers')!;
        expect(stopping.disabled).toBe(true);
    });

    it('is disabled with the reason in a read-only library', () => {
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec([row('a')]), job: null, improvableRows: new Set<string>(), disabledReason: 'This library is read-only.' }));
        const main = buttonNamed('Fill 1 row')!;
        expect(main.disabled).toBe(true);
        expect(main.getAttribute('title')).toBe('This library is read-only.');
    });
});

describe('TableFillBanner', () => {
    it('states the result, filters to the failed rows and dismisses', () => {
        const onShowFailed = vi.fn();
        const onDismiss = vi.fn();
        const done: TableFillJobSnapshot = {
            ...running,
            state: 'done',
            result: {
                rows_answered: 44,
                answered: 88,
                not_reported: 0,
                from_title_abstract: 0,
                documents_read: 44,
                credits_charged: 8.8,
                row_failures: { encrypted: 2 },
                failed_row_ids: ['x', 'y'],
                not_started: {},
                not_written: 0,
                skipped_cells: {},
                pending: null,
            },
        };
        render(React.createElement(TableFillBanner, { job: done, showingFailed: false, onShowFailed, onDismiss }));
        expect(container.textContent).toContain("Filled 44 rows · 2 couldn't be read · 8.8 credits");
        act(() => buttonNamed('Show')!.click());
        expect(onShowFailed).toHaveBeenCalledWith(true);
        act(() => (container.querySelector('[aria-label="Dismiss"]') as HTMLButtonElement).click());
        expect(onDismiss).toHaveBeenCalled();
    });
});
