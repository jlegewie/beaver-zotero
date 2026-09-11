// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, expect, it, vi } from 'vitest';
import { embeddingIndexStateAtom, forceReindexCounterAtom } from '../../../react/atoms/embeddingIndex';
import RebuildSearchIndexRow from '../../../react/components/preferences/RebuildSearchIndexRow';

vi.mock('../../../react/components/pages/onboarding/EmbeddingIndexProgress', async () => {
    const React = await import('react');
    return { default: () => React.createElement('div', { 'data-progress-card': true }) };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.clearAllMocks());

async function render(store: ReturnType<typeof createStore>, check: (container: HTMLDivElement) => Promise<void> | void) {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () => root.render(React.createElement(Provider, { store }, React.createElement(RebuildSearchIndexRow))));
        await check(container);
    } finally {
        act(() => root.unmount());
    }
}
const button = (container: HTMLElement) => container.querySelector('button') as HTMLButtonElement;

it('requests a rebuild once from an idle index and shows failure counts and errors', async () => {
    const store = createStore();
    store.set(embeddingIndexStateAtom, { ...store.get(embeddingIndexStateAtom), failedItems: 2, status: 'error', error: 'offline' });
    await render(store, async (container) => {
        expect(button(container).textContent).toBe('Rebuild');
        expect(button(container).disabled).toBe(false);
        expect(container.textContent).toContain('2 items failed to index');
        expect(container.textContent).toContain('Error: offline');
        const failure = Array.from(container.querySelectorAll('span')).find((node) => node.textContent?.includes('failed to index'));
        expect(failure?.closest('[aria-hidden="true"]')).toBeNull();
        expect(container.querySelector('[data-progress-card]')).toBeNull();
        await act(async () => button(container).click());
        expect(store.get(forceReindexCounterAtom)).toBe(1);
    });
});

it('disables the button with a percentage while indexing and shows the card only for an initial build with items', async () => {
    const store = createStore();
    store.set(embeddingIndexStateAtom, {
        ...store.get(embeddingIndexStateAtom), status: 'indexing', phase: 'initial', progress: 40, totalItems: 10, indexedItems: 4,
    });
    await render(store, async (container) => {
        expect(button(container).textContent).toContain('Indexing (40%)');
        expect(button(container).disabled).toBe(true);
        expect(container.querySelector('[data-progress-card]')).not.toBeNull();
        await act(async () => button(container).click());
        expect(store.get(forceReindexCounterAtom)).toBe(0);
        await act(async () => store.set(embeddingIndexStateAtom, {
            ...store.get(embeddingIndexStateAtom), status: 'updating', phase: 'incremental', progress: 0,
        }));
        expect(button(container).textContent?.trimStart().startsWith('Indexing\n')).toBe(true);
        expect(container.querySelector('[data-progress-card]')).toBeNull();
    });
});
