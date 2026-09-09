// @vitest-environment jsdom

/**
 * How a row of controls collapses to fit, and what may expand it again.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useOverflowCollapse } from '@beaver/agent-ui/utils/useOverflowCollapse';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The box the hook reads; jsdom has no layout, so the widths are scripted.
 * Collapsing shrinks the row, so the content width is given per level.
 */
const box = { clientWidth: 300, neededAt: [300, 300, 300] };
let resizeCallbacks: Array<() => void> = [];
let latestLevel = -1;
let renders = 0;
let root: Root | null = null;
let container: HTMLDivElement;

class FakeResizeObserver {
    constructor(private readonly callback: () => void) {}
    observe() { resizeCallbacks.push(this.callback); }
    disconnect() { resizeCallbacks = resizeCallbacks.filter((cb) => cb !== this.callback); }
}

const Harness: React.FC<{ tick: number }> = () => {
    const { level, ref } = useOverflowCollapse(2);
    latestLevel = level;
    renders += 1;
    return React.createElement('div', { ref, 'data-testid': 'row' }, React.createElement('span', null, 'controls'));
};

function row(): HTMLDivElement {
    return container.querySelector('[data-testid="row"]') as HTMLDivElement;
}

/** Mount with the scripted box in place before the element attaches. */
function mount() {
    act(() => { root!.render(React.createElement(Harness, { tick: 0 })); });
}

/** A re-render with unchanged props: nothing about the row's box has changed. */
function rerender(tick: number) {
    act(() => { root!.render(React.createElement(Harness, { tick })); });
}

/** The container changed size: the resize observer reports it. */
function resize() {
    act(() => { resizeCallbacks.forEach((cb) => cb()); });
}

/** The row's content changed: the mutation observer reports it. */
async function mutateContent() {
    await act(async () => {
        row().querySelector('span')!.textContent = `controls ${Math.random()}`;
        await Promise.resolve();
    });
}

beforeEach(() => {
    (window as any).ResizeObserver = FakeResizeObserver;
    // jsdom lays nothing out; the row reads its scripted widths instead.
    Object.defineProperty(HTMLDivElement.prototype, 'clientWidth', { configurable: true, get: () => box.clientWidth });
    Object.defineProperty(HTMLDivElement.prototype, 'scrollWidth', {
        configurable: true,
        get: () => Math.max(box.clientWidth, box.neededAt[latestLevel < 0 ? 0 : latestLevel] ?? box.neededAt[box.neededAt.length - 1]),
    });
    resizeCallbacks = [];
    renders = 0;
    latestLevel = -1;
    box.clientWidth = 300;
    box.neededAt = [300, 300, 300];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => { root?.unmount(); });
    container.remove();
    delete (HTMLDivElement.prototype as any).clientWidth;
    delete (HTMLDivElement.prototype as any).scrollWidth;
});

describe('useOverflowCollapse', () => {
    it('stays at level 0 while the content fits', () => {
        mount();
        resize();
        rerender(1);
        expect(latestLevel).toBe(0);
    });

    it('is collapsed from its first paint when the row attaches too narrow', () => {
        box.neededAt = [340, 290, 280];
        mount();
        expect(latestLevel).toBe(1);
    });

    it('collapses further when content arriving in a fixed box overflows it', async () => {
        mount();
        expect(latestLevel).toBe(0);
        box.neededAt = [340, 320, 310];
        await mutateContent();
        // The level-1 content still overflows; its own re-layout is a mutation too.
        await mutateContent();
        expect(latestLevel).toBe(2);
        await mutateContent();
        expect(latestLevel).toBe(2);
    });

    it('does not expand on a content change alone, even when the box reads wide enough', async () => {
        box.neededAt = [340, 290, 280];
        mount();
        expect(latestLevel).toBe(1);
        // A container whose width follows its content reads "fits" once the
        // row has collapsed; taking that as a cue to expand would overflow it
        // again and loop.
        box.clientWidth = 350;
        await mutateContent();
        rerender(1);
        expect(latestLevel).toBe(1);
    });

    it('expands when the container has resized to the width the content needed', () => {
        box.neededAt = [340, 290, 280];
        mount();
        expect(latestLevel).toBe(1);
        box.clientWidth = 340;
        resize();
        expect(latestLevel).toBe(0);
    });

    it('keeps the level when the container resizes but is still narrower than the content needed', () => {
        box.neededAt = [340, 290, 280];
        mount();
        box.clientWidth = 330;
        resize();
        expect(latestLevel).toBe(1);
    });

    it('never renders for a measurement that changes nothing', () => {
        box.neededAt = [340, 290, 280];
        mount();
        const after = renders;
        for (let i = 0; i < 20; i++) resize();
        expect(renders).toBe(after);
        for (let i = 1; i <= 5; i++) rerender(i);
        expect(renders).toBe(after + 5);
        expect(latestLevel).toBe(1);
    });

    it('stops observing an element it has let go of', () => {
        mount();
        expect(resizeCallbacks.length).toBe(1);
        act(() => { root!.unmount(); });
        root = createRoot(container);
        expect(resizeCallbacks.length).toBe(0);
    });
});
