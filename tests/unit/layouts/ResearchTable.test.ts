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
import type { TableFillCells } from '@beaver/agent-core/protocol/tableFillProtocol';
import { ResearchTable } from '@beaver/agent-ui/layouts/research/ResearchTable';
import { setHost } from '@beaver/agent-ui/host';
import { CitationReaderTargetContext } from '@beaver/agent-ui/chat/Citation';
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

function mount(props: Partial<React.ComponentProps<typeof ResearchTable>> = {}, readerTarget?: 'tab' | 'window') {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const grid = h(ResearchTable, {
        table: table(),
        documents: new Map([[pdf, { name: 'Baird_2011.pdf', kind: 'pdf' }]]),
        ...props,
    });
    act(() => root?.render(readerTarget ? h(CitationReaderTargetContext.Provider, { value: readerTarget }, grid) : grid));
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
        expect(container!.querySelector('.rt-sources-chip')?.textContent).toBe('1 source · 3 items');
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
        expect(paper.textContent).toContain('New item');
        // Authors, then the venue in italics on its own line; the year is its own column.
        expect(Array.from(paper.querySelectorAll('.rt-paper-meta')).map((line) => line.textContent)).toEqual(['Smith, Jones', 'QJE']);
        expect(paper.querySelector('.rt-paper-venue em')?.textContent).toBe('QJE');
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

    it('offers Excel and CSV exports, each in the view sort order', () => {
        const onExport = vi.fn();
        mount({ onExport });
        const menuItem = (label: string) =>
            Array.from(document.querySelectorAll<HTMLElement>('*')).find((el) => el.textContent === label && el.children.length === 0)!;
        const pick = (label: string) => {
            click(container!.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')!);
            click(menuItem(label));
        };
        pick('Export to Excel');
        click(container!.querySelector('button[aria-label="Column menu: Design"]')!);
        click(menuItem('Sort A → Z'));
        pick('Export CSV');
        expect(onExport.mock.calls).toEqual([
            ['xlsx', undefined],
            ['csv', { column_id: 'design', direction: 'asc' }],
        ]);
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
        // The expansion adds the year after the venue: the Year column scrolls away with the table.
        expect(Array.from(expansion.querySelectorAll('.rt-paper-full .rt-paper-meta')).map((line) => line.textContent)).toEqual([
            'Smith, Jones',
            'QJE · 2011',
        ]);
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
        // Drawn with the column's alignment, as the cell draws it.
        expect(expansion.querySelector('.rt-peek-body')!.classList.contains('bt-align-start')).toBe(true);
        expect(expansion.textContent).not.toContain('Click for evidence');
        // A read-only view has no actions: no footer.
        expect(expansion.querySelector('.rt-peek-footer')).toBeNull();
        // A click on the expansion opens the cell, as a click on the cell does.
        click(expansion.querySelector('.rt-peek')!);
        expect(peek()).toBeNull();
        expect(inspector()!.getAttribute('data-column-id')).toBe('design');
    });

    it('draws Yes / No as a marked pill, centred, in the cell and its expansion alike', () => {
        const spec = table();
        spec.columns.push({ id: 'rct', header: 'Randomized', type: 'boolean', description: 'Randomized?' });
        spec.rows[0].cells.rct = { outcome: 'answered', provenance: 'model', value: { kind: 'boolean', value: true }, documents: [pdf] } as Cell;
        spec.rows[1].cells.rct = { outcome: 'answered', provenance: 'model', value: { kind: 'boolean', value: false }, documents: [pdf] } as Cell;
        mount({ table: spec });
        expect(cell('r1', 'rct').querySelector('.rt-bool-yes svg')).not.toBeNull();
        expect(cell('r1', 'rct').querySelector('.rt-bool-yes')?.textContent).toBe('Yes');
        expect(cell('r2', 'rct').querySelector('.rt-bool-no')?.textContent).toBe('No');
        const expansion = expand(cell('r1', 'rct'))!;
        expect(expansion.querySelector('.rt-peek-body')!.classList.contains('bt-align-center')).toBe(true);
        expect(expansion.querySelector('.rt-bool-yes')?.textContent).toBe('Yes');
    });

    it('scrolls the grid with the whole wheel gesture that begins over an open expansion', () => {
        mount();
        const scroller = container!.querySelector<HTMLElement>('.rt-scroll')!;
        // jsdom loads no stylesheet: the grid's own overflow, inline.
        scroller.style.overflowY = 'auto';
        Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 });
        Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 });
        const scrollBy = vi.fn();
        scroller.scrollBy = scrollBy as never;
        const wheel = (el: Element, init: WheelEventInit = {}) => {
            const event = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true, screenX: 50, screenY: 50, ...init });
            act(() => {
                el.dispatchEvent(event);
            });
            return event;
        };
        const expansion = expand(cell('r1', 'effect'))!;
        vi.useFakeTimers();
        try {
            // The first event scrolls the grid beneath and closes the expansion.
            wheel(expansion.querySelector('.rt-peek-body')!);
            expect(scrollBy).toHaveBeenLastCalledWith({ left: 0, top: 120 });
            expect(peek()).toBeNull();
            // The browser keeps the rest of the gesture on the closed expansion,
            // which scrolls nothing: the grid scrolls with it here, and only here.
            const next = wheel(cell('r2', 'effect'), { deltaY: 3, deltaMode: 1 });
            expect(scrollBy).toHaveBeenCalledTimes(2);
            expect(scrollBy).toHaveBeenLastCalledWith({ left: 0, top: 48 });
            expect(next.defaultPrevented).toBe(true);
            // Once the wheel has rested, the browser scrolls the grid itself.
            act(() => {
                vi.advanceTimersByTime(1600);
            });
            expect(wheel(cell('r2', 'effect')).defaultPrevented).toBe(false);
            expect(scrollBy).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('ends the wheel gesture passed to the grid once the pointer moves', () => {
        mount();
        const scroller = container!.querySelector<HTMLElement>('.rt-scroll')!;
        scroller.style.overflowY = 'auto';
        Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 });
        Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 });
        const scrollBy = vi.fn();
        scroller.scrollBy = scrollBy as never;
        const expansion = expand(cell('r1', 'effect'))!;
        act(() => {
            expansion.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, screenX: 50, screenY: 50 }));
        });
        act(() => {
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, screenX: 90, screenY: 50 }));
        });
        const later = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true, screenX: 90, screenY: 50 });
        act(() => {
            cell('r2', 'effect').dispatchEvent(later);
        });
        expect(later.defaultPrevented).toBe(false);
        expect(scrollBy).toHaveBeenCalledTimes(1);
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
        expect(activation.readerTarget).toBeUndefined();
        // The tag opens the passage; it does not open the inspector.
        expect(inspector()).toBeNull();
    });

    it('opens the passage where the surface around the table asks', () => {
        mount({}, 'window');
        click(cell('r1', 'effect').querySelector('.rt-tag-page')!);
        expect(activateCitation.mock.calls[0][0].readerTarget).toBe('window');
    });
});

describe("a page tag's passage card", () => {
    // jsdom has no layout: a clamped passage reports its clamped height as
    // clientHeight and the whole passage as scrollHeight, as Gecko does.
    const fullHeight = { value: 0 };
    let restore: (() => void) | null = null;
    beforeEach(() => {
        const proto = HTMLElement.prototype;
        const client = Object.getOwnPropertyDescriptor(proto, 'clientHeight');
        const scroll = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
        Object.defineProperty(proto, 'clientHeight', {
            configurable: true,
            get(this: HTMLElement) {
                if (!this.classList.contains('rt-quote')) return 0;
                return this.classList.contains('rt-quote-clamped') ? Math.min(fullHeight.value, 133) : fullHeight.value;
            },
        });
        Object.defineProperty(proto, 'scrollHeight', {
            configurable: true,
            get(this: HTMLElement) {
                return this.classList.contains('rt-quote') ? fullHeight.value : 0;
            },
        });
        restore = () => {
            if (client) Object.defineProperty(proto, 'clientHeight', client);
            else delete (proto as { clientHeight?: number }).clientHeight;
            if (scroll) Object.defineProperty(proto, 'scrollHeight', scroll);
            else delete (proto as { scrollHeight?: number }).scrollHeight;
        };
    });
    afterEach(() => {
        restore?.();
        restore = null;
    });

    /** Opens the card of the effect cell's page tag, from the cell's expansion. */
    function openCard(quote: string): HTMLElement {
        const spec = table();
        spec.rows[0].cells.effect = model('Conditional transfers raised enrollment.', { evidence: [{ ...passage, quote }] });
        mount({ table: spec });
        const tag = expand(cell('r1', 'effect'))!.querySelector('.rt-tag-page')!;
        hoverPeek(tag, container!);
        return container!.querySelector<HTMLElement>('.bt-hover-card')!;
    }

    it('cuts a long passage to its first lines, and Show more reveals the rest', () => {
        fullHeight.value = 456;
        const card = openCard('A long passage. '.repeat(60));
        const quote = card.querySelector('.rt-quote')!;
        expect(quote.classList.contains('rt-quote-clamped')).toBe(true);
        const toggle = card.querySelector<HTMLButtonElement>('.rt-quote-toggle')!;
        expect(toggle.textContent).toBe('Show more');
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        click(toggle);
        expect(quote.classList.contains('rt-quote-clamped')).toBe(false);
        expect(toggle.textContent).toBe('Show less');
        click(toggle);
        expect(quote.classList.contains('rt-quote-clamped')).toBe(true);
        // The card stays open with the link to the passage.
        expect(container!.querySelector('.bt-hover-card .rt-link-button')?.textContent).toBe('Open in PDF');
    });

    it("closes when the pointer leaves the tag for elsewhere in the cell's expansion", () => {
        fullHeight.value = 40;
        openCard('Enrollment rose by 3.4 points.');
        const expansion = peek()!;
        const tag = expansion.querySelector<HTMLElement>('.rt-tag-page')!;
        const text = expansion.querySelector<HTMLElement>('.rt-peek-body')!;
        const move = (from: Element, to: Element) => {
            from.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: to }));
            to.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: from }));
        };
        vi.useFakeTimers();
        try {
            act(() => move(tag, text));
            act(() => vi.advanceTimersByTime(1000));
            expect(container!.querySelector('.bt-hover-card')).toBeNull();
            // The expansion itself stays while the pointer is over it.
            expect(peek()).not.toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('stays open from the tag onto the card, and closes alone when the pointer returns to the expansion', () => {
        fullHeight.value = 40;
        const card = openCard('Enrollment rose by 3.4 points.');
        const expansion = peek()!;
        const tag = expansion.querySelector<HTMLElement>('.rt-tag-page')!;
        const text = expansion.querySelector<HTMLElement>('.rt-peek-body')!;
        const move = (from: Element, to: Element) => {
            from.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: to }));
            to.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: from }));
        };
        vi.useFakeTimers();
        try {
            act(() => move(tag, card));
            act(() => vi.advanceTimersByTime(1000));
            expect(container!.querySelector('.bt-hover-card')).not.toBeNull();
            expect(peek()).not.toBeNull();
            // Back into the expansion: the card closes, the expansion stays.
            act(() => move(card, text));
            act(() => vi.advanceTimersByTime(1000));
            expect(container!.querySelector('.bt-hover-card')).toBeNull();
            expect(peek()).not.toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('shows a short passage whole, without a toggle', () => {
        fullHeight.value = 40;
        const card = openCard('Enrollment rose by 3.4 points.');
        expect(card.querySelector('.rt-quote')?.textContent).toBe('“Enrollment rose by 3.4 points.”');
        expect(card.querySelector('.rt-quote-toggle')).toBeNull();
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

    it('keeps rows scrolled into view below the sticky header as its height changes', () => {
        let headHeight = 64;
        let resized: (() => void) | undefined;
        const observed: Element[] = [];
        const win = window as unknown as { ResizeObserver?: unknown };
        const originalObserver = win.ResizeObserver;
        win.ResizeObserver = class {
            constructor(callback: () => void) {
                resized = callback;
            }
            observe(target: Element) {
                observed.push(target);
            }
            disconnect() {}
        };
        const offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
            configurable: true,
            get(this: HTMLElement) {
                return this.tagName === 'THEAD' ? headHeight : 0;
            },
        });
        try {
            mount();
            const scroller = container!.querySelector<HTMLElement>('.rt-scroll')!;
            expect(scroller.style.scrollPaddingTop).toBe('64px');
            // Wrapped column descriptions make the header taller.
            expect(observed).toContain(container!.querySelector('thead'));
            headHeight = 88;
            act(() => resized?.());
            expect(scroller.style.scrollPaddingTop).toBe('88px');
        } finally {
            win.ResizeObserver = originalObserver;
            if (offset) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offset);
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
        expect(panel.querySelector('.rt-inspector-body > .rt-inspector-section > .rt-inspector-question')?.textContent).toBe('The headline effect?');
        expect(panel.querySelector('.rt-inspector-answer')?.textContent).toBe('Conditional transfers raised enrollment.');
        // An answer read from the document has no source line: Evidence counts its passages.
        expect(panel.querySelector('.rt-inspector-answer-section .rt-tag')).toBeNull();
        expect(headings()).toEqual(['Question', 'Answer', 'Explanation', 'Evidence1']);
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
        expect(headings()).toEqual(['Question', 'Answer', 'Closest passages2']);
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
        expect(inspector()!.querySelector('.rt-inspector-answer-section .rt-tag-abstract')?.textContent).toBe('Abstract only');
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
        expect(headings()).toEqual(['Question', 'Your answer', 'Beaver’s answer', 'Explanation', 'Evidence1']);
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
        expect(inspector()!.textContent).not.toContain('New item');
        click(paperCell('r3'));
        expect(inspector()!.querySelector('.rt-inspector-note')?.textContent).toBe('New item: added since the last fill.');
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
        expect(container!.querySelector<HTMLButtonElement>('th.rt-th-add button[aria-label="Add column"]')!.disabled).toBe(true);
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
        click(container!.querySelector('th.rt-th-add button[aria-label="Add column"]')!);
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

    it('offers + Column in the toolbar, which adds a column like (+)', () => {
        const onAddColumn = vi.fn();
        mount({ editing: { onAddColumn, toolbarActions: h('button', { className: 'probe-items' }, 'Items') } });
        const toolbar = container!.querySelector('.rt-toolbar-left')!;
        const button = toolbar.querySelector<HTMLButtonElement>('button.rt-add-column-action')!;
        expect(button.textContent).toBe('Column');
        expect(button.getAttribute('aria-label')).toBe('Add column');
        // After the host's own actions (+ Items).
        expect(toolbar.querySelector('.probe-items')!.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        click(button);
        expect(onAddColumn).toHaveBeenCalledTimes(1);
    });

    it('offers no + Column on a display-only table', () => {
        mount();
        expect(container!.querySelector('.rt-add-column-action')).toBeNull();
    });

    it('disables both Add column controls with the reason at the column limit', () => {
        const full = table();
        full.columns = [
            ...full.columns,
            ...Array.from({ length: 17 }, (_, i) => ({ id: `extra${i}`, header: `Extra ${i}`, type: 'text' }) as TableSpec['columns'][number]),
        ];
        mount({ table: full, editing: { onAddColumn: vi.fn() } });
        const reason = 'A table holds at most 20 question columns. Remove a column to add another.';
        const toolbarButton = container!.querySelector<HTMLButtonElement>('.rt-add-column-action')!;
        expect(toolbarButton.disabled).toBe(true);
        expect(toolbarButton.parentElement!.title).toBe(reason);
        const plus = container!.querySelector<HTMLButtonElement>('th.rt-th-add button')!;
        expect(plus.disabled).toBe(true);
        expect(plus.closest('th')!.title).toBe(reason);
    });

    it('shows the read-only reason on + Column before the limit', () => {
        mount({ editing: { disabledReason: 'This library is read-only.', onAddColumn: vi.fn() } });
        const button = container!.querySelector<HTMLButtonElement>('.rt-add-column-action')!;
        expect(button.disabled).toBe(true);
        expect(button.parentElement!.title).toBe('This library is read-only.');
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

describe('Category columns', () => {
    const withOptions = (labels: string[]) => {
        const spec = table();
        spec.columns = spec.columns.map((column) =>
            column.id === 'design' ? { ...column, options: labels.map((label) => ({ label, color: 'green' as const })) } : column,
        );
        return spec;
    };
    /** The design column's width: after the rail, the paper, the year and Headline effect. */
    const designWidth = () => container!.querySelectorAll<HTMLElement>('colgroup col')[4].style.width;

    it('sizes the column to its longest category, within bounds', () => {
        mount();
        expect(designWidth()).toBe('9rem');
        act(() => root?.render(h(ResearchTable, { table: withOptions(['RCT', 'Observational regression']) })));
        expect(designWidth()).toBe('14.4rem');
        act(() => root?.render(h(ResearchTable, { table: withOptions(['RCT', 'Decomposition/counterfactual analysis of outcomes']) })));
        expect(designWidth()).toBe('16rem');
    });

    it('draws the answer as a pill that wraps rather than clipping', () => {
        mount();
        expect(cell('r1', 'design').querySelector('.bt-pill')?.classList.contains('rt-choice')).toBe(true);
    });

    it("opens a Category cell's expansion wider than its narrow column, and a text cell's at the cell's width", () => {
        mount();
        expect(expand(cell('r1', 'design'))!.style.width).toBe('224px');
        act(() => root?.render(h(ResearchTable, { table: table() })));
        expect(expand(cell('r1', 'effect'))!.style.width).not.toBe('224px');
    });
});

describe('rows the user just added', () => {
    const scrolled = vi.fn();
    beforeEach(() => {
        scrolled.mockReset();
        HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, options?: ScrollIntoViewOptions) {
            scrolled(this.getAttribute('data-row-id'), options);
        } as never;
    });
    afterEach(() => {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
        vi.useRealTimers();
    });
    const added = () => Array.from(container!.querySelectorAll('tr.rt-row-added')).map((row) => row.getAttribute('data-row-id'));
    const showAdded = () => container!.querySelector<HTMLButtonElement>('.rt-hidden-added');
    const render = (props: Partial<React.ComponentProps<typeof ResearchTable>>, spec = table()) =>
        act(() => root?.render(h(ResearchTable, { table: spec, ...props })));
    const search = (text: string) => {
        const input = container!.querySelector<HTMLInputElement>('input[aria-label="Search rows"]')!;
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        return input;
    };

    it("highlights them for a moment and scrolls to the first in the view's order", () => {
        vi.useFakeTimers();
        mount({ reveal: { rowIds: ['r3', 'r2'], token: 1 } });
        expect(added()).toEqual(['r2', 'r3']);
        expect(scrolled).toHaveBeenCalledWith('r2', { block: 'center' });
        act(() => vi.advanceTimersByTime(2000));
        expect(added()).toEqual([]);
    });

    it('waits for the table that has them', () => {
        mount();
        const grown = table();
        grown.rows = [...grown.rows, { id: 'r4', ref: { kind: 'item', library_ref: 'u', zotero_key: 'DDDD4444', library_id: 1 }, cells: {} }];
        render({ reveal: { rowIds: ['r4'], token: 1 } });
        expect(added()).toEqual([]);
        render({ reveal: { rowIds: ['r4'], token: 1 } }, grown);
        expect(added()).toEqual(['r4']);
        expect(scrolled).toHaveBeenCalledWith('r4', { block: 'center' });
    });

    it('offers rows the search hides behind Show, keeping the search until the user asks', () => {
        mount();
        const input = search('Baird');
        render({ reveal: { rowIds: ['r3'], token: 1 } });
        expect(added()).toEqual([]);
        expect(scrolled).not.toHaveBeenCalled();
        expect(showAdded()?.textContent).toBe('1 added item hidden · Show');
        expect(input.value).toBe('Baird');

        click(showAdded()!);
        expect(input.value).toBe('');
        expect(added()).toEqual(['r3']);
        expect(scrolled).toHaveBeenCalledWith('r3', { block: 'center' });
        expect(showAdded()).toBeNull();
    });

    it('forgets the hidden rows once the user changes the search', () => {
        mount();
        search('Baird');
        render({ reveal: { rowIds: ['r2', 'r3'], token: 1 } });
        expect(showAdded()?.textContent).toBe('2 added items hidden · Show');
        search('Bai');
        expect(showAdded()).toBeNull();
    });
});

describe('columns the user just added', () => {
    const scroller = () => container!.querySelector<HTMLElement>('.rt-scroll')!;
    const render = (props: Partial<React.ComponentProps<typeof ResearchTable>>, spec = table()) =>
        act(() => root?.render(h(ResearchTable, { table: spec, ...props })));
    const grown = () => {
        const spec = table();
        spec.columns = [...spec.columns, { id: 'sample', header: 'Sample', type: 'text', description: 'How many?' }];
        return spec;
    };
    const headers = () => Array.from(container!.querySelectorAll('th.rt-th-added')).map((th) => th.getAttribute('data-column-id'));
    const cols = () => container!.querySelectorAll('col.rt-col-added').length;
    const rect = (left: number, right: number) =>
        ({ left, right, top: 0, bottom: 40, width: right - left, height: 40, x: left, y: 0, toJSON() {} }) as DOMRect;
    const original = HTMLElement.prototype.getBoundingClientRect;
    let scrollLeft = 0;
    let sample = rect(900, 1200);
    beforeEach(() => {
        scrollLeft = 0;
        sample = rect(900, 1200);
        // The grid is 600 px wide (its box is 620 with the scrollbar) and the
        // new column sits past its right edge.
        HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
            if (this.classList.contains('rt-scroll')) return rect(0, 620);
            if (this.getAttribute('data-column-id') === 'sample') return sample;
            return rect(0, 0);
        };
    });
    afterEach(() => {
        HTMLElement.prototype.getBoundingClientRect = original;
        vi.useRealTimers();
    });
    const mountScroller = () => {
        mount();
        Object.defineProperty(scroller(), 'clientWidth', { configurable: true, get: () => 600 });
        Object.defineProperty(scroller(), 'scrollLeft', {
            configurable: true,
            get: () => scrollLeft,
            set: (value: number) => {
                scrollLeft = value;
            },
        });
    };

    it('waits for the table that has the column, then scrolls sideways to it and highlights it for a moment', () => {
        vi.useFakeTimers();
        mountScroller();
        const scrollTop = scroller().scrollTop;
        render({ reveal: { columnIds: ['sample'], token: 1 } });
        expect(headers()).toEqual([]);
        expect(scrollLeft).toBe(0);

        render({ reveal: { columnIds: ['sample'], token: 1 } }, grown());
        expect(headers()).toEqual(['sample']);
        expect(cols()).toBe(1);
        // Its right edge to the grid's, inside the scrollbar; rows stay where they were.
        expect(scrollLeft).toBe(600);
        expect(scroller().scrollTop).toBe(scrollTop);
        act(() => vi.advanceTimersByTime(2000));
        expect(headers()).toEqual([]);
        expect(cols()).toBe(0);
    });

    it('shows the start of a column wider than the grid', () => {
        sample = rect(700, 1500);
        mountScroller();
        render({ reveal: { columnIds: ['sample'], token: 1 } }, grown());
        expect(scrollLeft).toBe(700);
    });

    it('leaves the scroll alone for a column already in view, and still highlights it', () => {
        sample = rect(300, 500);
        mountScroller();
        render({ reveal: { columnIds: ['sample'], token: 1 } }, grown());
        expect(scrollLeft).toBe(0);
        expect(headers()).toEqual(['sample']);
    });

    it('reveals each request once', () => {
        mountScroller();
        render({ reveal: { columnIds: ['sample'], token: 1 } }, grown());
        scrollLeft = 0;
        render({ reveal: { columnIds: ['sample'], token: 1 } }, grown());
        expect(scrollLeft).toBe(0);
        render({ reveal: { columnIds: ['sample'], token: 2 } }, grown());
        expect(scrollLeft).toBe(600);
    });
});

describe('search', () => {
    const shownRows = () =>
        Array.from(container!.querySelectorAll<HTMLElement>('tbody tr[data-row-id]')).map((row) => row.dataset.rowId);
    const hits = (el: Element = container!) => Array.from(el.querySelectorAll('mark.beaver-find-hit')).map((mark) => mark.textContent);
    const search = (text: string) => {
        const input = container!.querySelector<HTMLInputElement>('input[aria-label="Search rows"]')!;
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };
    const withExtras = () => {
        const spec = table();
        spec.columns.push(
            { id: '_identifier', header: 'DOI', type: 'text', system: true },
            { id: 'girls', header: 'Girls only', type: 'boolean' },
        );
        spec.rows[0].cells._identifier = { outcome: 'answered', provenance: 'system', value: { kind: 'text', text: '10.1093/qje/qjr032' } } as Cell;
        spec.rows[0].cells.girls = { outcome: 'answered', provenance: 'model', value: { kind: 'boolean', value: true } } as Cell;
        spec.rows[1].cells.girls = { outcome: 'answered', provenance: 'model', value: { kind: 'boolean', value: false } } as Cell;
        return spec;
    };

    it('shows the rows that hold every word, in any of their columns', () => {
        mount();
        search('baird ENROLLMENT');
        expect(shownRows()).toEqual(['r1']);
        search('baird consumption');
        expect(shownRows()).toEqual([]);
        search('smith');
        expect(shownRows()).toEqual(['r1', 'r2', 'r3']);
    });

    it('reads a quoted phrase as one term', () => {
        mount();
        search('"raised enrollment"');
        expect(shownRows()).toEqual(['r1']);
        search('"enrollment raised"');
        expect(shownRows()).toEqual([]);
    });

    it('matches a Yes / No answer as the grid shows it', () => {
        mount({ table: withExtras() });
        search('yes');
        expect(shownRows()).toEqual(['r1']);
        expect(hits(cell('r1', 'girls'))).toEqual(['Yes']);
        search('true');
        expect(shownRows()).toEqual([]);
    });

    it('does not match columns the grid does not show', () => {
        mount({ table: withExtras() });
        search('qjr032');
        expect(shownRows()).toEqual([]);
    });

    it('marks the words wherever the grid shows them', () => {
        mount();
        search('baird 2011 rct enrollment qje');
        expect(shownRows()).toEqual(['r1']);
        expect(hits(paperCell('r1'))).toEqual(['Baird', '2011', 'QJE']);
        expect(hits(container!.querySelector('tr[data-row-id="r1"] td.rt-td-year')!)).toEqual(['2011']);
        expect(hits(cell('r1', 'design'))).toEqual(['RCT']);
        expect(hits(cell('r1', 'effect'))).toEqual(['enrollment']);
    });

    it('marks the words in a cell\'s expansion and the inspector', () => {
        mount();
        search('enrollment');
        expect(hits(expand(cell('r1', 'effect'))!)).toEqual(['enrollment']);
        click(cell('r1', 'effect'));
        expect(hits(inspector()!)).toContain('enrollment');
    });

    it("marks the words in a paper's title and byline in the paper view", () => {
        mount();
        search('baird smith');
        click(paperCell('r1'));
        expect(hits(inspector()!.querySelector('.rt-inspector-head')!)).toEqual(['Baird', 'Smith']);
    });

    it('marks nothing for a one-letter word, and nothing once the search is cleared', () => {
        mount();
        search('t');
        expect(shownRows()).toEqual(['r1', 'r2', 'r3']);
        expect(hits()).toEqual([]);
        search('baird');
        expect(hits()).toEqual(['Baird']);
        search('');
        expect(hits()).toEqual([]);
    });
});

describe('sorting', () => {
    const rowOrder = () =>
        Array.from(container!.querySelectorAll<HTMLElement>('tbody tr[data-row-id]')).map((row) => row.dataset.rowId);
    const header = (columnId: string) => container!.querySelector<HTMLElement>(`th[data-column-id="${columnId}"]`)!;
    const sortedHeaders = () =>
        Array.from(container!.querySelectorAll<HTMLElement>('th[aria-sort]')).map((th) => [th.dataset.columnId, th.getAttribute('aria-sort')]);
    const withYears = () => {
        const spec = table();
        spec.rows[2].cells._year = { outcome: 'answered', provenance: 'system', value: { kind: 'date', value: '2015' } } as Cell;
        return spec;
    };

    it('sorts by the item from its header menu, A → Z and Z → A', () => {
        mount();
        click(container!.querySelector('button[aria-label="Column menu: Item"]')!);
        click(menuEntry('Sort A → Z')!);
        expect(rowOrder()).toEqual(['r1', 'r3', 'r2']);
        click(container!.querySelector('button[aria-label="Column menu: Item"]')!);
        click(menuEntry('Sort Z → A')!);
        expect(rowOrder()).toEqual(['r2', 'r3', 'r1']);
    });

    it('sorts by the year from its header menu, newest first, with rows without a year last', () => {
        mount({ table: withYears() });
        click(container!.querySelector('button[aria-label="Column menu: Year"]')!);
        click(menuEntry('Sort newest first')!);
        expect(rowOrder()).toEqual(['r3', 'r1', 'r2']);
        click(container!.querySelector('button[aria-label="Column menu: Year"]')!);
        click(menuEntry('Sort oldest first')!);
        expect(rowOrder()).toEqual(['r1', 'r3', 'r2']);
    });

    it('marks the sorted column only, with its direction', () => {
        mount();
        expect(sortedHeaders()).toEqual([]);
        expect(container!.querySelector('.rt-th-sort')).toBeNull();
        click(container!.querySelector('button[aria-label="Column menu: Design"]')!);
        click(menuEntry('Sort Z → A')!);
        expect(sortedHeaders()).toEqual([['design', 'descending']]);
        expect(header('design').querySelector('.rt-th-sort')?.getAttribute('title')).toBe('Sorted Z → A');
        click(container!.querySelector('button[aria-label="Column menu: Year"]')!);
        click(menuEntry('Sort oldest first')!);
        expect(sortedHeaders()).toEqual([['_year', 'ascending']]);
        expect(header('_year').querySelector('.rt-th-sort')?.getAttribute('title')).toBe('Sorted oldest first');
    });

    it("clears the sort from the sorted column's menu", () => {
        mount();
        click(container!.querySelector('button[aria-label="Column menu: Item"]')!);
        expect(menuEntry('Clear sort')).toBeUndefined();
        click(menuEntry('Sort Z → A')!);
        click(container!.querySelector('button[aria-label="Column menu: Item"]')!);
        click(menuEntry('Clear sort')!);
        expect(rowOrder()).toEqual(['r1', 'r2', 'r3']);
        expect(sortedHeaders()).toEqual([]);
    });

    it('names the paper column Item in the toolbar Sort menu and its label', () => {
        mount();
        click(container!.querySelector('button[aria-label="Sort rows"]')!);
        const entries = Array.from(document.querySelectorAll<HTMLElement>('.bt-menu-check span:last-child')).map((el) => el.textContent);
        expect(entries.slice(0, 2)).toEqual(['Item', 'Year']);
        click(menuEntry('Item')!);
        expect(container!.querySelector('button[aria-label="Sort rows"]')!.textContent).toBe('Sort: Item ↑');
    });

    it('keeps offering the item and the year for a different table in the same view', () => {
        mount();
        const other = table();
        other.id = 'other';
        other.key = 'OTHERKEY';
        act(() => root?.render(h(ResearchTable, { table: other })));
        expect(container!.querySelector('button[aria-label="Column menu: Year"]')).not.toBeNull();
        click(container!.querySelector('button[aria-label="Sort rows"]')!);
        const entries = Array.from(document.querySelectorAll<HTMLElement>('.bt-menu-check span:last-child')).map((el) => el.textContent);
        expect(entries.slice(0, 2)).toEqual(['Item', 'Year']);
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

describe('a running fill', () => {
    const rerender = (props: Partial<React.ComponentProps<typeof ResearchTable>>) =>
        act(() => root?.render(h(ResearchTable, { table: table(), ...props })));
    /** r1 waits its turn on Headline effect; r3 is being answered on Headline effect and Amount. */
    const running: TableFillCells[] = [
        { columns: ['effect'], queued: ['r1'], active: [] },
        { columns: ['effect', 'amount'], queued: [], active: ['r3'] },
    ];
    const answered = (): TableSpec => {
        const spec = table();
        spec.rows[2].cells.effect = model('Enrollment rose.');
        return spec;
    };

    it('marks only the cells it will write: still while queued, shimmering while answered', () => {
        mount({ filling: running });
        expect(cell('r1', 'effect').dataset.fill).toBe('queued');
        expect(cell('r3', 'effect').dataset.fill).toBe('active');
        expect(cell('r3', 'amount').dataset.fill).toBe('active');
        expect(cell('r3', 'amount').getAttribute('aria-busy')).toBe('true');
        for (const [row, column] of [['r1', 'design'], ['r1', 'amount'], ['r2', 'effect'], ['r3', 'design']]) {
            expect(cell(row, column).hasAttribute('data-fill')).toBe(false);
        }
        // Empty or answered, every cell it will write shows placeholder lines.
        expect(cell('r3', 'effect').querySelectorAll('.rt-fill-line')).toHaveLength(3);
        expect(cell('r1', 'effect').querySelectorAll('.rt-fill-line')).toHaveLength(3);
        expect(cell('r1', 'effect').textContent).not.toContain('Conditional transfers raised enrollment.');
    });

    it('says what the fill is doing in the expansion and the inspector', () => {
        mount({ filling: running });
        expect(expand(cell('r3', 'effect'))!.querySelector('.rt-peek-body')?.textContent).toBe('Beaver is answering this now.');
        expect(expand(cell('r1', 'effect'))!.querySelector('.rt-peek-body')?.textContent).toContain(
            'Beaver answers this again later in this fill.Conditional transfers raised enrollment.',
        );
        click(cell('r3', 'effect'));
        expect(inspector()!.textContent).toContain('Beaver is answering this now.');
        expect(inspector()!.textContent).not.toContain('Not filled yet');
    });

    it('lands the whole row when its answers arrive before the news of the fill', () => {
        vi.useFakeTimers();
        try {
            mount({ filling: running });
            rerender({ table: answered(), filling: running });
            expect(cell('r3', 'effect').dataset.fill).toBe('landed');
            expect(cell('r3', 'effect').textContent).toContain('Enrollment rose.');
            // Saved in the same commit with nothing new in it: done too.
            expect(cell('r3', 'amount').hasAttribute('data-fill')).toBe(false);
            act(() => vi.advanceTimersByTime(1500));
            // The job still lists the row for a moment: it does not fill again.
            expect(cell('r3', 'effect').hasAttribute('data-fill')).toBe(false);
            expect(cell('r3', 'amount').hasAttribute('data-fill')).toBe(false);
            rerender({ table: answered(), filling: [running[0]] });
            expect(cell('r3', 'amount').hasAttribute('data-fill')).toBe(false);
            expect(cell('r1', 'effect').dataset.fill).toBe('queued');
        } finally {
            vi.useRealTimers();
        }
    });

    it("keeps an open expansion's note in step with the job", () => {
        mount({ filling: running });
        const open = expand(cell('r1', 'effect'))!;
        expect(open.querySelector('.rt-fill-note')?.textContent).toBe('Beaver answers this again later in this fill.');
        rerender({ filling: [{ columns: ['effect'], queued: [], active: ['r1'] }, running[1]] });
        expect(peek()!.querySelector('.rt-fill-note')?.textContent).toBe(
            'Beaver is answering this again. This answer stays until the new one is saved.',
        );
        rerender({ filling: [running[1]] });
        expect(peek()!.querySelector('.rt-fill-note')).toBeNull();
    });

    it('keeps a let-go cell filling until the table holding its answer arrives', () => {
        const before = table();
        mount({ table: before, filling: running });
        // The news first: the same table is on screen, so the answer is still coming.
        rerender({ table: before, filling: [] });
        expect(cell('r3', 'effect').dataset.fill).toBe('active');
        rerender({ table: answered(), filling: [] });
        expect(cell('r3', 'effect').dataset.fill).toBe('landed');
        // A cell the reload left unchanged (a failure, the same answer) stops filling.
        expect(cell('r3', 'amount').hasAttribute('data-fill')).toBe(false);
    });

    it('lets a queued cell go at once when the fill stops', () => {
        mount({ filling: running });
        rerender({ filling: [running[1]] });
        expect(cell('r1', 'effect').hasAttribute('data-fill')).toBe(false);
        expect(cell('r3', 'effect').dataset.fill).toBe('active');
    });
});

describe('selecting and copying text', () => {
    /** Selects the text of `el`, as a drag over it would. */
    const selectText = (el: Element) => {
        const selection = window.getSelection()!;
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
    };
    const copyButton = () => peek()!.querySelector<HTMLButtonElement>('button[aria-label="Copy answer"]');
    const pressCopy = () =>
        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true }));
        });

    afterEach(() => window.getSelection()?.removeAllRanges());

    it("copies a cell's answer from the icon before Edit, keeping the expansion open", () => {
        const onCopy = vi.fn();
        mount({ onCopy, cellEditing: { onEdit: vi.fn() } as never });
        expand(cell('r1', 'effect'));
        const buttons = peekButtons();
        expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Copy answer', 'Edit Headline effect']);
        // Icon only.
        expect(buttons[0].textContent).toBe('');
        click(buttons[0]);
        expect(onCopy).toHaveBeenCalledWith('Conditional transfers raised enrollment.');
        expect(peek()).not.toBeNull();
        expect(inspector()).toBeNull();
        expect(peekButtons()[0].getAttribute('aria-label')).toBe('Copied');
    });

    it('copies a Category answer as its label, and offers no Copy without an answer', () => {
        const onCopy = vi.fn();
        mount({ onCopy });
        expand(cell('r1', 'design'));
        click(copyButton()!);
        expect(onCopy).toHaveBeenCalledWith('RCT');
        act(() => {
            peek()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        // Not reported: nothing to copy, and with no Edit, no footer.
        expect(expand(cell('r2', 'design'))!.querySelector('.rt-peek-footer')).toBeNull();
    });

    it('does not open the cell when a click ends selecting text in it or its expansion', () => {
        mount();
        const expansion = expand(cell('r1', 'effect'))!;
        selectText(expansion.querySelector('.rt-text')!);
        click(expansion.querySelector('.rt-peek')!);
        expect(peek()).not.toBeNull();
        expect(inspector()).toBeNull();
        selectText(cell('r1', 'effect').querySelector('.rt-text')!);
        click(cell('r1', 'effect'));
        expect(inspector()).toBeNull();
        // A plain click still opens it.
        window.getSelection()!.removeAllRanges();
        click(cell('r1', 'effect'));
        expect(inspector()).not.toBeNull();
    });

    it('keeps an expansion open while it holds a selection, and closes it once the selection goes', () => {
        mount();
        const expansion = expand(cell('r1', 'effect'))!;
        selectText(expansion.querySelector('.rt-text')!);
        vi.useFakeTimers();
        try {
            act(() => {
                expansion.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
            });
            act(() => {
                vi.advanceTimersByTime(1000);
            });
            expect(peek()).not.toBeNull();
            act(() => {
                window.getSelection()!.removeAllRanges();
                document.dispatchEvent(new Event('selectionchange'));
            });
            expect(peek()).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps an expansion holding a selection when the pointer crosses another cell', () => {
        mount();
        const expansion = expand(cell('r1', 'effect'))!;
        selectText(expansion.querySelector('.rt-text')!);
        expect(expand(cell('r1', 'amount'))).toBe(expansion);
        expect(expansion.textContent).toContain('Conditional transfers raised enrollment.');
    });

    it('opens no expansion or tip while text is selected, which opening it would collapse', () => {
        mount();
        // Grid text selected: hovering another cell opens no expansion.
        selectText(cell('r1', 'effect').querySelector('.rt-text')!);
        expect(expand(cell('r1', 'amount'))).toBeNull();
        window.getSelection()!.removeAllRanges();
        // Expansion text selected: hovering its page tag opens no card.
        const expansion = expand(cell('r1', 'effect'))!;
        selectText(expansion.querySelector('.rt-text')!);
        hoverPeek(expansion.querySelector('.rt-tag-page')!, container!);
        expect(document.querySelector('.bt-hover-card')).toBeNull();
        expect(peek()).toBe(expansion);
    });

    it('selects a passage without opening it, and opens it with a plain click or Enter', () => {
        mount();
        click(cell('r1', 'effect'));
        const passageEl = inspector()!.querySelector<HTMLElement>('.rt-passage[role="button"]')!;
        selectText(passageEl.querySelector('.rt-passage-text')!);
        click(passageEl);
        expect(activateCitation).not.toHaveBeenCalled();
        window.getSelection()!.removeAllRanges();
        click(passageEl);
        expect(activateCitation).toHaveBeenCalledTimes(1);
        act(() => {
            passageEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        expect(activateCitation).toHaveBeenCalledTimes(2);
    });

    it("selects a paper-view answer without opening its cell", () => {
        mount();
        click(paperCell('r1'));
        const block = inspector()!.querySelector<HTMLElement>('.rt-paper-question[data-column-id="effect"]')!;
        selectText(block.querySelector('.rt-paper-question-value')!);
        click(block.querySelector('.rt-paper-question-value')!);
        expect(inspector()!.getAttribute('data-view')).toBe('paper');
        window.getSelection()!.removeAllRanges();
        click(block.querySelector('.rt-paper-question-value')!);
        expect(inspector()!.getAttribute('data-column-id')).toBe('effect');
    });

    it('copies the selected text with Cmd+C and from the context menu, within the table only', () => {
        const onCopy = vi.fn();
        mount({ onCopy });
        // The expansion, drawn beside the surface.
        selectText(expand(cell('r1', 'design'))!.querySelector('.rt-peek-body .bt-pill')!);
        pressCopy();
        expect(onCopy).toHaveBeenLastCalledWith('RCT');
        onCopy.mockClear();
        window.getSelection()!.removeAllRanges();
        click(cell('r1', 'effect'));
        selectText(inspector()!.querySelector('.rt-inspector-reasoning')!);
        pressCopy();
        expect(onCopy).toHaveBeenLastCalledWith('Table 2 reports it.');
        act(() => {
            inspector()!
                .querySelector('.rt-inspector-reasoning')!
                .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
        });
        click(menuEntry('Copy')!);
        expect(onCopy).toHaveBeenCalledTimes(2);
        const outside = document.createElement('p');
        outside.textContent = 'Elsewhere';
        document.body.appendChild(outside);
        selectText(outside);
        pressCopy();
        expect(onCopy).toHaveBeenCalledTimes(2);
        outside.remove();
    });
});
