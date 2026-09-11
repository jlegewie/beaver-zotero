// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, expect, it, vi } from 'vitest';
import LocalDocumentCacheRow from '../../../react/components/preferences/LocalDocumentCacheRow';

const { clearCache, access } = vi.hoisted(() => ({
    clearCache: vi.fn().mockResolvedValue(undefined),
    access: { ocr: false, search: false },
}));
vi.mock('../../../src/services/backgroundProcessing/resetLocalState', () => ({ clearDocumentCache: clearCache }));
vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return {
        hasOcrAccessAtom: atom(() => access.ocr),
        hasSearchIndexAccessAtom: atom(() => access.search),
    };
});
vi.mock('../../../react/runtime/SurfaceWindowContext', () => ({ useSurfaceWindow: () => globalThis.window }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const stats = {
    cached_document_count: 2, metadata_count: 4, payload_count: 3,
    payload_total_bytes: 1024 * 1024, payload_budget_bytes: 2 * 1024 * 1024,
    payload_cache_dir: '/cache',
};

let previousBeaver: any;
let previousPrompt: any;
const confirm = vi.fn(() => 0);
const getStats = vi.fn(async () => stats);
afterEach(() => {
    vi.clearAllMocks();
    access.ocr = false;
    access.search = false;
    (Zotero as any).Beaver = previousBeaver;
    (Zotero as any).Prompt = previousPrompt;
});

async function render(check: (container: HTMLDivElement) => Promise<void> | void) {
    previousBeaver = Zotero.Beaver;
    previousPrompt = (Zotero as any).Prompt;
    (Zotero as any).Beaver = { documentCache: { getStats } };
    (Zotero as any).Prompt = { confirm, BUTTON_TITLE_CANCEL: 'cancel' };
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () => root.render(React.createElement(Provider, { store: createStore() }, React.createElement(LocalDocumentCacheRow))));
        await check(container);
    } finally {
        act(() => root.unmount());
    }
}

const clearButton = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Clear…') as HTMLButtonElement;

it('shows the cache size and clears it after confirmation, then re-reads the size', async () => {
    getStats.mockResolvedValueOnce(stats).mockResolvedValueOnce({
        ...stats, cached_document_count: 0, metadata_count: 0, payload_count: 0, payload_total_bytes: 0,
    });
    await render(async (container) => {
        expect(container.textContent).toContain('2 documents cached · 1.0 MB of 2.0 MB');
        await act(async () => clearButton(container).click());
        expect(confirm).toHaveBeenCalledOnce();
        expect(confirm.mock.calls[0][0]).toMatchObject({ button0: 'Clear', defaultButton: 1 });
        expect((confirm.mock.calls[0][0] as any).text).toContain('2 documents cached');
        expect((confirm.mock.calls[0][0] as any).text).not.toContain('Scanned files');
        expect(clearCache).toHaveBeenCalledWith();
        expect(getStats).toHaveBeenCalledTimes(2);
        expect(container.textContent).toContain('0 documents cached · 0 MB of 2.0 MB');
        expect(clearButton(container).disabled).toBe(true);
    });
});

it('does nothing when the confirmation is cancelled', async () => {
    confirm.mockReturnValueOnce(1);
    await render(async (container) => {
        await act(async () => clearButton(container).click());
        expect(clearCache).not.toHaveBeenCalled();
        expect(getStats).toHaveBeenCalledTimes(1);
    });
});

it('mentions OCR and the server index in the confirmation only for entitled accounts', async () => {
    access.ocr = true;
    access.search = true;
    await render(async (container) => {
        await act(async () => clearButton(container).click());
        const text = (confirm.mock.calls[0][0] as any).text as string;
        expect(text).toContain('Scanned files will need to be processed again.');
        expect(text).toContain('Your full-text search index is not affected.');
    });
});

it('reports a failed clear inline and keeps the action available', async () => {
    clearCache.mockRejectedValueOnce(new Error('A cache file could not be deleted.'));
    await render(async (container) => {
        await act(async () => clearButton(container).click());
        const alert = container.querySelector('[role="alert"]');
        expect(alert?.textContent).toContain('could not be deleted');
        expect(alert?.closest('[aria-hidden="true"]')).toBeNull();
        expect(clearButton(container).disabled).toBe(false);
    });
});

it('disables Clear when the cache cannot be read and keeps retrying through repeated failures', async () => {
    vi.useFakeTimers();
    getStats
        .mockRejectedValueOnce(new Error('no db'))
        .mockRejectedValueOnce(new Error('no db'))
        .mockRejectedValueOnce(new Error('no db'));
    try {
        await render(async (container) => {
            expect(container.textContent).toContain('Cache status unavailable');
            expect(clearButton(container).disabled).toBe(true);
            await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
            expect(getStats).toHaveBeenCalledTimes(3);
            expect(clearButton(container).disabled).toBe(true);
            await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
            expect(getStats).toHaveBeenCalledTimes(4);
            expect(container.textContent).toContain('2 documents cached');
            expect(clearButton(container).disabled).toBe(false);
            // Once readable, the size is re-read slowly rather than every few seconds.
            await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
            expect(getStats).toHaveBeenCalledTimes(4);
            await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
            expect(getStats).toHaveBeenCalledTimes(5);
        });
        // Unmounted with the tab: the interval must not keep reading the cache.
        await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
        expect(getStats).toHaveBeenCalledTimes(5);
    } finally {
        vi.useRealTimers();
    }
});
