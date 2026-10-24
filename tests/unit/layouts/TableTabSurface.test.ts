// @vitest-environment jsdom
/**
 * What the full-size table surface (the Beaver tab) adds to the shared grid:
 * row windowing, fitting the columns to the width, the metadata-only marks,
 * the value filters, and copying the view as text.
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toPlainText, type Column, type Row, type TableSpec } from '@beaver/agent-core/layouts/table';
import { DataTable } from '@beaver/agent-ui/layouts/DataTable';
import { TableHeaderActions } from '@beaver/agent-ui/layouts/chrome/TableBars';
import { fitColumns } from '@beaver/agent-ui/layouts/tableView';
import { useTableState, type TableState } from '@beaver/agent-ui/layouts/useTableState';
import { setHost } from '@beaver/agent-ui/host';

const h = React.createElement;

function rows(count: number): Row[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `r${i}`,
        cells: {
            ref: { outcome: 'answered', provenance: 'system', value: { kind: 'reference', display_name: `Paper ${i}` } },
            finding: i % 3 === 0
                ? { outcome: 'answered', provenance: 'metadata', value: { kind: 'text', text: `From abstract ${i}` }, evidence: [{ field: 'abstract', quote: 'q' }] }
                : { outcome: 'answered', provenance: 'document', value: { kind: 'text', text: `Finding ${i}` } },
            note: i % 2 === 0 ? { outcome: 'answered', provenance: 'document', value: { kind: 'text', text: 'Note\twith tab' } } : { outcome: 'not_reported', provenance: 'document' },
        },
    })) as Row[];
}

const columns: Column[] = [
    { id: 'ref', header: 'Item', type: 'reference' },
    { id: 'finding', header: 'Finding', type: 'text' },
    { id: 'note', header: 'Note', type: 'text' },
];

function spec(count: number): TableSpec {
    return { id: 't', title: 'Table', anchor_column_id: 'ref', columns, rows: rows(count) };
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

function mount(element: React.ReactElement, scroll = true) {
    container = document.createElement('div');
    if (scroll) container.className = 'bt-scroll';
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(element));
    return container;
}

const renderedRows = () => container!.querySelectorAll('tbody > tr[data-row-id]');
const spacers = () => Array.from(container!.querySelectorAll<HTMLElement>('tr.bt-spacer-row'));

const originalRect = HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
    setHost({});
    // jsdom has no layout. The body moves up as the scroller scrolls, which is
    // the one geometric fact the windowing reads.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        const scroller = this.closest('.bt-scroll') as HTMLElement | null;
        const top = this.localName === 'tbody' && scroller ? -scroller.scrollTop : 0;
        return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON() {} } as DOMRect;
    };
});

afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    vi.restoreAllMocks();
});

describe('row windowing', () => {
    it('puts only the rows near the viewport in the DOM, with spacers for the rest', () => {
        mount(h(DataTable, { table: spec(1000), virtualize: true }));
        const count = renderedRows().length;
        expect(count).toBeGreaterThan(5);
        expect(count).toBeLessThan(60);
        expect(spacers()).toHaveLength(1);
        expect(parseFloat(spacers()[0].style.height)).toBeGreaterThan(0);
    });

    it('moves the window with the scroll, synchronously', () => {
        mount(h(DataTable, { table: spec(1000), virtualize: true }));
        const scroller = container!;
        act(() => {
            scroller.scrollTop = 30000;
            scroller.dispatchEvent(new Event('scroll'));
        });
        const ids = Array.from(renderedRows()).map((tr) => Number(tr.getAttribute('data-row-id')!.slice(1)));
        expect(ids[0]).toBeGreaterThan(400);
        expect(ids[ids.length - 1]).toBeLessThan(600);
        // A spacer above and one below.
        expect(spacers()).toHaveLength(2);
    });

    it('renders every row without a scroll container to measure against', () => {
        mount(h(DataTable, { table: spec(80), virtualize: true }), false);
        expect(renderedRows()).toHaveLength(80);
        expect(spacers()).toHaveLength(0);
    });

    it('renders every row when windowing is off', () => {
        mount(h(DataTable, { table: spec(80) }));
        expect(renderedRows()).toHaveLength(80);
    });
});

describe('fitting the width', () => {
    it('keeps the columns that fit, and lists the others in the expanded row', () => {
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
        mount(h(DataTable, { table: spec(3), fitWidth: true }));
        const headers = Array.from(container!.querySelectorAll('th .bt-th-label')).map((el) => el.textContent);
        // Rail 3.2rem + anchor 20rem + one flexible 14rem fit 600px at 13px; a second does not.
        expect(headers).toEqual(['Item', 'Finding']);
        expect(container!.querySelector('.bt-fit-note')?.textContent).toContain('Note does not fit');
        expect((container!.querySelector('table.bt-table') as HTMLElement).style.minWidth).toBe('');

        act(() => container!.querySelector<HTMLButtonElement>('.bt-rail-chevron')!.click());
        expect(Array.from(container!.querySelectorAll('.bt-detail-fields dt')).map((dt) => dt.textContent)).toContain('Note');
    });

    it('computes the fit from the widths the grid gives each column', () => {
        expect(fitColumns(columns, 'ref', 2000, 13).overflow).toEqual([]);
        expect(fitColumns(columns, 'ref', 100, 13)).toEqual({ fit: [columns[0]], overflow: columns.slice(1) });
    });
});

describe('metadata-only cells', () => {
    it('marks the cell and counts it in the column header', () => {
        mount(h(DataTable, { table: spec(6) }));
        expect(container!.querySelectorAll('td.bt-td-metadata')).toHaveLength(2);
        const finding = Array.from(container!.querySelectorAll('th.bt-th')).find(
            (th) => th.querySelector('.bt-th-label')?.textContent === 'Finding',
        )!;
        expect(finding.querySelector('.bt-th-meta')?.textContent).toBe('2 from abstract');
        expect(container!.querySelector('td.bt-td-metadata .bt-metadata-only')?.textContent).toContain('From title and abstract');
    });
});

describe('value filters and copy', () => {
    function Harness({ onState, onCopy }: { onState(state: TableState): void; onCopy(text: string): void }) {
        const table = spec(4);
        const state = useTableState(table);
        onState(state);
        return h(
            React.Fragment,
            null,
            h(TableHeaderActions, { table, state, onCopy }),
            h(DataTable, { table, state }),
        );
    }

    it('filters to the rows with, or without, a value in a column', () => {
        let state!: TableState;
        mount(h(Harness, { onState: (s: TableState) => { state = s; }, onCopy: () => {} }));
        act(() => state.toggleEmptyFilter('note', true));
        expect(renderedRows()).toHaveLength(2);
        act(() => state.toggleEmptyFilter('note', false));
        expect(renderedRows()).toHaveLength(2);
        act(() => state.toggleEmptyFilter('note', false));
        expect(renderedRows()).toHaveLength(4);
    });

    it('copies the rows in view, the columns not hidden, as tab-separated text', () => {
        let state!: TableState;
        const onCopy = vi.fn();
        mount(h(Harness, { onState: (s: TableState) => { state = s; }, onCopy }));
        act(() => state.toggleSort('ref'));
        act(() => state.toggleSort('ref'));
        act(() => state.toggleColumn('finding'));
        act(() => container!.querySelector<HTMLButtonElement>('button')!.click());

        const text: string = onCopy.mock.calls[0][0];
        expect(text.split('\n')).toEqual([
            'Item\tNote',
            'Paper 3\tNot reported',
            'Paper 2\tNote with tab',
            'Paper 1\tNot reported',
            'Paper 0\tNote with tab',
        ]);
        expect(container!.querySelector('button')!.textContent).toContain('Copied');
    });

    it('builds the text from values only, one line per row', () => {
        const table = spec(2);
        expect(toPlainText(table)).toBe(
            'Item\tFinding\tNote\nPaper 0\tFrom abstract 0\tNote with tab\nPaper 1\tFinding 1\tNot reported',
        );
    });
});

describe('fit to width without expandable rows', () => {
    it('keeps every column in the grid when rows cannot expand', () => {
        const table = { ...spec(3), capabilities: { expandable_rows: false } };
        mount(h(DataTable, { table, fitWidth: true }));
        expect(container!.querySelector('.bt-fit')).toBeNull();
        expect(container!.querySelector('.bt-fit-note')).toBeNull();
        expect(container!.querySelectorAll('thead th').length).toBe(columns.length + 1);
    });
});

describe('the surface around a table that does not fit', () => {
    it('lets a table whose rows cannot expand scroll sideways', async () => {
        const { TableSurface } = await import('@beaver/agent-ui/layouts/chrome/TableSurface');
        const table = { ...spec(3), capabilities: { expandable_rows: false } };
        mount(h(TableSurface as any, { table, fitWidth: true }));
        expect(container!.querySelector('.bt-surface-fit')).toBeNull();
    });
});
