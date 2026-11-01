// @vitest-environment jsdom
/**
 * A resize can rewrap the rows on screen without a React render. The window
 * must read their heights again, or a row that later scrolls out is replaced
 * by a spacer of its old height.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { Row } from '@beaver/agent-core/layouts/table';
import { useRowWindow, type RowWindow } from '@beaver/agent-ui/layouts/useRowWindow';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const h = React.createElement;
const ROW_PX = 40;
const rows = Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, cells: {} })) as Row[];
let latest: RowWindow | null = null;
let firstRowHeight = ROW_PX;

function Harness() {
    const rootRef = React.useRef<HTMLDivElement | null>(null);
    const bodyRef = React.useRef<HTMLTableSectionElement | null>(null);
    const win = useRowWindow({ enabled: true, rows, rootRef, bodyRef });
    latest = win;
    const trs = rows.slice(win.start, win.end).map((row) => h('tr', { key: row.id, 'data-row-id': row.id }));
    return h('div', { ref: rootRef }, h('table', null, h('tbody', { ref: bodyRef }, trs)));
}

const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
const originalRect = HTMLTableSectionElement.prototype.getBoundingClientRect;

afterEach(() => {
    if (originalHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalHeight);
    HTMLTableSectionElement.prototype.getBoundingClientRect = originalRect;
});

describe('useRowWindow resize', () => {
    it('re-measures the rows on screen before recomputing the window', () => {
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
            configurable: true,
            get() {
                if (this.localName !== 'tr') return 0;
                return this.getAttribute('data-row-id') === 'r0' ? firstRowHeight : ROW_PX;
            },
        });
        const container = document.createElement('div');
        container.className = 'bt-scroll';
        let scrollTop = 0;
        Object.defineProperty(container, 'clientHeight', { configurable: true, value: 800 });
        Object.defineProperty(container, 'scrollTop', { configurable: true, get: () => scrollTop });
        // The body moves up as the scroller scrolls.
        HTMLTableSectionElement.prototype.getBoundingClientRect = function () {
            return { top: -scrollTop } as DOMRect;
        };
        document.body.appendChild(container);
        const root = createRoot(container);
        act(() => root.render(h(Harness)));
        expect(latest!.start).toBe(0);

        // The viewport narrows: the first row rewraps taller, and nothing
        // re-renders.
        firstRowHeight = 400;
        act(() => { window.dispatchEvent(new Event('resize')); });

        scrollTop = 5000;
        act(() => { container.dispatchEvent(new Event('scroll')); });
        expect(latest!.start).toBeGreaterThan(0);
        // The spacer above counts the first row at its new height.
        const expectedTop = firstRowHeight + (latest!.start - 1) * ROW_PX;
        expect(latest!.padTop).toBeCloseTo(expectedTop, 0);

        act(() => root.unmount());
        container.remove();
    });
});
