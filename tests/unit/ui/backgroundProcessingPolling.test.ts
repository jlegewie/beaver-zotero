// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { beforeEach, expect, it, vi } from 'vitest';
import { backgroundProcessingStatusAtom } from '../../../react/atoms/backgroundProcessing';
import { useBackgroundProcessingStatus } from '../../../react/hooks/useBackgroundProcessingStatus';
const collect = vi.hoisted(() => vi.fn());
vi.mock('../../../src/services/backgroundProcessing/statusSnapshot', () => ({ collectProcessingStatus: collect }));
vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return { hasOcrAccessAtom: atom(false), hasSearchIndexAccessAtom: atom(true) };
});
function Consumer() {
    useBackgroundProcessingStatus({ includeCoverage: true, includeFailures: true, pollIntervalMs: 1000 });
    return null;
}
function GeneralStatusConsumer() {
    useBackgroundProcessingStatus({ includeFailures: false, pollIntervalMs: 60_000 });
    return null;
}
beforeEach(() => collect.mockReset());
it('finishes slow polls and preserves separately dated server status after a failed refresh', async () => {
    vi.useFakeTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const previous = Zotero.Beaver;
    (Zotero as any).Beaver = { db: {}, background: { collectStatus: collect } };
    const store = createStore();
    const initial = store.get(backgroundProcessingStatusAtom);
    const snapshot = { ...initial,
        coverage: { namespace_exists: true, approx_row_count: 100, documents: [] },
        documentCache: null,
    };
    let resolve!: (value: typeof snapshot) => void;
    collect.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    collect.mockResolvedValue({ ...snapshot, coverage: null });
    const root = createRoot(document.createElement('div'));
    try {
        await act(async () => root.render(React.createElement(Provider, { store }, React.createElement(Consumer))));
        await act(async () => vi.advanceTimersByTimeAsync(5000));
        expect(collect).toHaveBeenCalledTimes(1);
        await act(async () => resolve(snapshot));
        const confirmedAt = store.get(backgroundProcessingStatusAtom).coverageUpdatedAt;
        expect(confirmedAt).not.toBeNull();
        await act(async () => vi.advanceTimersByTimeAsync(1000));
        expect(collect).toHaveBeenCalledTimes(2);
        expect(store.get(backgroundProcessingStatusAtom)).toMatchObject({
            coverage: snapshot.coverage, coverageUpdatedAt: confirmedAt,
            coverageError: 'Could not check search coverage.', error: null,
        });
    } finally {
        act(() => root.unmount());
        Zotero.Beaver = previous;
        vi.useRealTimers();
    }
});

it('does not invalidate issue pages when a general status poll omits issues', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const previous = Zotero.Beaver;
    (Zotero as any).Beaver = { db: {}, background: { collectStatus: collect } };
    const store = createStore();
    const initial = store.get(backgroundProcessingStatusAtom);
    store.set(backgroundProcessingStatusAtom, {
        ...initial,
        issues: [{ reason: 'no_text', count: 1 }],
        issuesUpdatedAt: 123,
    });
    collect.mockResolvedValue({
        ...initial,
        failures: undefined,
        issues: undefined,
        documentCache: null,
    });
    const root = createRoot(document.createElement('div'));
    try {
        await act(async () => root.render(React.createElement(
            Provider,
            { store },
            React.createElement(GeneralStatusConsumer),
        )));
        expect(store.get(backgroundProcessingStatusAtom).updatedAt).not.toBeNull();
        expect(store.get(backgroundProcessingStatusAtom).issuesUpdatedAt).toBe(123);
    } finally {
        act(() => root.unmount());
        Zotero.Beaver = previous;
    }
});

it('ignores the stale-account status sentinel without displaying an error', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const previous = Zotero.Beaver;
    (Zotero as any).Beaver = { db: {}, background: { collectStatus: collect } };
    const store = createStore();
    const initial = store.get(backgroundProcessingStatusAtom);
    collect.mockResolvedValue(null);
    const root = createRoot(document.createElement('div'));
    try {
        await act(async () => root.render(React.createElement(Provider, { store }, React.createElement(Consumer))));
        expect(store.get(backgroundProcessingStatusAtom)).toBe(initial);
    } finally {
        act(() => root.unmount());
        Zotero.Beaver = previous;
    }
});
