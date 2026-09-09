// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, expect, it, vi } from 'vitest';
import { backgroundProcessingStatusAtom } from '../../../react/atoms/backgroundProcessing';
import BackgroundProcessingSection from '../../../react/components/preferences/BackgroundProcessingSection';

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn().mockResolvedValue(undefined) }));
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
vi.mock('../../../react/components/preferences/ProcessingIssueList', () => ({ default: () => null }));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => key === 'backgroundProcessingEnabled',
    setPref: vi.fn(),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.clearAllMocks());

it.each(['queued', 'unavailable'] as const)('reconciles before draining Process now with %s files', async (state) => {
    const store = createStore();
    store.set(backgroundProcessingStatusAtom, {
        ...store.get(backgroundProcessingStatusAtom),
        ledger: { ...store.get(backgroundProcessingStatusAtom).ledger, total: 1, unreadable: state === 'unavailable' ? 1 : 0 },
        issues: state === 'unavailable' ? [{ reason: 'file_unavailable', count: 1 }] : [],
        worker: { available: state === 'queued' ? 1 : 0, deferred: 0, inFlight: 0, dispatchBlocker: null, drainNow: false, backlogGateOpen: false },
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
