// @vitest-environment jsdom
/**
 * The research table tab as rendered: the grid's cell states and tags, the
 * cell inspector for each kind of cell, and evidence opening through the
 * host's citation activation.
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cell, TableSpec } from '@beaver/agent-core/layouts/table';
import { ResearchTable } from '@beaver/agent-ui/layouts/research/ResearchTable';
import { setHost } from '@beaver/agent-ui/host';

const h = React.createElement;

const pdf = 'u-PDFKEY01';
const passage = { document: pdf, locator: 's14.2', quote: 'Enrollment rose by 3.4 points.', page: 13, boxes: [[10, 10, 50, 20]] };
const model = (text: string, extra: Partial<Cell> = {}): Cell =>
    ({ outcome: 'answered', provenance: 'model', value: { kind: 'text', text }, documents: [pdf], evidence: [passage], reasoning: 'Table 2 reports it.', ...extra }) as Cell;

function table(): TableSpec {
    const reference = (name: string) =>
        ({ outcome: 'answered', provenance: 'system', value: { kind: 'reference', display_name: name, title: `${name} title`, subtitle: 'Smith, Jones', venue: 'QJE' } }) as Cell;
    return {
        id: 't',
        key: 'TABLEKEY',
        title: 'Cash transfers',
        description: 'Effects on schooling.',
        anchor_column_id: '_reference',
        sources: [{ id: 's', type: 'items', ids: ['u-A', 'u-B'] }],
        columns: [
            { id: '_reference', header: 'Reference', type: 'reference', system: true },
            { id: '_year', header: 'Year', type: 'date', system: true },
            { id: 'effect', header: 'Headline effect', type: 'text', description: 'The headline effect?' },
            { id: 'design', header: 'Design', type: 'select', description: 'Design?', options: [{ label: 'RCT', color: 'green' }] },
            { id: 'amount', header: 'Amount', type: 'text', description: 'Transfer size?' },
        ],
        rows: [
            {
                id: 'r1',
                ref: { kind: 'item', library_ref: 'u', zotero_key: 'AAAA1111', library_id: 1 },
                documents: [pdf],
                cells: {
                    _reference: reference('Baird 2011'),
                    _year: { outcome: 'answered', provenance: 'system', value: { kind: 'date', value: '2011' } } as Cell,
                    effect: model('Conditional transfers raised enrollment.'),
                    design: { outcome: 'answered', provenance: 'model', value: { kind: 'select', label: 'RCT' }, documents: [pdf], evidence: [passage] } as Cell,
                },
            },
            {
                id: 'r2',
                ref: { kind: 'item', library_ref: 'u', zotero_key: 'BBBB2222', library_id: 1 },
                documents: [pdf],
                cells: {
                    _reference: reference('Haushofer 2016'),
                    effect: {
                        outcome: 'answered',
                        provenance: 'user',
                        value: { kind: 'text', text: 'Gains in consumption.' },
                        reasoning: 'Schooling was not an outcome.',
                        replaced: model('Transfers raised consumption.') as never,
                    } as Cell,
                    design: { outcome: 'not_reported', provenance: 'model', documents: [pdf] } as Cell,
                },
            },
            {
                id: 'r3',
                ref: { kind: 'item', library_ref: 'u', zotero_key: 'CCCC3333', library_id: 1 },
                cells: { _reference: reference('Benhassine 2015') },
            },
        ],
    };
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
const activateCitation = vi.fn();

function mount(props: Partial<React.ComponentProps<typeof ResearchTable>> = {}) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
        root?.render(
            h(ResearchTable, {
                table: table(),
                documents: new Map([[pdf, { name: 'Baird_2011.pdf', kind: 'pdf' }]]),
                ...props,
            }),
        ),
    );
    return container;
}

const cell = (rowId: string, columnId: string) =>
    container!.querySelector<HTMLElement>(`tr[data-row-id="${rowId}"] td[data-column-id="${columnId}"]`)!;
const click = (el: Element) => act(() => (el as HTMLElement).click());
const inspector = () => container!.querySelector<HTMLElement>('aside[aria-label="Cell details"]');

beforeEach(() => {
    activateCitation.mockReset();
    setHost({ navigation: { activateCitation, revealInLibrary: vi.fn(), openSource: vi.fn() } as never });
});

afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
});

describe('the grid', () => {
    it('shows the identity, the sources chip and the column badges', () => {
        mount();
        expect(container!.querySelector('.rt-title')?.textContent).toBe('Cash transfers');
        expect(container!.querySelector('.rt-sources-chip')?.textContent).toBe('1 source · 3 papers');
        const amount = container!.querySelector('th[data-column-id="amount"]')!;
        expect(amount.querySelector('.rt-badge-new')?.textContent).toBe('New');
        expect(amount.querySelector('.rt-th-question-text')?.textContent).toBe('Transfer size?');
    });

    it('draws each cell state with its tags', () => {
        mount();
        expect(cell('r1', 'effect').querySelector('.rt-tag-page')?.textContent).toBe('p. 14');
        expect(cell('r1', 'design').querySelector('.bt-pill')?.textContent).toBe('RCT');
        expect(cell('r2', 'effect').querySelector('.rt-tag-edited')).not.toBeNull();
        expect(cell('r2', 'effect').querySelector('.rt-tag-page')).toBeNull();
        expect(cell('r2', 'design').textContent).toContain('Not reported');
        expect(cell('r3', 'effect').textContent).toBe('—');
        const paper = container!.querySelector('tr[data-row-id="r3"] .rt-paper')!;
        expect(paper.textContent).toContain('New paper');
        expect(paper.textContent).toContain('Smith, Jones · QJE');
    });

    it('copies the view as text with the paper and the year', () => {
        const onCopy = vi.fn();
        mount({ onCopy });
        // The menu's item, called as the menu would.
        const menu = container!.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')!;
        click(menu);
        const item = Array.from(document.querySelectorAll<HTMLElement>('*')).find((el) => el.textContent === 'Copy as text' && el.children.length === 0);
        click(item!);
        expect(onCopy).toHaveBeenCalledTimes(1);
        const [header, first] = (onCopy.mock.calls[0][0] as string).split('\n');
        expect(header.split('\t').slice(0, 3)).toEqual(['Reference', 'Year', 'Headline effect']);
        expect(first).toContain('Baird 2011');
    });

    it("offers the paper's Open in the row menu, reachable by keyboard", () => {
        mount();
        const menu = container!.querySelector<HTMLButtonElement>('tr[data-row-id="r1"] button[aria-label="Row actions"]')!;
        click(menu);
        const labels = Array.from(document.querySelectorAll<HTMLElement>('*'))
            .filter((el) => el.children.length === 0)
            .map((el) => el.textContent);
        expect(labels).toContain('Show in library');
        expect(labels).toContain('Open PDF');
        expect(container!.querySelector('tr[data-row-id="r1"] .rt-paper-body')!.getAttribute('tabindex')).toBe('0');
    });

    it("keeps the host's Add control on an external work the table lets the user import", () => {
        const externalReferenceActions = vi.fn(() => h('button', { className: 'import-control' }, 'Add'));
        setHost({ navigation: { activateCitation } as never, components: { externalReferenceActions, itemTypeIcon: () => null } as never });
        const spec = table();
        spec.capabilities = { row_actions: ['import'] };
        spec.rows.push({
            id: 'ext',
            ref: { kind: 'external', source: 'openalex', source_id: 'W1', reference: { title: 'Outside work' } as never },
            cells: { _reference: { outcome: 'answered', provenance: 'system', value: { kind: 'reference', display_name: 'Outside 2020' } } as Cell },
        });
        mount({ table: spec });
        expect(container!.querySelector('tr[data-row-id="ext"] .import-control')).not.toBeNull();
        expect(container!.querySelector('tr[data-row-id="r1"] .import-control')).toBeNull();
    });

    it('opens the passage through the citation activation when a page tag is clicked', () => {
        mount();
        click(cell('r1', 'effect').querySelector('.rt-tag-page')!);
        expect(activateCitation).toHaveBeenCalledTimes(1);
        const activation = activateCitation.mock.calls[0][0];
        expect(activation.intent).toBe('passage');
        expect(activation.effectiveItemKey).toBe('PDFKEY01');
        expect(activation.metadata.content_kind).toBe('pdf');
        expect(activation.metadata.locations[0]).toMatchObject({ page_idx: 13, boxes: passage.boxes });
        // The tag opens the passage; it does not open the inspector.
        expect(inspector()).toBeNull();
    });
});

describe('the cell inspector', () => {
    it("shows a model answer with its source, reasoning and passages, and the row's document", () => {
        mount();
        click(cell('r1', 'effect'));
        const panel = inspector()!;
        expect(panel.textContent).toContain('Baird 2011');
        expect(panel.querySelector('.rt-inspector-question')?.textContent).toBe('The headline effect?');
        expect(panel.querySelector('.rt-section-source')?.textContent).toBe('from the PDF');
        expect(panel.textContent).toContain('Conditional transfers raised enrollment.');
        expect(panel.textContent).toContain('Table 2 reports it.');
        expect(panel.querySelectorAll('.rt-passage')).toHaveLength(1);
        expect(panel.querySelector('.rt-inspector-document')?.textContent).toBe('Read from Baird_2011.pdf');
        expect(panel.textContent).not.toContain('Your answer');
    });

    it("shows the user's answer and note, then Beaver's earlier answer and its evidence", () => {
        mount();
        click(cell('r2', 'effect'));
        const panel = inspector()!;
        expect(panel.textContent).toContain('Your answer');
        expect(panel.textContent).toContain('Gains in consumption.');
        expect(panel.textContent).toContain('Schooling was not an outcome.');
        const earlier = panel.querySelector('.rt-inspector-card')!;
        expect(earlier.textContent).toContain('Beaver answered');
        expect(earlier.textContent).toContain('Transfers raised consumption.');
        click(earlier.querySelector('.rt-passage')!);
        expect(activateCitation).toHaveBeenCalledTimes(1);
    });

    it('says an unattempted cell is not filled yet, and moves between rows', () => {
        mount();
        click(cell('r3', 'effect'));
        expect(inspector()!.textContent).toContain('Not filled yet.');
        const previous = inspector()!.querySelector<HTMLButtonElement>('button[aria-label="Previous row"]')!;
        expect(inspector()!.querySelector<HTMLButtonElement>('button[aria-label="Next row"]')!.disabled).toBe(true);
        click(previous);
        expect(inspector()!.getAttribute('data-row-id')).toBe('r2');
        expect(inspector()!.getAttribute('data-column-id')).toBe('effect');
    });

    it('lists every question of the row in the whole-paper view', () => {
        mount();
        click(cell('r1', 'effect'));
        click(Array.from(inspector()!.querySelectorAll('[role="tab"]')).find((tab) => tab.textContent === 'Whole paper')!);
        const entries = inspector()!.querySelectorAll('.rt-whole-paper-entry');
        expect(Array.from(entries).map((e) => e.querySelector('.rt-whole-paper-header')?.textContent)).toEqual(['Headline effect', 'Design', 'Amount']);
    });

    it('opens on a cell asked for from outside', () => {
        mount({ focus: { rowId: 'r2', columnId: 'design', token: 1 } });
        expect(inspector()!.getAttribute('data-row-id')).toBe('r2');
        expect(inspector()!.textContent).toContain('Not reported');
    });
});
