// @vitest-environment jsdom

/**
 * The fill result banner in the table tab: a clean result clears at the
 * user's next action or after ten seconds of the tab being visible; a result
 * that needs attention stays until dismissed, as does "failed rows only".
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cell, TableSpec } from '@beaver/agent-core/layouts/table';
import type { TableFillJobSnapshot, TableFillResult } from '@beaver/agent-core/protocol/tableFillProtocol';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../../react/runtime/windowRuntime', () => ({ getWindowRuntime: () => ({}) }));

import { setHost } from '@beaver/agent-ui/host';
import { ResearchTable } from '@beaver/agent-ui/layouts/research/ResearchTable';
import { CLEAN_RESULT_VISIBLE_MS, useFillResultBanner } from '../../../react/components/tables/TableFillControl';

const h = React.createElement;

const answer = (text: string): Cell => ({ outcome: 'answered', provenance: 'model', value: { kind: 'text', text } }) as Cell;
const reference = (name: string) =>
    ({ outcome: 'answered', provenance: 'system', value: { kind: 'reference', display_name: name, title: name } }) as Cell;

const table: TableSpec = {
    id: 't',
    title: 'Trials',
    anchor_column_id: '_reference',
    columns: [
        { id: '_reference', header: 'Reference', type: 'reference', system: true },
        { id: 'effect', header: 'Effect', type: 'text', description: 'What effect?' },
    ],
    rows: [
        { id: 'r1', cells: { _reference: reference('Baird'), effect: answer('Enrollment rose.') } },
        { id: 'r2', cells: { _reference: reference('Haushofer'), effect: answer('Consumption rose.') } },
    ],
} as TableSpec;

const result = (over: Partial<TableFillResult> = {}): TableFillResult => ({
    rows_answered: 2,
    answered: 2,
    not_reported: 0,
    from_title_abstract: 0,
    documents_read: 2,
    credits_charged: 0.4,
    row_failures: {},
    failed_row_ids: [],
    not_started: {},
    not_written: 0,
    skipped_cells: {},
    pending: null,
    ...over,
});

const done = (over: Partial<TableFillResult> = {}, jobId = 'job-1'): TableFillJobSnapshot => ({
    job_id: jobId,
    plan_id: 'plan-1',
    table: { libraryID: 1, key: 'TABLE001', title: 'Trials' },
    origin: { kind: 'user' },
    state: 'done',
    rows_total: 2,
    rows_done: 2,
    rows_failed: 0,
    in_flight: 0,
    credits_charged: 0.4,
    credits_planned: 0.4,
    balance: 10,
    started_at: 0,
    seconds_left: null,
    result: result(over),
});

function Harness({ job, visible }: { job: TableFillJobSnapshot | null; visible: boolean | null }) {
    const fill = useFillResultBanner(job, visible);
    return h(ResearchTable, {
        table,
        banner: fill.banner ?? undefined,
        onActivity: fill.onActivity,
        onlyRows: fill.failedRows,
    });
}

const dismiss = vi.fn();
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(job: TableFillJobSnapshot | null, visible: boolean | null = null) {
    if (!root) {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    }
    act(() => root!.render(h(Harness, { job, visible })));
}

const banner = () => container!.querySelector<HTMLElement>('.bt-banner');
const cell = (rowId: string) => container!.querySelector<HTMLElement>(`tr[data-row-id="${rowId}"] td[data-column-id="effect"]`)!;
const click = (el: Element | null) => act(() => (el as HTMLElement).click());
const button = (label: string) =>
    Array.from(container!.querySelectorAll<HTMLButtonElement>('.bt-banner button')).find((b) => b.textContent === label) ?? null;

beforeEach(() => {
    dismiss.mockReset();
    (globalThis as any).Zotero = { Beaver: { tableFills: { dismiss } } };
    setHost({} as never);
});

afterEach(() => {
    vi.useRealTimers();
    if (root) act(() => root!.unmount());
    container?.remove();
    root = null;
    container = null;
    delete (globalThis as any).Zotero;
});

describe('a clean result', () => {
    it('clears at the next cell selection, letting the plugin forget the job', () => {
        render(done());
        expect(banner()?.textContent).toContain('Filled 2 rows · 0.4 credits');
        click(cell('r1'));
        expect(banner()).toBeNull();
        expect(dismiss).toHaveBeenCalledWith('job-1');
    });

    it('can still be dismissed at once with its ×', () => {
        render(done());
        click(container!.querySelector('.bt-banner [aria-label="Dismiss"]'));
        expect(banner()).toBeNull();
        expect(dismiss).toHaveBeenCalledWith('job-1');
    });

    it('clears after ten seconds of the tab being visible, and never counts while it is hidden', () => {
        vi.useFakeTimers();
        render(done(), false);
        act(() => vi.advanceTimersByTime(CLEAN_RESULT_VISIBLE_MS * 3));
        expect(banner()).not.toBeNull();
        render(done(), true);
        act(() => vi.advanceTimersByTime(CLEAN_RESULT_VISIBLE_MS - 1));
        expect(banner()).not.toBeNull();
        act(() => vi.advanceTimersByTime(1));
        expect(banner()).toBeNull();
        expect(dismiss).toHaveBeenCalledWith('job-1');
    });

    it('waits for the next action alone when the tab cannot tell whether it is visible', () => {
        vi.useFakeTimers();
        render(done(), null);
        act(() => vi.advanceTimersByTime(CLEAN_RESULT_VISIBLE_MS * 3));
        expect(banner()).not.toBeNull();
        expect(dismiss).not.toHaveBeenCalled();
    });

    it('shows the next fill’s result after clearing', () => {
        render(done());
        click(cell('r1'));
        render(done({ failed_row_ids: ['r2'] }, 'job-2'));
        expect(banner()?.textContent).toContain("1 couldn't be read");
    });
});

describe('a result that needs attention', () => {
    it.each([
        ['rows could not be read', { failed_row_ids: ['r2'] }],
        ['the fill was stopped', { stopped_by: 'stopped' as const }],
        ['credits ran out', { stopped_by: 'insufficient_credits' as const }],
        ['papers could not be saved', { not_written: 1 }],
        ['answers were left for the next fill', { skipped_cells: { column_changed: 1 } }],
    ])('stays after a cell selection and while visible when %s', (_name, over) => {
        vi.useFakeTimers();
        render(done(over), true);
        click(cell('r1'));
        act(() => vi.advanceTimersByTime(CLEAN_RESULT_VISIBLE_MS * 3));
        expect(banner()).not.toBeNull();
        expect(dismiss).not.toHaveBeenCalled();
    });

    it('stays while the table shows the failed rows only', () => {
        render(done({ failed_row_ids: ['r2'] }), true);
        click(button('Show'));
        expect(container!.querySelector('tr[data-row-id="r1"]')).toBeNull();
        click(cell('r2'));
        expect(banner()).not.toBeNull();
        expect(button('Show all')).not.toBeNull();
        expect(container!.querySelector('tr[data-row-id="r1"]')).toBeNull();
    });

    it('goes when dismissed with its ×', () => {
        render(done({ stopped_by: 'stopped' }));
        click(container!.querySelector('.bt-banner [aria-label="Dismiss"]'));
        expect(banner()).toBeNull();
        expect(dismiss).toHaveBeenCalledWith('job-1');
    });
});
