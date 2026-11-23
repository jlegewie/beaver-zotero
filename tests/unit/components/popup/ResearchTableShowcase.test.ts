// @vitest-environment jsdom

/**
 * The research table showcase: a table filled on a loop, then an answer's passage.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ResearchTableShowcase from '../../../../react/components/ui/popup/showcases/ResearchTableShowcase';

let root: Root | null = null;
let container: HTMLDivElement;

function mount() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => { root!.render(React.createElement(ResearchTableShowcase)); });
}

const text = () => container.textContent ?? '';
const cellsFilling = (fill: string) => container.querySelectorAll(`.rt-cell[data-fill="${fill}"]`).length;
const evidenceCard = () => container.querySelector('.rt-evidence-card');

/** Plays until the condition holds, or fails if it never does. */
function playUntil(condition: () => boolean, maxMs = 30_000) {
    let elapsed = 0;
    while (!condition() && elapsed < maxMs) {
        act(() => { vi.advanceTimersByTime(50); });
        elapsed += 50;
    }
    expect(condition()).toBe(true);
}

beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    container.remove();
    vi.useRealTimers();
});

describe('ResearchTableShowcase', () => {
    it('fills the table, shows an answer\'s passage, and starts over', () => {
        mount();
        expect(text()).toContain('Fill 24 rows');
        expect(container.querySelectorAll('.bt-pill')).toHaveLength(0);

        playUntil(() => cellsFilling('active') > 0);
        expect(text()).toContain('0 of 24 filled');

        playUntil(() => cellsFilling('landed') > 0);
        expect(text()).toContain('RCT');

        playUntil(() => text().includes('24 of 24 filled'));
        expect(container.querySelectorAll('.bt-pill')).toHaveLength(4);
        expect(container.querySelectorAll('.rt-tag-page')).toHaveLength(4);

        playUntil(() => evidenceCard() !== null);
        expect(evidenceCard()?.textContent).toContain('Page 855');
        expect(evidenceCard()?.textContent).toContain('Open in PDF');

        playUntil(() => text().includes('Fill 24 rows'));
        expect(evidenceCard()).toBeNull();
    });

    it('takes nothing with it: no pointer, no focus, no timers once gone', () => {
        mount();
        expect(container.querySelector('.beaver-showcase')?.getAttribute('aria-hidden')).toBe('true');
        expect(container.querySelector('[tabindex]:not([tabindex="-1"])')).toBeNull();
        act(() => { vi.advanceTimersByTime(500); });
        act(() => { root?.unmount(); });
        root = null;
        expect(vi.getTimerCount()).toBe(0);
    });
});
