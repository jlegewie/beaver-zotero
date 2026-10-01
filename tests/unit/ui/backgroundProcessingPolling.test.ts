// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { beforeEach, expect, it, vi } from 'vitest';
import { backgroundProcessingStatusAtom } from '../../../react/atoms/backgroundProcessing';
import { useBackgroundProcessingStatus } from '../../../react/hooks/useBackgroundProcessingStatus';
const { collect, coverage, runtime, subscribe, surface } = vi.hoisted(() => {
    const document = Object.assign(new EventTarget(), { hidden: false });
    return {
        collect: vi.fn(), coverage: vi.fn(), runtime: {}, subscribe: vi.fn(() => vi.fn()),
        surface: { document },
    };
});
vi.mock('../../../react/runtime/windowRuntime', () => ({
    tryGetWindowRuntime: () => runtime,
    getHostWindow: () => surface,
}));
vi.mock('../../../src/services/backgroundProcessing/statusSnapshot', () => ({ collectProcessingStatus: collect }));
vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return { accountGenerationAtom: atom(1), hasOcrAccessAtom: atom(false), hasSearchIndexAccessAtom: atom(true) };
});
function Consumer() {
    useBackgroundProcessingStatus({ includeCoverage: true, includeFailures: true, pollIntervalMs: 1000 });
    return null;
}
function GeneralStatusConsumer() {
    useBackgroundProcessingStatus({ includeFailures: false, pollIntervalMs: 60_000 });
    return null;
}
function setHidden(hidden: boolean) {
    surface.document.hidden = hidden;
    surface.document.dispatchEvent(new Event('visibilitychange'));
}
beforeEach(() => {
    vi.clearAllMocks(); collect.mockReset(); coverage.mockReset();
    surface.document.hidden = false;
});
it('updates local progress while coverage is slow and preserves coverage after its own failure', async () => {
    vi.useFakeTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const previous = Zotero.Beaver;
    (Zotero as any).Beaver = { db: {}, background: { collectStatus: collect, collectCoverage: coverage }, runtime: { subscribeWindow: subscribe } };
    const store = createStore();
    const snapshot = { ...store.get(backgroundProcessingStatusAtom), documentCache: null };
    collect.mockResolvedValue(snapshot);
    let resolve!: (value: any) => void;
    coverage.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    coverage.mockResolvedValue(null);
    const root = createRoot(document.createElement('div'));
    try {
        await act(async () => root.render(React.createElement(Provider, { store }, React.createElement(Consumer))));
        expect(store.get(backgroundProcessingStatusAtom).updatedAt).not.toBeNull();
        await act(async () => vi.advanceTimersByTimeAsync(5000));
        expect(collect).toHaveBeenCalledTimes(6);
        expect(coverage).toHaveBeenCalledTimes(1);
        expect(collect).toHaveBeenLastCalledWith({ includeCoverage: false, includeFailures: true });
        const remote = { namespace_exists: true, approx_row_count: 100, documents: [] };
        await act(async () => resolve(remote));
        const confirmedAt = store.get(backgroundProcessingStatusAtom).coverageUpdatedAt;
        await act(async () => vi.advanceTimersByTimeAsync(60_000));
        expect(store.get(backgroundProcessingStatusAtom)).toMatchObject({
            coverage: remote, coverageUpdatedAt: confirmedAt,
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
    (Zotero as any).Beaver = { db: {}, background: { collectStatus: collect, collectCoverage: coverage }, runtime: { subscribeWindow: subscribe } };
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
    (Zotero as any).Beaver = { db: {}, background: { collectStatus: collect, collectCoverage: coverage }, runtime: { subscribeWindow: subscribe } };
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


it('coalesces activity during a slow local read and ignores results after unmount', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const previous = Zotero.Beaver;
    (Zotero as any).Beaver = { db: {}, background: { collectStatus: collect, collectCoverage: coverage }, runtime: { subscribeWindow: subscribe } };
    const store = createStore();
    const snapshot = { ...store.get(backgroundProcessingStatusAtom) };
    let resolve!: (value: any) => void;
    collect.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    collect.mockResolvedValue(snapshot);
    const root = createRoot(document.createElement('div'));
    let unmounted = false;
    try {
        await act(async () => root.render(React.createElement(Provider, { store }, React.createElement(GeneralStatusConsumer))));
        const wake = subscribe.mock.calls[0][2] as () => void;
        await act(async () => { wake(); wake(); wake(); });
        expect(collect).toHaveBeenCalledTimes(1);
        await act(async () => resolve(snapshot));
        expect(collect).toHaveBeenCalledTimes(2);
        const last = store.get(backgroundProcessingStatusAtom);
        collect.mockReturnValueOnce(new Promise(done => { resolve = done; }));
        await act(async () => wake());
        act(() => root.unmount());
        unmounted = true;
        await act(async () => resolve({ ...snapshot, error: 'late' }));
        expect(store.get(backgroundProcessingStatusAtom)).toBe(last);
        expect(subscribe.mock.results[0].value).toHaveBeenCalledOnce();
    } finally {
        if (!unmounted) act(() => root.unmount());
        Zotero.Beaver = previous;
    }
});

it('pauses local and coverage polling while the surface is hidden and resumes on the coverage cadence', async () => {
    vi.useFakeTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const previous = Zotero.Beaver;
    (Zotero as any).Beaver = { db: {}, background: { collectStatus: collect, collectCoverage: coverage }, runtime: { subscribeWindow: subscribe } };
    const store = createStore();
    collect.mockResolvedValue({ ...store.get(backgroundProcessingStatusAtom), documentCache: null });
    coverage.mockResolvedValue({ namespace_exists: true, approx_row_count: 1, documents: [] });
    const root = createRoot(document.createElement('div'));
    try {
        await act(async () => root.render(React.createElement(Provider, { store }, React.createElement(Consumer))));
        expect(collect).toHaveBeenCalledTimes(1);
        expect(coverage).toHaveBeenCalledTimes(1);
        const unsubscribe = subscribe.mock.results[0].value;

        await act(async () => setHidden(true));
        expect(unsubscribe).toHaveBeenCalledOnce();
        await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000));
        expect(collect).toHaveBeenCalledTimes(1);
        expect(coverage).toHaveBeenCalledTimes(1);

        // Repeated events without a state change neither poll nor resubscribe.
        await act(async () => setHidden(true));
        expect(subscribe).toHaveBeenCalledOnce();

        await act(async () => setHidden(false));
        expect(collect).toHaveBeenCalledTimes(2);
        expect(subscribe).toHaveBeenCalledTimes(2);
        expect(coverage).toHaveBeenCalledTimes(2);

        // Showing again shortly after a coverage request waits out its interval.
        await act(async () => vi.advanceTimersByTimeAsync(20_000));
        await act(async () => setHidden(true));
        await act(async () => setHidden(false));
        expect(coverage).toHaveBeenCalledTimes(2);
        await act(async () => vi.advanceTimersByTimeAsync(39_000));
        expect(coverage).toHaveBeenCalledTimes(2);
        await act(async () => vi.advanceTimersByTimeAsync(1_000));
        expect(coverage).toHaveBeenCalledTimes(3);
    } finally {
        act(() => root.unmount());
        Zotero.Beaver = previous;
        vi.useRealTimers();
    }
});
