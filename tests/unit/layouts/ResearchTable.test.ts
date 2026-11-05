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
import { hoverPeek } from '../../helpers/hoverPeek';

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
const paperCell = (rowId: string) => container!.querySelector<HTMLElement>(`tr[data-row-id="${rowId}"] td.rt-td-paper`)!;
const peek = () => container!.querySelector<HTMLElement>('.bt-hover-peek');
/** Hovers a cell until its expansion opens, and returns the expansion. */
const expand = (el: Element) => hoverPeek(el, container!);
const peekButtons = () => Array.from(peek()!.querySelectorAll<HTMLButtonElement>('.rt-peek-footer button'));
const menuEntry = (label: string) =>
    Array.from(document.querySelectorAll<HTMLElement>('*')).find((el) => el.textContent === label && el.children.length === 0);

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
        expect(cell('r3', 'effect').textContent).toBe('');
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

    it("expands the Paper cell to the paper's full details, with its actions in the footer", () => {
        const revealInLibrary = vi.fn();
        setHost({ navigation: { activateCitation, revealInLibrary, openSource: vi.fn() } as never });
        mount();
        // The cell holds no controls of its own; it is focusable for the keyboard.
        expect(paperCell('r1').querySelector('button')).toBeNull();
        expect(paperCell('r1').getAttribute('tabindex')).toBe('0');
        const expansion = expand(paperCell('r1'))!;
        expect(expansion.querySelector('.rt-paper-full .rt-paper-title')?.textContent).toBe('Baird 2011 title');
        expect(expansion.querySelector('.rt-paper-full .rt-paper-meta')?.textContent).toBe('Smith, Jones · 2011 · QJE');
        // The item, not the attachment the row is read from.
        expect(expansion.textContent).not.toContain('Baird_2011.pdf');
        expect(peekButtons().map((b) => b.textContent)).toEqual(['Show in library', 'Open PDF']);
        click(peekButtons()[0]);
        expect(revealInLibrary).toHaveBeenCalledWith(expect.objectContaining({ zotero_key: 'AAAA1111' }));
        expect(peek()).toBeNull();
        expect(inspector()).toBeNull();
    });

    it('expands every question cell, even one whose text fits, with no evidence hint', () => {
        mount();
        const expansion = expand(cell('r1', 'design'))!;
        expect(expansion.querySelector('.bt-pill')?.textContent).toBe('RCT');
        expect(expansion.textContent).not.toContain('Click for evidence');
        // A read-only view has no actions: no footer.
        expect(expansion.querySelector('.rt-peek-footer')).toBeNull();
        // A click on the expansion opens the cell, as a click on the cell does.
        click(expansion.querySelector('.rt-peek')!);
        expect(peek()).toBeNull();
        expect(inspector()!.getAttribute('data-column-id')).toBe('design');
    });

    it("says an unfilled cell's expansion is not filled yet", () => {
        mount();
        expect(cell('r3', 'effect').textContent).toBe('');
        expect(expand(cell('r3', 'effect'))!.querySelector('.rt-peek-body')?.textContent).toBe('Not filled yet');
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
        // In the Paper cell's expansion, not on the cell.
        expect(container!.querySelector('tr[data-row-id="ext"] .import-control')).toBeNull();
        expect(expand(paperCell('ext'))!.querySelector('.rt-peek-footer .import-control')).not.toBeNull();
        expect(expand(paperCell('r1'))!.querySelector('.import-control')).toBeNull();
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

describe('pinned columns', () => {
    it('pins the rail and Paper column only while the grid has as much room again beside them', () => {
        let width = 1000;
        let resized: (() => void) | undefined;
        const win = window as unknown as { ResizeObserver?: unknown };
        const originalObserver = win.ResizeObserver;
        win.ResizeObserver = class {
            constructor(callback: () => void) {
                resized = callback;
            }
            observe() {}
            disconnect() {}
        };
        const offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
        const client = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
            configurable: true,
            get(this: HTMLElement) {
                return this.classList.contains('rt-th-rail') ? 40 : this.classList.contains('rt-th-paper') ? 320 : 0;
            },
        });
        Object.defineProperty(Element.prototype, 'clientWidth', {
            configurable: true,
            get(this: Element) {
                return this.classList.contains('rt-scroll') ? width : 0;
            },
        });
        try {
            mount();
            const scroller = container!.querySelector('.rt-scroll')!;
            expect(scroller.hasAttribute('data-pinned')).toBe(true);
            // 700 px is less than twice the pinned 360 px: nothing stays put.
            width = 700;
            act(() => resized?.());
            expect(scroller.hasAttribute('data-pinned')).toBe(false);
        } finally {
            win.ResizeObserver = originalObserver;
            if (offset) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offset);
            if (client) Object.defineProperty(Element.prototype, 'clientWidth', client);
        }
    });
});

describe('row menus', () => {
    it("puts the row's menu last in the Paper cell's expansion, which closes when an entry is chosen", () => {
        const fill = { onFillRows: vi.fn(), onFillColumn: vi.fn() };
        mount({ fill });
        expand(paperCell('r1'));
        const buttons = peekButtons();
        expect(buttons[buttons.length - 1].getAttribute('aria-label')).toBe('Row actions');
        click(buttons[buttons.length - 1]);
        // Show in library and Open are buttons, not menu entries.
        expect(menuEntry('Show in library')?.closest('[role="menuitem"]')).toBeFalsy();
        click(menuEntry('Refill row')!);
        expect(fill.onFillRows).toHaveBeenCalledWith(['r1']);
        expect(peek()).toBeNull();
        expect(inspector()).toBeNull();
    });

    it("offers the row's menu in the paper view, reachable by keyboard", () => {
        const fill = { onFillRows: vi.fn(), onFillColumn: vi.fn() };
        mount({ fill });
        click(paperCell('r2'));
        click(inspector()!.querySelector('.rt-inspector-row-actions button[aria-label="Row actions"]')!);
        click(menuEntry('Refill row')!);
        expect(fill.onFillRows).toHaveBeenCalledWith(['r2']);
    });
});

describe('the cell inspector', () => {
    it('scrolls its cell into view beside the inspector', () => {
        const scrolled: Array<[string | null, unknown]> = [];
        const original = HTMLElement.prototype.scrollIntoView;
        HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, options?: unknown) {
            scrolled.push([this.getAttribute('data-column-id'), options]);
        };
        try {
            mount();
            click(cell('r1', 'effect'));
            expect(scrolled).toContainEqual(['effect', { block: 'nearest', inline: 'nearest' }]);
        } finally {
            HTMLElement.prototype.scrollIntoView = original;
        }
    });

    const headings = () => Array.from(inspector()!.querySelectorAll('.rt-inspector-body .rt-inspector-heading')).map((el) => el.textContent);

    it("heads a question cell with its column and paper, then the question, the answer, its explanation and its evidence", () => {
        mount();
        click(cell('r1', 'effect'));
        const panel = inspector()!;
        expect(panel.querySelector('.rt-inspector-title')?.textContent).toBe('Headline effect');
        const paper = panel.querySelector<HTMLButtonElement>('button.rt-inspector-paper-link')!;
        expect(paper.textContent).toBe('Baird 2011');
        expect(paper.title).toBe('Baird 2011 title');
        expect(panel.querySelector('.rt-inspector-head')?.textContent).not.toContain('The headline effect?');
        expect(panel.querySelector('.rt-inspector-body > .rt-inspector-question')?.textContent).toBe('The headline effect?');
        expect(panel.querySelector('.rt-inspector-answer')?.textContent).toBe('Conditional transfers raised enrollment.');
        // An answer read from the document has no source line: Evidence counts its passages.
        expect(panel.querySelector('.rt-inspector-answer-section .rt-tag')).toBeNull();
        expect(headings()).toEqual(['Explanation', 'Evidence1']);
        expect(panel.querySelector('.rt-inspector-reasoning')?.textContent).toBe('Table 2 reports it.');
        expect(panel.textContent).not.toContain('Beaver answered');
        expect(panel.querySelector('[role="tab"]')).toBeNull();
        // The document line sits under the Evidence heading, above the passages.
        const evidence = panel.querySelector('.rt-passages')!;
        expect(Array.from(evidence.children).map((el) => el.className)).toEqual([
            'rt-inspector-heading',
            'rt-inspector-document',
            expect.stringContaining('rt-passage'),
        ]);
        expect(evidence.querySelector('.rt-inspector-document')?.textContent).toBe('Read from Baird_2011.pdf');
        expect(panel.querySelectorAll('.rt-inspector-document')).toHaveLength(1);
        expect(panel.textContent).not.toContain('Your answer');
    });

    it('heads Closest passages on a blank, and keeps the document line at the bottom without evidence', () => {
        mount();
        click(cell('r2', 'design'));
        expect(inspector()!.querySelector('.rt-inspector-answer')?.textContent).toBe('Not reported');
        expect(inspector()!.querySelector('.rt-passages')).toBeNull();
        expect(inspector()!.querySelector('.rt-inspector-body')!.lastElementChild!.className).toBe('rt-inspector-document');
        const spec = table();
        spec.rows[1].cells.design = { outcome: 'not_reported', provenance: 'model', documents: [pdf], evidence: [passage, passage] } as Cell;
        act(() => root?.render(h(ResearchTable, { table: spec })));
        expect(headings()).toEqual(['Closest passages2']);
    });

    it('clamps a long explanation to three lines with More and Less', () => {
        const height = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
        // A clamped explanation is taller than its box.
        Object.defineProperty(Element.prototype, 'scrollHeight', {
            configurable: true,
            get(this: Element) {
                return this.classList.contains('rt-inspector-reasoning') && this.classList.contains('rt-clamp') ? 120 : 0;
            },
        });
        try {
            mount();
            click(cell('r1', 'effect'));
            const reasoning = () => inspector()!.querySelector('.rt-inspector-reasoning')!;
            const toggle = () => inspector()!.querySelector<HTMLButtonElement>('.rt-inspector-more');
            expect(reasoning().classList.contains('rt-clamp')).toBe(true);
            expect(toggle()?.textContent).toBe('More');
            click(toggle()!);
            expect(reasoning().classList.contains('rt-clamp')).toBe(false);
            expect(toggle()?.textContent).toBe('Less');
            expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
            click(toggle()!);
            expect(reasoning().classList.contains('rt-clamp')).toBe(true);
            expect(toggle()?.textContent).toBe('More');
        } finally {
            if (height) Object.defineProperty(Element.prototype, 'scrollHeight', height);
            else delete (Element.prototype as { scrollHeight?: number }).scrollHeight;
        }
    });

    it('tags an answer read from title and abstract alone', () => {
        const spec = table();
        spec.rows[0].cells.effect = model('From the abstract.', { documents: [], evidence: [] });
        mount({ table: spec });
        click(cell('r1', 'effect'));
        expect(inspector()!.querySelector('.rt-inspector-answer-section .rt-tag-abstract')?.textContent).toBe('Abstract');
        expect(inspector()!.querySelector('.rt-passages')).toBeNull();
    });

    it('offers no More when the explanation fits', () => {
        mount();
        click(cell('r1', 'effect'));
        expect(inspector()!.querySelector('.rt-inspector-more')).toBeNull();
    });

    it("shows the user's answer and note, then Beaver's earlier answer as a section with its evidence", () => {
        mount();
        click(cell('r2', 'effect'));
        const panel = inspector()!;
        expect(headings()).toEqual(['Your answer', 'Beaver’s answer', 'Explanation', 'Evidence1']);
        const [mine, earlier] = Array.from(panel.querySelectorAll('.rt-inspector-answer-section'));
        expect(mine.querySelector('.rt-inspector-answer')?.textContent).toBe('Gains in consumption.');
        // The heading says who answered; the note follows as plain text.
        expect(mine.querySelector('.rt-inspector-text')?.textContent).toBe('Schooling was not an outcome.');
        expect(panel.textContent).not.toContain('Edited by you');
        expect(earlier.querySelector('.rt-inspector-answer')?.textContent).toBe('Transfers raised consumption.');
        expect(panel.querySelector('.rt-inspector-card')).toBeNull();
        expect(panel.textContent).not.toContain('Beaver answered');
        click(panel.querySelector('.rt-passage')!);
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

});

describe('the paper view', () => {
    const blocks = () => Array.from(inspector()!.querySelectorAll<HTMLButtonElement>('button.rt-paper-question-open'));

    it('opens when the Paper cell is selected, with every question of the row', () => {
        const onActivity = vi.fn();
        mount({ onActivity });
        click(paperCell('r1'));
        const panel = inspector()!;
        expect(panel.getAttribute('data-view')).toBe('paper');
        expect(panel.getAttribute('data-row-id')).toBe('r1');
        expect(paperCell('r1').classList.contains('rt-cell-selected')).toBe(true);
        expect(onActivity).toHaveBeenCalled();
        expect(panel.querySelector('.rt-inspector-title')?.textContent).toBe('Baird 2011 title');
        expect(panel.querySelector('.rt-inspector-subtitle')?.textContent).toBe('Smith, Jones · 2011');
        expect(blocks().map((b) => b.textContent)).toEqual(['Headline effect', 'Design', 'Amount']);
        const values = Array.from(panel.querySelectorAll('.rt-paper-question-value'));
        expect(values[0].querySelector('.rt-clamp')?.textContent).toBe('Conditional transfers raised enrollment.');
        expect(values[0].querySelector('.rt-tag-page')?.textContent).toBe('p. 14');
        expect(values[2].textContent).toBe('Not filled yet. The next Fill answers it.');
        expect(panel.querySelector('.rt-inspector-body')!.lastElementChild!.className).toBe('rt-inspector-document');
    });

    it("offers the row's Show in library and Open, and notes a new paper", () => {
        const revealInLibrary = vi.fn();
        const openSource = vi.fn();
        setHost({ navigation: { activateCitation, revealInLibrary, openSource } as never });
        mount();
        click(paperCell('r1'));
        const actions = () => Array.from(inspector()!.querySelectorAll<HTMLButtonElement>('.rt-inspector-row-actions button'));
        expect(actions().map((b) => b.textContent)).toEqual(['Show in library', 'Open PDF']);
        click(actions()[0]);
        expect(revealInLibrary).toHaveBeenCalledWith(expect.objectContaining({ zotero_key: 'AAAA1111' }));
        click(actions()[1]);
        expect(openSource).toHaveBeenCalledTimes(1);
        expect(inspector()!.textContent).not.toContain('New paper');
        click(paperCell('r3'));
        expect(inspector()!.querySelector('.rt-inspector-note')?.textContent).toBe('New paper: added since the last fill.');
    });

    it("opens a question's cell from its block", () => {
        mount();
        click(paperCell('r1'));
        click(blocks().find((b) => b.textContent === 'Design')!);
        expect(inspector()!.getAttribute('data-view')).toBe('cell');
        expect(inspector()!.getAttribute('data-column-id')).toBe('design');
        expect(cell('r1', 'design').classList.contains('rt-cell-selected')).toBe(true);
    });

    it("opens from the cell view's paper subtitle", () => {
        mount();
        click(cell('r2', 'effect'));
        click(inspector()!.querySelector('button.rt-inspector-paper-link')!);
        expect(inspector()!.getAttribute('data-view')).toBe('paper');
        expect(inspector()!.getAttribute('data-row-id')).toBe('r2');
        expect(paperCell('r2').classList.contains('rt-cell-selected')).toBe(true);
    });

    it('steps from paper to paper with the row buttons', () => {
        mount();
        click(paperCell('r2'));
        click(inspector()!.querySelector('button[aria-label="Next row"]')!);
        expect(inspector()!.getAttribute('data-view')).toBe('paper');
        expect(inspector()!.getAttribute('data-row-id')).toBe('r3');
        click(inspector()!.querySelector('button[aria-label="Previous row"]')!);
        click(inspector()!.querySelector('button[aria-label="Previous row"]')!);
        expect(inspector()!.getAttribute('data-row-id')).toBe('r1');
        expect(inspector()!.querySelector('.rt-inspector-title')?.textContent).toBe('Baird 2011 title');
    });

    it('selects the Paper cell from the keyboard', () => {
        mount();
        act(() => {
            paperCell('r2').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });
        expect(inspector()!.getAttribute('data-view')).toBe('paper');
        expect(inspector()!.getAttribute('data-row-id')).toBe('r2');
    });

    it("leaves the cell unselected when its row menu is used", () => {
        mount({ fill: { onFillRows: vi.fn(), onFillColumn: vi.fn() } });
        expand(paperCell('r1'));
        click(peek()!.querySelector('button[aria-label="Row actions"]')!);
        click(menuEntry('Refill row')!);
        expect(inspector()).toBeNull();
        expect(paperCell('r1').classList.contains('rt-cell-selected')).toBe(false);
    });

    it("says a failed row's unfilled questions were not answered, not that the next Fill answers them", () => {
        const spec = table();
        spec.rows[2].failure = { code: 'no_source', message: 'This item has no document or abstract.' };
        mount({ table: spec });
        click(paperCell('r3'));
        expect(inspector()!.querySelector('.rt-inspector-failure')?.textContent).toBe('This item has no document or abstract.');
        const values = Array.from(inspector()!.querySelectorAll('.rt-paper-question-value')).map((v) => v.textContent);
        expect(values).toEqual(['Not answered', 'Not answered', 'Not answered']);
    });

    it('is not selectable in a table without a paper column', () => {
        // Every table with columns has an anchor: only a table without columns lacks one.
        const spec = table();
        spec.columns = [];
        delete spec.anchor_column_id;
        mount({ table: spec });
        const paper = paperCell('r1');
        expect(paper.classList.contains('rt-td-selectable')).toBe(false);
        click(paper);
        expect(inspector()).toBeNull();
    });

    it('opens on a cell asked for from outside', () => {
        mount({ focus: { rowId: 'r2', columnId: 'design', token: 1 } });
        expect(inspector()!.getAttribute('data-row-id')).toBe('r2');
        expect(inspector()!.textContent).toContain('Not reported');
    });

    it('closes the cell inspector when a whole row is asked for', () => {
        mount();
        click(cell('r1', 'effect'));
        expect(inspector()).not.toBeNull();
        act(() => root?.render(h(ResearchTable, { table: table(), focus: { rowId: 'r2', token: 1 } })));
        expect(inspector()).toBeNull();
    });

    it('waits for a column the table on screen does not have yet', () => {
        const focus = { rowId: 'r2', columnId: 'country', token: 1 };
        mount({ focus });
        expect(inspector()).toBeNull();
        const next = table();
        next.columns = [...next.columns, { id: 'country', header: 'Country', type: 'text' }];
        act(() => root?.render(h(ResearchTable, { table: next, focus })));
        expect(inspector()!.getAttribute('data-row-id')).toBe('r2');
        expect(inspector()!.getAttribute('data-column-id')).toBe('country');
    });

    it('shows a filtered-out row and a hidden column before focusing the cell asked for', () => {
        mount();
        click(container!.querySelector('button[aria-label="Column menu: Design"]')!);
        click(Array.from(document.querySelectorAll<HTMLElement>('*')).find((el) => el.textContent === 'Hide column' && el.children.length === 0)!);
        const search = container!.querySelector<HTMLInputElement>('input[aria-label="Search rows"]')!;
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'no row matches this');
            search.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(container!.querySelector('tr[data-row-id="r2"]')).toBeNull();

        act(() =>
            root?.render(
                h(ResearchTable, {
                    table: table(),
                    documents: new Map([[pdf, { name: 'Baird_2011.pdf', kind: 'pdf' }]]),
                    focus: { rowId: 'r2', columnId: 'design', token: 1 },
                }),
            ),
        );
        expect(cell('r2', 'design').classList.contains('rt-cell-selected')).toBe(true);
        expect(inspector()!.getAttribute('data-row-id')).toBe('r2');
    });
});

describe('structural edit controls', () => {
    const menuItem = (label: string) =>
        Array.from(document.querySelectorAll<HTMLElement>('*')).find((el) => el.textContent === label && el.children.length === 0);
    const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) =>
        act(() => {
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
            setter.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    const key = (el: Element, init: KeyboardEventInit) =>
        act(() => {
            el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
        });

    it('renames the table in place: Enter saves, Escape cancels, a composing IME keeps the field', () => {
        const onTitle = vi.fn();
        mount({ editing: { onTitle } });
        click(container!.querySelector('button[aria-label="Rename table"]')!);
        const field = container!.querySelector<HTMLInputElement>('input[aria-label="Rename table"]')!;
        type(field, 'Cash and schooling');
        key(field, { key: 'Enter', isComposing: true });
        expect(onTitle).not.toHaveBeenCalled();
        expect(container!.querySelector('input[aria-label="Rename table"]')).not.toBeNull();
        key(field, { key: 'Enter' });
        expect(onTitle).toHaveBeenCalledWith('Cash and schooling');

        click(container!.querySelector('button[aria-label="Rename table"]')!);
        const again = container!.querySelector<HTMLInputElement>('input[aria-label="Rename table"]')!;
        type(again, 'Never saved');
        key(again, { key: 'Escape' });
        expect(onTitle).toHaveBeenCalledTimes(1);
        expect(container!.querySelector('input[aria-label="Rename table"]')).toBeNull();
    });

    it('edits the description, and clears it with an empty field', () => {
        const onDescription = vi.fn();
        mount({ editing: { onDescription } });
        click(container!.querySelector('.rt-description')!);
        const field = container!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit description"]')!;
        type(field, '');
        key(field, { key: 'Enter' });
        expect(onDescription).toHaveBeenCalledWith('');
    });

    it('shows the controls disabled with the reason in a read-only library', () => {
        mount({ editing: { disabledReason: 'This library is read-only.', onTitle: vi.fn(), onAddColumn: vi.fn() } });
        const pencil = container!.querySelector<HTMLButtonElement>('button[aria-label="Rename table"]')!;
        expect(pencil.disabled).toBe(true);
        expect(pencil.title).toBe('This library is read-only.');
        expect(container!.querySelector<HTMLButtonElement>('button[aria-label="Add column"]')!.disabled).toBe(true);
    });

    it("offers the column menu's edits, then Sort and Hide, and adds a column from (+)", () => {
        const onEditColumn = vi.fn();
        const onChangeType = vi.fn();
        const onRemoveColumn = vi.fn();
        const onAddColumn = vi.fn();
        mount({ editing: { onEditColumn, onChangeType, onRemoveColumn, onAddColumn } });
        click(container!.querySelector('button[aria-label="Column menu: Headline effect"]')!);
        click(menuItem('Edit column…')!);
        expect(onEditColumn).toHaveBeenCalledWith(expect.objectContaining({ id: 'effect' }));
        click(container!.querySelector('button[aria-label="Column menu: Headline effect"]')!);
        click(menuItem('Remove column')!);
        expect(onRemoveColumn).toHaveBeenCalledWith(expect.objectContaining({ id: 'effect' }));
        click(container!.querySelector('button[aria-label="Add column"]')!);
        expect(onAddColumn).toHaveBeenCalledTimes(1);
    });

    it('raises the header whose menu is open over the headers after it', () => {
        mount({ editing: { onEditColumn: vi.fn() } });
        const header = container!.querySelector('th[data-column-id="effect"]')!;
        expect(header.classList.contains('rt-th-menu-open')).toBe(false);
        click(container!.querySelector('button[aria-label="Column menu: Headline effect"]')!);
        expect(header.classList.contains('rt-th-menu-open')).toBe(true);
        click(menuItem('Edit column…')!);
        expect(header.classList.contains('rt-th-menu-open')).toBe(false);
    });

    it('hides a column from its menu and shows it again from the toolbar', () => {
        mount();
        click(container!.querySelector('button[aria-label="Column menu: Amount"]')!);
        click(menuItem('Hide column')!);
        expect(container!.querySelector('th[data-column-id="amount"]')).toBeNull();
        click(container!.querySelector('.rt-hidden-columns')!);
        expect(container!.querySelector('th[data-column-id="amount"]')).not.toBeNull();
    });

    it('opens the sources popover from the chip and closes it on Escape', () => {
        mount({ editing: { renderSources: (close) => h('button', { className: 'probe', onClick: close }, 'Inside') } });
        const chip = container!.querySelector<HTMLButtonElement>('.rt-sources-button')!;
        click(chip);
        expect(container!.querySelector('[role="dialog"][aria-label="Sources"] .probe')).not.toBeNull();
        key(document, { key: 'Escape' });
        expect(container!.querySelector('[aria-label="Sources"]')).toBeNull();
        click(chip);
        click(container!.querySelector('.probe')!);
        expect(container!.querySelector('[aria-label="Sources"]')).toBeNull();
    });

    it("adds the new papers from the notice's Add", () => {
        const onAddNewPapers = vi.fn();
        mount({ newPapers: { count: 3, sources: 1, sourceName: 'Cash transfers' }, editing: { onAddNewPapers } });
        click(container!.querySelector('.rt-new-papers-add')!);
        expect(onAddNewPapers).toHaveBeenCalledTimes(1);
    });
});

describe('editing cells and filling from rows and columns', () => {
    const menuItem = (label: string) =>
        Array.from(document.querySelectorAll<HTMLElement>('*')).find((el) => el.textContent === label && el.children.length === 0);
    const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) =>
        act(() => {
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
            setter.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    const key = (el: Element, init: KeyboardEventInit) =>
        act(() => {
            el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
        });
    const editor = () => container!.querySelector<HTMLElement>('.rt-cell-editor');
    const flush = () => act(async () => {});

    function editing(onEdit = vi.fn(async () => null as string | null)) {
        return { onEdit, onRestore: vi.fn(), onChooseDocument: vi.fn() };
    }

    it("edits a text cell in place from the Edit in its expansion: the answer, a note, and Save", async () => {
        const cellEditing = editing();
        mount({ cellEditing });
        click(expand(cell('r1', 'effect'))!.querySelector('button[aria-label="Edit Headline effect"]')!);
        expect(inspector()).toBeNull();
        const [answer] = editor()!.querySelectorAll<HTMLTextAreaElement>('textarea');
        expect(answer.value).toBe('Conditional transfers raised enrollment.');
        expect(editor()!.textContent).toContain('Fills won’t change your answer.');
        type(answer, 'Enrollment rose 3.4 points.');
        type(editor()!.querySelector<HTMLInputElement>('input[placeholder="Why you changed it (optional)"]')!, 'Table 2');
        click(Array.from(editor()!.querySelectorAll('button')).find((b) => b.textContent === 'Save')!);
        await flush();
        expect(cellEditing.onEdit).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'r1' }),
            expect.objectContaining({ id: 'effect' }),
            { op: 'answer', value: { kind: 'text', text: 'Enrollment rose 3.4 points.' }, note: 'Table 2' },
        );
        expect(editor()).toBeNull();
    });

    it('keeps the editor open with the refusal, and Escape (not while composing) cancels', async () => {
        const cellEditing = editing(vi.fn(async () => 'This row is no longer in the table.'));
        mount({ cellEditing });
        click(expand(cell('r1', 'effect'))!.querySelector('button[aria-label="Edit Headline effect"]')!);
        click(Array.from(editor()!.querySelectorAll('button')).find((b) => b.textContent === 'Save')!);
        await flush();
        expect(editor()!.querySelector('[role="alert"]')?.textContent).toBe('This row is no longer in the table.');
        const answer = editor()!.querySelector('textarea')!;
        key(answer, { key: 'Escape', isComposing: true });
        expect(editor()).not.toBeNull();
        key(answer, { key: 'Escape' });
        expect(editor()).toBeNull();
    });

    it('opens a Choice cell on its options, Not reported and Clear cell, each saving at once', async () => {
        const cellEditing = editing();
        mount({ cellEditing });
        click(expand(cell('r1', 'design'))!.querySelector('button[aria-label="Edit Design"]')!);
        const options = Array.from(editor()!.querySelectorAll('[role="option"]')).map((o) => o.textContent);
        expect(options).toEqual(['RCT', 'Not reported', 'Clear cell']);
        expect(editor()!.querySelector('[role="option"][aria-selected="true"]')?.textContent).toBe('RCT');
        click(Array.from(editor()!.querySelectorAll('[role="option"]')).find((o) => o.textContent === 'Not reported')!);
        await flush();
        expect(cellEditing.onEdit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'design' }), { op: 'not_reported' });
        expect(editor()).toBeNull();
    });

    const pencil = () => inspector()!.querySelector<HTMLButtonElement>('button[aria-label="Edit answer"]');
    const links = () => Array.from(inspector()!.querySelectorAll<HTMLButtonElement>('.rt-inspector-links button'));

    it("offers the Edit pencil beside Beaver's answer, and Reset to Beaver's answer under the user's", async () => {
        const cellEditing = editing();
        mount({ cellEditing });
        click(cell('r1', 'effect'));
        expect(pencil()!.closest('.rt-inspector-answer-row')).not.toBeNull();
        expect(links()).toEqual([]);
        expect(Array.from(inspector()!.querySelectorAll('.rt-inspector-action')).map((b) => b.textContent)).toEqual(['Change']);
        click(cell('r2', 'effect'));
        // The pencil sits on the user's answer, not on Beaver's earlier one.
        expect(inspector()!.querySelectorAll('button[aria-label="Edit answer"]')).toHaveLength(1);
        expect(pencil()!.closest('.rt-inspector-answer-section')!.textContent).toContain('Your answer');
        expect(links().map((b) => b.textContent)).toEqual(['Reset to Beaver’s answer']);
        click(links().find((b) => b.textContent === 'Reset to Beaver’s answer')!);
        expect(cellEditing.onRestore).toHaveBeenCalledWith(expect.objectContaining({ id: 'r2' }), expect.objectContaining({ id: 'effect' }));
        click(Array.from(inspector()!.querySelectorAll<HTMLButtonElement>('.rt-inspector-action')).find((b) => b.textContent === 'Change')!);
        expect(cellEditing.onChooseDocument).toHaveBeenCalledWith(expect.objectContaining({ id: 'r2' }));
        click(pencil()!);
        expect(editor()!.querySelector('textarea')!.value).toBe('Gains in consumption.');
        expect(editor()!.querySelector<HTMLInputElement>('input[placeholder="Why you changed it (optional)"]')!.value).toBe('Schooling was not an outcome.');
    });

    it("makes Beaver's own choice the user's when it is picked, so fills keep it", async () => {
        const cellEditing = editing();
        mount({ cellEditing });
        click(expand(cell('r1', 'design'))!.querySelector('button[aria-label="Edit Design"]')!);
        click(Array.from(editor()!.querySelectorAll('[role="option"]')).find((o) => o.textContent === 'RCT')!);
        await flush();
        expect(cellEditing.onEdit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'design' }), {
            op: 'answer',
            value: { kind: 'select', label: 'RCT' },
        });
    });

    it("opens the editor from the inspector on a hidden column, showing the column first", () => {
        mount({ cellEditing: editing() });
        click(cell('r1', 'amount'));
        act(() => {
            container!.querySelector<HTMLButtonElement>('button[aria-label="Column menu: Amount"]')!.click();
        });
        click(menuItem('Hide column')!);
        expect(container!.querySelector('th[data-column-id="amount"]')).toBeNull();
        click(pencil()!);
        expect(container!.querySelector('th[data-column-id="amount"]')).not.toBeNull();
        expect(editor()).not.toBeNull();
    });

    it('shows the cell controls disabled with the reason in a read-only library', () => {
        mount({ cellEditing: { ...editing(), disabledReason: 'This library is read-only.' } });
        const cellEdit = expand(cell('r1', 'effect'))!.querySelector<HTMLButtonElement>('button[aria-label="Edit Headline effect"]')!;
        expect(cellEdit.disabled).toBe(true);
        expect(cellEdit.title).toBe('This library is read-only.');
        click(cell('r2', 'effect'));
        const controls = [pencil()!, ...links(), ...Array.from(inspector()!.querySelectorAll<HTMLButtonElement>('.rt-inspector-action'))];
        expect(controls).toHaveLength(3);
        expect(controls.every((b) => b.disabled)).toBe(true);
    });

    it('offers Refill row and Choose document… in the row menu', () => {
        const fill = { onFillRows: vi.fn(), onFillColumn: vi.fn() };
        const cellEditing = editing();
        mount({ fill, cellEditing });
        click(expand(paperCell('r1'))!.querySelector('button[aria-label="Row actions"]')!);
        click(menuItem('Refill row')!);
        expect(fill.onFillRows).toHaveBeenCalledWith(['r1']);
        click(expand(paperCell('r1'))!.querySelector('button[aria-label="Row actions"]')!);
        click(menuItem('Choose document…')!);
        expect(cellEditing.onChooseDocument).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }));
    });

    it("offers Fill this column with its pending count, and the selection bar's Fill N rows", () => {
        const fill = { onFillRows: vi.fn(), onFillColumn: vi.fn() };
        mount({ fill, editing: { onEditColumn: vi.fn() } });
        click(container!.querySelector('button[aria-label="Column menu: Amount"]')!);
        click(menuItem('Fill this column (3)')!);
        expect(fill.onFillColumn).toHaveBeenCalledWith(expect.objectContaining({ id: 'amount' }));
        click(container!.querySelector('tr[data-row-id="r1"] button[aria-label="Select row"]')!);
        click(container!.querySelector('tr[data-row-id="r3"] button[aria-label="Select row"]')!);
        const fillRows = container!.querySelector<HTMLButtonElement>('.rt-selection-fill')!;
        expect(fillRows.textContent).toBe('Fill 2 rows');
        click(fillRows);
        expect(fill.onFillRows).toHaveBeenCalledWith(['r1', 'r3']);
    });

    it('hands the selected rows to the header controls', () => {
        const headerEnd = vi.fn((ids: string[]) => h('span', { className: 'selected-ids' }, ids.join(',')));
        mount({ headerEnd });
        click(container!.querySelector('tr[data-row-id="r2"] button[aria-label="Select row"]')!);
        expect(container!.querySelector('.selected-ids')?.textContent).toBe('r2');
    });
});

describe('the notice and the banner', () => {
    const banner = () => container!.querySelector<HTMLElement>('.bt-banner');
    const main = () => container!.querySelector<HTMLElement>('.rt-body > .rt-main');

    it('sit in the grid column, above the grid, with the side panel closed', () => {
        mount({ notice: 'Snapshot behind', banner: h('span', null, 'Filled 3 rows · 0.6 credits') });
        const column = main()!;
        expect(Array.from(column.children).map((el) => el.className)).toEqual(['bt-notice', 'bt-banner', 'bt-scroll rt-scroll']);
        expect(container!.querySelector('.rt-surface > .bt-banner, .rt-surface > .bt-notice')).toBeNull();
        expect(container!.querySelector('.rt-body')!.children).toHaveLength(1);
    });

    it('stay in the grid column beside an open cell inspector or version history', () => {
        mount({
            banner: h('span', null, 'Filled 3 rows · 0.6 credits'),
            renderVersionHistory: () => h('p', null, 'versions'),
        });
        click(cell('r1', 'effect'));
        const body = container!.querySelector('.rt-body')!;
        expect(Array.from(body.children).map((el) => el.tagName.toLowerCase() + '.' + el.classList[0])).toEqual(['div.rt-main', 'aside.rt-inspector']);
        expect(banner()!.parentElement).toBe(main());

        const more = container!.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')!;
        click(more);
        click(Array.from(document.querySelectorAll<HTMLElement>('*')).find((el) => el.textContent === 'Version history' && el.children.length === 0)!);
        expect(body.querySelector(':scope > aside.rt-history')).not.toBeNull();
        expect(banner()!.parentElement).toBe(main());
    });
});

describe('activity', () => {
    it("reports selecting a cell and changing the search, but not the table's first render", () => {
        const onActivity = vi.fn();
        mount({ onActivity });
        expect(onActivity).not.toHaveBeenCalled();
        click(cell('r1', 'effect'));
        expect(onActivity).toHaveBeenCalledTimes(1);
        const search = container!.querySelector<HTMLInputElement>('input[aria-label="Search rows"]')!;
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Baird');
            search.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(onActivity).toHaveBeenCalledTimes(2);
    });

    it('reports a sort from the column menu', () => {
        const onActivity = vi.fn();
        mount({ onActivity });
        click(container!.querySelector('button[aria-label="Column menu: Design"]')!);
        click(Array.from(document.querySelectorAll<HTMLElement>('*')).find((el) => el.textContent === 'Sort A → Z' && el.children.length === 0)!);
        expect(onActivity).toHaveBeenCalledTimes(1);
    });

    it('does not report a cell opened from outside', () => {
        const onActivity = vi.fn();
        mount({ onActivity, focus: { rowId: 'r2', columnId: 'design', token: 1 } });
        expect(inspector()).not.toBeNull();
        expect(onActivity).not.toHaveBeenCalled();
    });

    it('does not report the search a focus request clears to show its row', () => {
        const onActivity = vi.fn();
        mount({ onActivity });
        const search = container!.querySelector<HTMLInputElement>('input[aria-label="Search rows"]')!;
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'no row matches this');
            search.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(onActivity).toHaveBeenCalledTimes(1);
        act(() => root?.render(h(ResearchTable, { table: table(), onActivity, focus: { rowId: 'r2', columnId: 'design', token: 1 } })));
        expect(inspector()!.getAttribute('data-row-id')).toBe('r2');
        expect(search.value).toBe('');
        expect(onActivity).toHaveBeenCalledTimes(1);
    });
});
