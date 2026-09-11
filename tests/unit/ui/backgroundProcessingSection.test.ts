// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, expect, it, vi } from 'vitest';
import { backgroundProcessingStatusAtom } from '../../../react/atoms/backgroundProcessing';
import { hasSearchIndexAccessAtom } from '../../../react/atoms/profile';
import BackgroundProcessingSection from '../../../react/components/preferences/BackgroundProcessingSection';

const { refresh, prefs, prepareCache } = vi.hoisted(() => ({
    refresh: vi.fn().mockResolvedValue(undefined),
    prepareCache: vi.fn().mockResolvedValue(1),
    prefs: { backgroundProcessingEnabled: true },
}));
vi.mock('../../../src/services/backgroundProcessing/cachePreparation', () => ({ prepareUncachedFiles: prepareCache }));
vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return {
        hasOcrAccessAtom: atom(false),
        hasSearchIndexAccessAtom: atom(false),
        localZoteroLibrariesAtom: atom([]),
        searchableLibraryIdsAtom: atom([]),
    };
});
vi.mock('../../../react/hooks/useBackgroundProcessingStatus', () => ({
    useBackgroundProcessingStatus: () => refresh,
}));
// Stand-in for the issue list: one group-level and one row-level retry control.
vi.mock('../../../react/components/preferences/ProcessingIssueList', async () => {
    const React = await import('react');
    return {
        default: ({ group, onRetry }: any) => React.createElement(
            'div',
            { 'data-issue-reason': group.reason },
            React.createElement('button', { 'data-retry': 'group', onClick: () => onRetry?.(group.reason, null) }, 'Retry all'),
            React.createElement('button', {
                'data-retry': 'row',
                onClick: () => onRetry?.(group.reason, [{ libraryId: 1, zoteroKey: 'CCCCCCCC' }]),
            }, 'Retry'),
        ),
    };
});
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs[key as keyof typeof prefs] === true,
    setPref: vi.fn(),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
    vi.clearAllMocks();
    prefs.backgroundProcessingEnabled = true;
});

it('reconciles before draining Start now for queued files', async () => {
    const store = createStore();
    store.set(backgroundProcessingStatusAtom, {
        ...store.get(backgroundProcessingStatusAtom),
        ledger: { ...store.get(backgroundProcessingStatusAtom).ledger, total: 1 },
        worker: { available: 1, deferred: 0, inFlight: 0, dispatchBlocker: null, drainNow: false, backlogGateOpen: false },
    });
    let finishReconcile!: () => void;
    const reconcileNow = vi.fn(() => new Promise<void>((resolve) => { finishReconcile = resolve; }));
    const requestImmediateDrain = vi.fn();
    const previousBeaver = Zotero.Beaver;
    (Zotero as any).Beaver = {
        processingReconciler: { reconcileNow },
        backgroundExtractor: { requestImmediateDrain },
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () => root.render(React.createElement(Provider, { store }, React.createElement(BackgroundProcessingSection))));
        const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Start now');
        expect(button).toBeDefined();
        await act(async () => button!.click());
        expect(reconcileNow).toHaveBeenCalledOnce();
        expect(requestImmediateDrain).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        await act(async () => finishReconcile());
        expect(requestImmediateDrain).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledOnce();
        // Nothing was evicted from the cache, so a plain drain must not re-extract anything.
        expect(prepareCache).not.toHaveBeenCalled();
    } finally {
        act(() => root.unmount());
        Zotero.Beaver = previousBeaver;
    }
});

it('shows Start now disabled while a dispatcher blocker is set', async () => {
    const store = createStore();
    store.set(backgroundProcessingStatusAtom, {
        ...store.get(backgroundProcessingStatusAtom),
        ledger: { ...store.get(backgroundProcessingStatusAtom).ledger, total: 1 },
        worker: { available: 1, deferred: 0, inFlight: 0, dispatchBlocker: 'sync_in_progress', drainNow: false, backlogGateOpen: false },
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () => root.render(React.createElement(Provider, { store }, React.createElement(BackgroundProcessingSection))));
        const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Start now') as HTMLButtonElement | undefined;
        expect(button).toBeDefined();
        expect(button!.disabled).toBe(true);
    } finally {
        act(() => root.unmount());
    }
});

it('cancels a Start now drain from Stop without touching the reconciler', async () => {
    const store = createStore();
    store.set(backgroundProcessingStatusAtom, {
        ...store.get(backgroundProcessingStatusAtom),
        ledger: { ...store.get(backgroundProcessingStatusAtom).ledger, total: 3 },
        worker: { available: 2, deferred: 0, inFlight: 1, dispatchBlocker: null, drainNow: true, backlogGateOpen: true },
    });
    const cancelImmediateDrain = vi.fn();
    const reconcileNow = vi.fn();
    const previousBeaver = Zotero.Beaver;
    (Zotero as any).Beaver = {
        processingReconciler: { reconcileNow },
        backgroundExtractor: { cancelImmediateDrain },
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () => root.render(React.createElement(Provider, { store }, React.createElement(BackgroundProcessingSection))));
        const buttons = Array.from(container.querySelectorAll('button')).map((node) => node.textContent);
        expect(buttons).toContain('Stop');
        expect(buttons).not.toContain('Start now');
        const stop = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Stop');
        await act(async () => stop!.click());
        expect(cancelImmediateDrain).toHaveBeenCalledOnce();
        expect(reconcileNow).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledOnce();
        // The refreshed snapshot: drain off, gate shut, the current file still running.
        await act(async () => store.set(backgroundProcessingStatusAtom, {
            ...store.get(backgroundProcessingStatusAtom),
            worker: { available: 2, deferred: 0, inFlight: 1, dispatchBlocker: null, drainNow: false, backlogGateOpen: false },
        }));
        expect(container.querySelector('[role="status"]')?.textContent).toBe('Finishing current file…');
        expect(Array.from(container.querySelectorAll('button')).map((node) => node.textContent)).not.toContain('Stop');
    } finally {
        act(() => root.unmount());
        Zotero.Beaver = previousBeaver;
    }
});

it('offers neither Start now nor Stop while the dispatcher keeps the gate open without a drain', async () => {
    const store = createStore();
    store.set(backgroundProcessingStatusAtom, {
        ...store.get(backgroundProcessingStatusAtom),
        ledger: { ...store.get(backgroundProcessingStatusAtom).ledger, total: 3 },
        worker: { available: 2, deferred: 0, inFlight: 1, dispatchBlocker: null, drainNow: false, backlogGateOpen: true },
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () => root.render(React.createElement(Provider, { store }, React.createElement(BackgroundProcessingSection))));
        const labels = Array.from(container.querySelectorAll('button')).map((node) => node.textContent);
        expect(labels).not.toContain('Start now');
        expect(labels).not.toContain('Stop');
        expect(container.querySelector('[aria-label="Also run while Zotero is in use"]')).toBeNull();
        expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toBe('0 of 3 files processed in this run');
        // The run's size is the largest queue depth seen; progress is what has drained since.
        await act(async () => store.set(backgroundProcessingStatusAtom, {
            ...store.get(backgroundProcessingStatusAtom),
            ledger: { ...store.get(backgroundProcessingStatusAtom).ledger, total: 3, readable: 2 },
            worker: { available: 0, deferred: 0, inFlight: 1, dispatchBlocker: null, drainNow: false, backlogGateOpen: true },
        }));
        expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toBe('2 of 3 files processed in this run');
        expect(container.textContent).toContain('2 of 3');
        // Five files queued mid-run grow the total; completed work is not undone.
        await act(async () => store.set(backgroundProcessingStatusAtom, {
            ...store.get(backgroundProcessingStatusAtom),
            worker: { available: 5, deferred: 0, inFlight: 1, dispatchBlocker: null, drainNow: false, backlogGateOpen: true, queuedFiles: 6 },
        }));
        expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toBe('2 of 8 files processed in this run');
        // Draining again counts from there.
        await act(async () => store.set(backgroundProcessingStatusAtom, {
            ...store.get(backgroundProcessingStatusAtom),
            worker: { available: 1, deferred: 0, inFlight: 1, dispatchBlocker: null, drainNow: false, backlogGateOpen: true, queuedFiles: 2 },
        }));
        expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toBe('6 of 8 files processed in this run');
        // Settled: the bar goes, and the next run starts from its own size.
        await act(async () => store.set(backgroundProcessingStatusAtom, {
            ...store.get(backgroundProcessingStatusAtom),
            ledger: { ...store.get(backgroundProcessingStatusAtom).ledger, total: 3, readable: 3 },
            worker: { available: 0, deferred: 0, inFlight: 0, dispatchBlocker: null, drainNow: false, backlogGateOpen: false },
        }));
        expect(container.querySelector('[role="progressbar"]')).toBeNull();
        await act(async () => store.set(backgroundProcessingStatusAtom, {
            ...store.get(backgroundProcessingStatusAtom),
            worker: { available: 1, deferred: 0, inFlight: 1, dispatchBlocker: null, drainNow: false, backlogGateOpen: true, queuedFiles: 1 },
        }));
        expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toBe('0 of 1 files processed in this run');
    } finally {
        act(() => root.unmount());
    }
});

it('leaves unreadable files to the issue list instead of a red status headline', async () => {
    const store = createStore();
    store.set(backgroundProcessingStatusAtom, {
        ...store.get(backgroundProcessingStatusAtom),
        ledger: { ...store.get(backgroundProcessingStatusAtom).ledger, total: 3, readable: 2, unreadable: 1 },
        issues: [{ reason: 'file_unavailable', count: 1 }],
        updatedAt: Date.now(),
        worker: { available: 0, deferred: 0, inFlight: 0, dispatchBlocker: null, drainNow: false, backlogGateOpen: false },
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () => root.render(React.createElement(Provider, { store }, React.createElement(BackgroundProcessingSection))));
        expect(container.querySelector('[role="status"]')?.textContent).toBe('Up to date');
        expect(Array.from(container.querySelectorAll('button')).some((node) => node.textContent === 'Start now')).toBe(false);
        expect(container.textContent).toContain('1 attachment could not be read or indexed');
        expect(container.textContent).not.toContain('Libraries to Process');
    } finally {
        act(() => root.unmount());
    }
});

it.each(['group', 'row'])('routes a %s retry through the reconciler and refreshes', async (level) => {
    const store = createStore();
    store.set(backgroundProcessingStatusAtom, {
        ...store.get(backgroundProcessingStatusAtom),
        ledger: { ...store.get(backgroundProcessingStatusAtom).ledger, total: 1, unreadable: 1 },
        issues: [{ reason: 'extract_failed', count: 1 }],
        worker: { available: 0, deferred: 0, inFlight: 0, dispatchBlocker: null, drainNow: false, backlogGateOpen: false },
    });
    const groupRefs = [{ libraryId: 1, zoteroKey: 'AAAAAAAA' }, { libraryId: 1, zoteroKey: 'BBBBBBBB' }];
    const rowRefs = [{ libraryId: 1, zoteroKey: 'CCCCCCCC' }];
    const getProcessingIssueRefs = vi.fn(async () => groupRefs);
    const retryAttachments = vi.fn(async () => 1);
    const previousBeaver = Zotero.Beaver;
    (Zotero as any).Beaver = {
        db: { getProcessingIssueRefs },
        processingReconciler: { retryAttachments },
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () => root.render(React.createElement(Provider, { store }, React.createElement(BackgroundProcessingSection))));
        const button = container.querySelector<HTMLButtonElement>(`button[data-retry="${level}"]`);
        expect(button).not.toBeNull();
        await act(async () => button!.click());
        if (level === 'group') {
            expect(getProcessingIssueRefs).toHaveBeenCalledWith(
                { hasOcrAccess: false, hasSearchIndexAccess: false }, 'extract_failed',
            );
            expect(retryAttachments).toHaveBeenCalledWith(groupRefs);
        } else {
            expect(getProcessingIssueRefs).not.toHaveBeenCalled();
            expect(retryAttachments).toHaveBeenCalledWith(rowRefs);
        }
        expect(refresh).toHaveBeenCalledOnce();
    } finally {
        act(() => root.unmount());
        Zotero.Beaver = previousBeaver;
    }
});

async function withView(store: ReturnType<typeof createStore>, check: (container: HTMLDivElement) => Promise<void> | void) {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () => root.render(React.createElement(Provider, { store }, React.createElement(BackgroundProcessingSection))));
        await check(container);
    } finally {
        act(() => root.unmount());
    }
}
const cacheStats = {
    cached_document_count: 2, metadata_count: 4, payload_count: 3,
    payload_total_bytes: 1024 * 1024, payload_budget_bytes: 2 * 1024 * 1024,
    payload_cache_dir: '/cache',
};
it('keeps known problems visible with background processing off, without status, cache, or schedule controls', async () => {
    prefs.backgroundProcessingEnabled = false;
    const store = createStore();
    store.set(backgroundProcessingStatusAtom, { ...store.get(backgroundProcessingStatusAtom),
        documentCache: cacheStats, updatedAt: Date.now(), issues: [{ reason: 'file_unavailable', count: 1 }],
    });
    await withView(store, (container) => {
        expect(container.textContent).toContain('By default, Beaver processes files when you use them.');
        expect(container.textContent).not.toContain('documents cached');
        expect(container.textContent).not.toContain('Clear local cache');
        expect(container.textContent).toContain('Of the files Beaver has processed so far, 1 attachment could not be read or indexed.');
        expect(container.textContent).not.toContain('Full-text Search');
        expect(container.querySelector('[role="status"]')).toBeNull();
        expect(container.querySelector('[role="progressbar"]')).toBeNull();
        expect(container.querySelector('[aria-label="Also run while Zotero is in use"]')).toBeNull();
        expect(container.querySelector('[data-retry="group"]')).not.toBeNull();
    });
});
it('lists server indexing problems with reading problems and keeps the search status on the toggle row', async () => {
    const store = createStore();
    store.set(hasSearchIndexAccessAtom, true);
    store.set(backgroundProcessingStatusAtom, { ...store.get(backgroundProcessingStatusAtom),
        updatedAt: Date.now(),
        ledger: { ...store.get(backgroundProcessingStatusAtom).ledger, total: 2, readable: 2 },
        issues: [{ reason: 'index_failed', count: 2 }],
        worker: { available: 0, deferred: 0, inFlight: 0, dispatchBlocker: null, drainNow: false, backlogGateOpen: false },
        coverage: { namespace_exists: true, approx_row_count: 1000, documents: [] },
        coverageUpdatedAt: Date.now(),
    });
    await withView(store, (container) => {
        expect(container.textContent).not.toContain('Full-text Search');
        expect(container.textContent).toContain('Keep Full-Text Search Up to Date');
        expect(container.querySelector('[role="status"]')?.textContent).toBe('Up to date');
        expect(container.textContent).toContain('Some files need attention. See the problems below.');
        expect(container.textContent).toContain('Full-text search index available. Last checked');
        expect(container.textContent).not.toContain('Updates paused.');
        expect(container.textContent).toContain('2 attachments could not be read or indexed');
        expect(container.querySelector('[data-issue-reason="index_failed"]')).not.toBeNull();
    });
});
it.each([
    [{ coverage: { namespace_exists: false, approx_row_count: 0, documents: [] }, coverageError: null }, 'Full-text search index not built yet.'],
    [{ coverage: null, coverageError: 'Could not check search coverage.' }, 'The full-text search index could not be checked.'],
    [{ coverage: null, coverageError: null }, 'Checking the full-text search index…'],
    [
        { coverage: { namespace_exists: true, approx_row_count: 10, documents: [] }, coverageError: 'Could not check search coverage.', coverageUpdatedAt: 0 },
        'The full-text search index could not be checked. Last known status: Full-text search index available.',
    ],
])('keeps the search index status %j visible while processing is paused', async (coverageState, line) => {
    prefs.backgroundProcessingEnabled = false;
    const store = createStore();
    store.set(hasSearchIndexAccessAtom, true);
    store.set(backgroundProcessingStatusAtom, { ...store.get(backgroundProcessingStatusAtom), updatedAt: Date.now(), ...coverageState });
    await withView(store, (container) => {
        expect(container.querySelector('[role="status"]')).toBeNull();
        expect(container.textContent).toContain(`Updates paused. ${line}`);
        const paused = Array.from(container.querySelectorAll('span')).find((node) => node.textContent?.startsWith('Updates paused.'));
        expect(paused?.closest('[aria-hidden="true"]')).toBeNull();
        expect(container.textContent).toContain('No problems found in the files Beaver has processed so far.');
    });
});

it('restores evicted cached text through Start now once the backlog is settled', async () => {
    const store = createStore();
    store.set(backgroundProcessingStatusAtom, { ...store.get(backgroundProcessingStatusAtom),
        updatedAt: Date.now(),
        ledger: { ...store.get(backgroundProcessingStatusAtom).ledger, total: 2, readable: 2 },
        worker: { available: 0, deferred: 0, inFlight: 0, dispatchBlocker: null, drainNow: false, backlogGateOpen: false },
        documentCache: { ...cacheStats, can_prepare_uncached_files: true },
    });
    const reconcileNow = vi.fn(async () => undefined);
    const requestImmediateDrain = vi.fn();
    const previousBeaver = Zotero.Beaver;
    (Zotero as any).Beaver = {
        processingReconciler: { reconcileNow },
        backgroundExtractor: { requestImmediateDrain },
    };
    try {
        await withView(store, async (container) => {
            expect(container.textContent).not.toContain('Process uncached files');
            expect(container.textContent).toContain('Some files aren’t cached on this computer. Start now prepares them for faster responses.');
            const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Start now')!;
            expect(button).toBeDefined();
            await act(async () => button.click());
            expect(reconcileNow).toHaveBeenCalledOnce();
            expect(prepareCache).toHaveBeenCalledOnce();
            expect(requestImmediateDrain).toHaveBeenCalledOnce();
            expect(refresh).toHaveBeenCalledOnce();
            await act(async () => store.set(backgroundProcessingStatusAtom, { ...store.get(backgroundProcessingStatusAtom),
                documentCache: { ...cacheStats, can_prepare_uncached_files: false },
            }));
            expect(Array.from(container.querySelectorAll('button')).some((node) => node.textContent === 'Start now')).toBe(false);
        });
    } finally {
        Zotero.Beaver = previousBeaver;
    }
});

it('does not restore cached text while background processing is off', async () => {
    prefs.backgroundProcessingEnabled = false;
    const store = createStore();
    store.set(backgroundProcessingStatusAtom, { ...store.get(backgroundProcessingStatusAtom),
        updatedAt: Date.now(),
        documentCache: { ...cacheStats, can_prepare_uncached_files: true },
    });
    await withView(store, (container) => {
        expect(Array.from(container.querySelectorAll('button')).some((node) => node.textContent === 'Start now')).toBe(false);
    });
});

it('surfaces a failed cache restoration on the page and still drains what was queued', async () => {
    prepareCache.mockRejectedValueOnce(new Error('No room in the cache.'));
    const store = createStore();
    store.set(backgroundProcessingStatusAtom, { ...store.get(backgroundProcessingStatusAtom),
        updatedAt: Date.now(),
        ledger: { ...store.get(backgroundProcessingStatusAtom).ledger, total: 2, readable: 2 },
        worker: { available: 0, deferred: 0, inFlight: 0, dispatchBlocker: null, drainNow: false, backlogGateOpen: false },
        documentCache: { ...cacheStats, can_prepare_uncached_files: true },
    });
    const requestImmediateDrain = vi.fn();
    const previousBeaver = Zotero.Beaver;
    (Zotero as any).Beaver = {
        processingReconciler: { reconcileNow: vi.fn(async () => undefined) },
        backgroundExtractor: { requestImmediateDrain },
    };
    try {
        await withView(store, async (container) => {
            const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Start now')!;
            await act(async () => button.click());
            expect(container.querySelector('[role="alert"]')?.textContent).toContain('No room in the cache.');
            expect(requestImmediateDrain).toHaveBeenCalledOnce();
        });
    } finally {
        Zotero.Beaver = previousBeaver;
    }
});

it('still restores cached text and drains when the reconcile step fails', async () => {
    const store = createStore();
    store.set(backgroundProcessingStatusAtom, { ...store.get(backgroundProcessingStatusAtom),
        updatedAt: Date.now(),
        ledger: { ...store.get(backgroundProcessingStatusAtom).ledger, total: 2, readable: 2 },
        worker: { available: 0, deferred: 0, inFlight: 0, dispatchBlocker: null, drainNow: false, backlogGateOpen: false },
        documentCache: { ...cacheStats, can_prepare_uncached_files: true },
    });
    const requestImmediateDrain = vi.fn();
    const previousBeaver = Zotero.Beaver;
    (Zotero as any).Beaver = {
        processingReconciler: { reconcileNow: vi.fn(async () => { throw new Error('ledger locked'); }) },
        backgroundExtractor: { requestImmediateDrain },
    };
    try {
        await withView(store, async (container) => {
            const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.startsWith('Start now'))!;
            await act(async () => button.click());
            expect(prepareCache).toHaveBeenCalledOnce();
            expect(requestImmediateDrain).toHaveBeenCalledOnce();
            expect(refresh).toHaveBeenCalledOnce();
            expect(container.querySelector('[role="alert"]')?.textContent).toContain('ledger locked');
        });
    } finally {
        Zotero.Beaver = previousBeaver;
    }
});

it('disables Start now while a click is still preparing work', async () => {
    const store = createStore();
    store.set(backgroundProcessingStatusAtom, {
        ...store.get(backgroundProcessingStatusAtom),
        ledger: { ...store.get(backgroundProcessingStatusAtom).ledger, total: 1 },
        worker: { available: 1, deferred: 0, inFlight: 0, dispatchBlocker: null, drainNow: false, backlogGateOpen: false },
    });
    let finishReconcile!: () => void;
    const reconcileNow = vi.fn(() => new Promise<void>((resolve) => { finishReconcile = resolve; }));
    const previousBeaver = Zotero.Beaver;
    (Zotero as any).Beaver = {
        processingReconciler: { reconcileNow },
        backgroundExtractor: { requestImmediateDrain: vi.fn() },
    };
    try {
        await withView(store, async (container) => {
            const find = () => Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.startsWith('Start now')) as HTMLButtonElement;
            expect(find().disabled).toBe(false);
            await act(async () => find().click());
            expect(find().disabled).toBe(true);
            await act(async () => find().click());
            expect(reconcileNow).toHaveBeenCalledOnce();
            await act(async () => finishReconcile());
            expect(find().disabled).toBe(false);
        });
    } finally {
        Zotero.Beaver = previousBeaver;
    }
});

it('lists metadata search failures under Problems with a Rebuild action and a summary that agrees', async () => {
    const { embeddingIndexStateAtom, forceReindexCounterAtom } = await import('../../../react/atoms/embeddingIndex');
    const store = createStore();
    store.set(embeddingIndexStateAtom, { ...store.get(embeddingIndexStateAtom), failedItems: 3 });
    store.set(backgroundProcessingStatusAtom, { ...store.get(backgroundProcessingStatusAtom), updatedAt: Date.now() });
    await withView(store, async (container) => {
        expect(container.textContent).toContain('3 items missing from metadata search');
        expect(container.textContent).toContain('Metadata search needs attention.');
        expect(container.textContent).not.toContain('No problems found');
        const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Rebuild')!;
        expect(button).toBeDefined();
        await act(async () => button.click());
        expect(store.get(forceReindexCounterAtom)).toBe(1);
        await act(async () => store.set(embeddingIndexStateAtom, { ...store.get(embeddingIndexStateAtom), failedItems: 0 }));
        expect(container.textContent).not.toContain('missing from metadata search');
        expect(container.textContent).toContain('No problems found in the files Beaver has processed so far.');
    });
});

it('unregisters its pref observer when the page unmounts', async () => {
    const token = Symbol('enabled-pref');
    const registerObserver = vi.fn(() => token);
    const unregisterObserver = vi.fn();
    const previousPrefs = (Zotero as any).Prefs;
    (Zotero as any).Prefs = { ...previousPrefs, registerObserver, unregisterObserver };
    try {
        const store = createStore();
        store.set(backgroundProcessingStatusAtom, { ...store.get(backgroundProcessingStatusAtom), updatedAt: Date.now() });
        await withView(store, () => {
            expect(registerObserver).toHaveBeenCalledWith('extensions.zotero.beaver.backgroundProcessingEnabled', expect.any(Function), true);
            expect(unregisterObserver).not.toHaveBeenCalled();
        });
        expect(unregisterObserver).toHaveBeenCalledWith(token);
    } finally {
        (Zotero as any).Prefs = previousPrefs;
    }
});

it('keeps previously reported problems listed when the status read itself fails', async () => {
    const store = createStore();
    store.set(backgroundProcessingStatusAtom, { ...store.get(backgroundProcessingStatusAtom),
        updatedAt: Date.now(), error: 'db locked', issues: [{ reason: 'extract_failed', count: 2 }],
    });
    await withView(store, (container) => {
        expect(container.textContent).toContain('Could not update the list of problems. Previously reported problems are shown below.');
        expect(container.querySelector('[data-issue-reason="extract_failed"]')).not.toBeNull();
        expect(container.querySelector('[role="status"]')?.textContent).toBe('Status unavailable');
    });
});

it('reports a metadata index error without failed items, and disables Rebuild while indexing', async () => {
    const { embeddingIndexStateAtom } = await import('../../../react/atoms/embeddingIndex');
    const store = createStore();
    store.set(embeddingIndexStateAtom, { ...store.get(embeddingIndexStateAtom), status: 'error', error: 'quota exceeded' });
    store.set(backgroundProcessingStatusAtom, { ...store.get(backgroundProcessingStatusAtom), updatedAt: Date.now() });
    await withView(store, async (container) => {
        expect(container.textContent).toContain('Metadata search index needs attention');
        expect(container.textContent).toContain('The last index update failed: quota exceeded');
        expect(container.textContent).toContain('Metadata search needs attention.');
        await act(async () => store.set(embeddingIndexStateAtom, { ...store.get(embeddingIndexStateAtom), status: 'indexing', failedItems: 1 }));
        const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.startsWith('Rebuilding…')) as HTMLButtonElement;
        expect(button).toBeDefined();
        expect(button.disabled).toBe(true);
    });
});
