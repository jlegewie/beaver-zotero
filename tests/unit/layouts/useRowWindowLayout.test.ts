// @vitest-environment jsdom
/**
 * Row windowing forgets measured heights when the layout changes (density,
 * visible columns), so rows off screen are not counted at the old height.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { Row } from '@beaver/agent-core/layouts/table';
import { useRowWindow, type RowWindow } from '@beaver/agent-ui/layouts/useRowWindow';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const h = React.createElement;
const rows = Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, cells: {} })) as Row[];
let latest: RowWindow | null = null;
let rowHeight = 80;

function Harness({ layoutKey }: { layoutKey: string }) {
    const rootRef = React.useRef<HTMLDivElement | null>(null);
    const bodyRef = React.useRef<HTMLTableSectionElement | null>(null);
    const win = useRowWindow({ enabled: true, rows, expandedRows: new Set(), rootRef, bodyRef, layoutKey });
    latest = win;
    return h('div', { ref: rootRef },
        h('table', null,
            h('tbody', { ref: bodyRef },
                rows.slice(win.start, win.end).map((row) => h('tr', { key: row.id, 'data-row-id': row.id })))));
}

const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

afterEach(() => {
    if (originalHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalHeight);
});

describe('useRowWindow layout changes', () => {
    it('re-estimates the rows off screen when the layout key changes', () => {
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
            configurable: true,
            get() { return this.localName === 'tr' ? rowHeight : 0; },
        });
        const container = document.createElement('div');
        container.className = 'bt-scroll';
        Object.defineProperty(container, 'clientHeight', { configurable: true, value: 800 });
        document.body.appendChild(container);
        const root = createRoot(container);
        act(() => root.render(h(Harness, { layoutKey: 'tall' })));
        const tallBottom = latest!.padBottom;
        expect(tallBottom).toBeGreaterThan(0);

        rowHeight = 20;
        act(() => root.render(h(Harness, { layoutKey: 'compact' })));
        const compactBottom = latest!.padBottom;
        const rowsBelow = rows.length - latest!.end;
        // Every row below the window is counted at the new height.
        expect(compactBottom).toBeCloseTo(rowsBelow * 20, 0);

        act(() => root.unmount());
        container.remove();
    });
});
