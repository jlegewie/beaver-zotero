// @vitest-environment jsdom

/**
 * The quick prompt showcase: the feature played through on a loop.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ prefs: {} as Record<string, unknown> }));

vi.mock('../../../../src/utils/prefs', () => ({
    getPref: (key: string) => mocks.prefs[key],
    setPref: (key: string, value: unknown) => { mocks.prefs[key] = value; },
}));

import QuickPromptShowcase from '../../../../react/components/ui/popup/showcases/QuickPromptShowcase';

let root: Root | null = null;
let container: HTMLDivElement;

function mount() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => { root!.render(React.createElement(QuickPromptShowcase)); });
}

const scene = () => container.querySelector('.beaver-showcase')?.getAttribute('data-scene');
const editorText = () => container.querySelector('.beaver-showcase__editor')?.textContent ?? '';
const keys = () => Array.from(container.querySelectorAll('.beaver-showcase__key')).map((key) => key.textContent);

/** Plays until the showcase reaches the scene, or fails if it never does. */
function playUntil(target: string, maxMs = 30_000) {
    let elapsed = 0;
    while (scene() !== target && elapsed < maxMs) {
        act(() => { vi.advanceTimersByTime(50); });
        elapsed += 50;
    }
    expect(scene()).toBe(target);
}

beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).Zotero = { isMac: true };
    mocks.prefs = { keyboardShortcut: 'j' };
});

afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    container.remove();
    delete (globalThis as any).Zotero;
    vi.useRealTimers();
});

describe('QuickPromptShowcase', () => {
    it('plays the feature through — shortcut, composer, run, result — and starts over', () => {
        mount();
        expect(scene()).toBe('shortcut');
        expect(keys()).toEqual(['⌘', '⌥', 'J']);

        playUntil('compose');
        expect(editorText()).toBe('Ask Beaver');
        expect(container.querySelector<HTMLButtonElement>('.composer-send')?.disabled).toBe(true);

        let elapsed = 0;
        while (!editorText().endsWith('as a note') && elapsed < 10_000) {
            act(() => { vi.advanceTimersByTime(50); });
            elapsed += 50;
        }
        expect(editorText()).toBe('Summarize the key findings and save them as a note');
        expect(container.querySelector<HTMLButtonElement>('.composer-send')?.disabled).toBe(false);

        playUntil('running');
        expect(container.querySelector('.shimmer-text')?.textContent).toBe('Reading Sampson 2012, p. 31-48');

        playUntil('completed');
        expect(container.textContent).toContain('Created Note');
        expect(container.textContent).toContain('Open Beaver');

        playUntil('shortcut');
    });

    it('draws the chord for the platform and the configured key', () => {
        (globalThis as any).Zotero = { isMac: false };
        mocks.prefs = { keyboardShortcut: 'k' };
        mount();
        expect(keys()).toEqual(['Ctrl', 'Alt', 'K']);
    });

    it('takes nothing with it: no pointer, no focus, no timers once gone', () => {
        mount();
        expect(container.querySelector('.beaver-showcase')?.getAttribute('aria-hidden')).toBe('true');
        act(() => { vi.advanceTimersByTime(500); });
        act(() => { root?.unmount(); });
        root = null;
        expect(vi.getTimerCount()).toBe(0);
    });
});
