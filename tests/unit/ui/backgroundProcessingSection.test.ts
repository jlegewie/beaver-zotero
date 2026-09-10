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
// Stand-in for the issue list: one group-level and one row-level retry control.
vi.mock('../../../react/components/preferences/ProcessingIssueList', async () => {
    const React = await import('react');
    return {
        default: ({ group, onRetry }: any) => React.createElement(
            'div',
            null,
            React.createElement('button', { 'data-retry': 'group', onClick: () => onRetry?.(group.reason, null) }, 'Retry all'),
            React.createElement('button', {
                'data-retry': 'row',
                onClick: () => onRetry?.(group.reason, [{ libraryId: 1, zoteroKey: 'CCCCCCCC' }]),
            }, 'Retry'),
        ),
    };
});
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => key === 'backgroundProcessingEnabled',
    setPref: vi.fn(),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.clearAllMocks());

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

it('leaves unreadable files to the issue list instead of a red status headline', async () => {
    const store = createStore();
    store.set(backgroundProcessingStatusAtom, {
        ...store.get(backgroundProcessingStatusAtom),
        ledger: { ...store.get(backgroundProcessingStatusAtom).ledger, total: 3, readable: 2, unreadable: 1 },
        issues: [{ reason: 'file_unavailable', count: 1 }],
        worker: { available: 0, deferred: 0, inFlight: 0, dispatchBlocker: null, drainNow: false, backlogGateOpen: false },
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () => root.render(React.createElement(Provider, { store }, React.createElement(BackgroundProcessingSection))));
        expect(container.querySelector('[role="status"]')?.textContent).toBe('All files are processed');
        expect(Array.from(container.querySelectorAll('button')).some((node) => node.textContent === 'Process now')).toBe(false);
        expect(container.textContent).toContain('1 could not be read');
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
