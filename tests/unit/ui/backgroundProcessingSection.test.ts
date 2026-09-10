// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, expect, it, vi } from 'vitest';
import { backgroundProcessingStatusAtom } from '../../../react/atoms/backgroundProcessing';
import { hasSearchIndexAccessAtom } from '../../../react/atoms/profile';
import BackgroundProcessingSection from '../../../react/components/preferences/BackgroundProcessingSection';

const { refresh, prefs, clearCache, prepareCache } = vi.hoisted(() => ({
    refresh: vi.fn().mockResolvedValue(undefined),
    clearCache: vi.fn().mockResolvedValue(undefined),
    prepareCache: vi.fn().mockResolvedValue(1),
    prefs: { backgroundProcessingEnabled: true, backgroundProcessingContinuous: false },
}));
vi.mock('../../../src/services/backgroundProcessing/resetLocalState', () => ({ clearDocumentCache: clearCache }));
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
    prefs.backgroundProcessingContinuous = false;
});

it('reconciles before draining Process now for queued files', async () => {
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
        const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Process now');
        expect(button).toBeDefined();
        await act(async () => button!.click());
        expect(reconcileNow).toHaveBeenCalledOnce();
        expect(requestImmediateDrain).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        await act(async () => finishReconcile());
        expect(requestImmediateDrain).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledOnce();
    } finally {
        act(() => root.unmount());
        Zotero.Beaver = previousBeaver;
    }
});

it('shows Process now disabled while a dispatcher blocker is set', async () => {
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
        const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Process now') as HTMLButtonElement | undefined;
        expect(button).toBeDefined();
        expect(button!.disabled).toBe(true);
    } finally {
        act(() => root.unmount());
    }
});

it('cancels a Process now drain from Stop without touching the reconciler', async () => {
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
        expect(buttons).not.toContain('Process now');
        const stop = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Stop');
        await act(async () => stop!.click());
        expect(cancelImmediateDrain).toHaveBeenCalledOnce();
        expect(reconcileNow).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledOnce();
    } finally {
        act(() => root.unmount());
        Zotero.Beaver = previousBeaver;
    }
});

it('hides Process now and Stop while continuous processing is on', async () => {
    prefs.backgroundProcessingContinuous = true;
    const store = createStore();
    store.set(backgroundProcessingStatusAtom, {
        ...store.get(backgroundProcessingStatusAtom),
        ledger: { ...store.get(backgroundProcessingStatusAtom).ledger, total: 3 },
        worker: { available: 2, deferred: 0, inFlight: 1, dispatchBlocker: null, drainNow: true, backlogGateOpen: true },
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () => root.render(React.createElement(Provider, { store }, React.createElement(BackgroundProcessingSection))));
        const labels = Array.from(container.querySelectorAll('button')).map((node) => node.textContent);
        expect(labels).not.toContain('Process now');
        expect(labels).not.toContain('Stop');
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
        expect(Array.from(container.querySelectorAll('button')).some((node) => node.textContent === 'Process now')).toBe(false);
        expect(container.textContent).toContain('1 attachment could not be read');
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
it('keeps cache and known reading problems visible with background processing off, with no progress bar', async () => {
    prefs.backgroundProcessingEnabled = false;
    const store = createStore();
    store.set(backgroundProcessingStatusAtom, { ...store.get(backgroundProcessingStatusAtom),
        documentCache: cacheStats, updatedAt: Date.now(), issues: [{ reason: 'file_unavailable', count: 1 }],
    });
    await withView(store, (container) => {
        expect(container.textContent).toContain('By default, Beaver processes files when you use them.');
        expect(container.textContent).toContain('2 documents cached');
        expect(container.textContent).toContain('1 attachment could not be read');
        expect(container.textContent).toContain('Includes files Beaver has attempted to process.');
        expect(container.textContent).not.toContain('Full-text Search');
        expect(container.querySelector('[role="progressbar"]')).toBeNull();
        expect(container.querySelector('[aria-label="Also run while Zotero is in use"]')).toHaveProperty('disabled', true);
        expect(container.querySelector('[data-retry="group"]')).not.toBeNull();
    });
});
it('separates server indexing problems from reading problems and preserves search status while paused', async () => {
    prefs.backgroundProcessingEnabled = false;
    const store = createStore();
    store.set(hasSearchIndexAccessAtom, true);
    store.set(backgroundProcessingStatusAtom, { ...store.get(backgroundProcessingStatusAtom),
        updatedAt: Date.now(), issues: [{ reason: 'index_failed', count: 2 }],
        coverage: { namespace_exists: true, approx_row_count: 1000, documents: [] },
        coverageUpdatedAt: Date.now(),
    });
    await withView(store, (container) => {
        expect(container.textContent).toContain('Full-text Search');
        expect(container.textContent).toContain('Updates paused.');
        expect(container.textContent).toContain('Server search index available');
        expect(container.textContent).toContain('Detailed attachment coverage is not available yet.');
        expect(container.textContent).toContain('No reading problems found in files checked so far.');
        expect(container.querySelector('[data-issue-reason="index_failed"]')).not.toBeNull();
    });
});
it('clears local cache and refreshes its count without changing processing or search state', async () => {
    prefs.backgroundProcessingEnabled = false;
    const store = createStore();
    store.set(backgroundProcessingStatusAtom, { ...store.get(backgroundProcessingStatusAtom), documentCache: cacheStats });
    await withView(store, async (container) => {
        const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Clear local cache')!;
        await act(async () => button.click());
        expect(clearCache).toHaveBeenCalledWith();
        expect(refresh).toHaveBeenCalledOnce();
        expect(prefs.backgroundProcessingEnabled).toBe(false);
        await act(async () => store.set(backgroundProcessingStatusAtom, { ...store.get(backgroundProcessingStatusAtom),
            documentCache: { ...cacheStats, cached_document_count: 0, payload_count: 0, payload_total_bytes: 0 },
        }));
        expect(container.textContent).toContain('0 documents cached');
    });
});
it('reports a cache deletion failure and retains the action for another attempt', async () => {
    clearCache.mockRejectedValueOnce(new Error('A cache file could not be deleted.'));
    const store = createStore();
    store.set(backgroundProcessingStatusAtom, { ...store.get(backgroundProcessingStatusAtom), documentCache: cacheStats });
    await withView(store, async (container) => {
        const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Clear local cache')!;
        await act(async () => button.click());
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be deleted');
        expect(button.disabled).toBe(false);
    });
});

it.each([false, true])('offers contextual cache recovery with search access %s', async (searchAccess) => {
    const store = createStore();
    store.set(hasSearchIndexAccessAtom, searchAccess);
    store.set(backgroundProcessingStatusAtom, { ...store.get(backgroundProcessingStatusAtom),
        documentCache: { ...cacheStats, can_prepare_uncached_files: true },
    });
    await withView(store, async (container) => {
        const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Process uncached files')!;
        expect(button).toBeDefined();
        expect(container.textContent?.includes('Your server search index is unaffected')).toBe(searchAccess);
        await act(async () => button.click());
        expect(prepareCache).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledOnce();
        await act(async () => store.set(backgroundProcessingStatusAtom, { ...store.get(backgroundProcessingStatusAtom),
            documentCache: { ...cacheStats, can_prepare_uncached_files: false },
        }));
        expect(container.textContent).not.toContain('Process uncached files');
    });
});

it('hides cache recovery while background processing is off', async () => {
    prefs.backgroundProcessingEnabled = false;
    const store = createStore();
    store.set(backgroundProcessingStatusAtom, { ...store.get(backgroundProcessingStatusAtom),
        documentCache: { ...cacheStats, can_prepare_uncached_files: true },
    });
    await withView(store, (container) => expect(container.textContent).not.toContain('Process uncached files'));
});
