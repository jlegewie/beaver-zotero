// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { beforeEach, expect, it, vi } from 'vitest';
import { backgroundProcessingStatusAtom } from '../../../react/atoms/backgroundProcessing';
import { useBackgroundProcessingStatus } from '../../../react/hooks/useBackgroundProcessingStatus';
const { collect, coverage, runtime, subscribe } = vi.hoisted(() => ({
    collect: vi.fn(), coverage: vi.fn(), runtime: {}, subscribe: vi.fn(() => vi.fn()),
}));
vi.mock('../../../react/runtime/windowRuntime', () => ({ tryGetWindowRuntime: () => runtime }));
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
let readinessStatus: any = undefined;
beforeEach(() => { readinessStatus = undefined; vi.clearAllMocks(); collect.mockReset(); coverage.mockReset(); });
it('updates local progress while coverage is slow and preserves coverage after its own failure', async () => {
    vi.useFakeTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const previous = Zotero.Beaver;
    (Zotero as any).Beaver = { db: {}, background: { collectStatus: collect, searchReadiness: { refresh: coverage, getStatus: () => readinessStatus } }, runtime: { subscribeWindow: subscribe } };
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
        const remote = { current: { ready: true }, lastConfirmed: { verified_at: '2026-09-18T00:00:00Z' }, error: null };
        readinessStatus = remote;
        await act(async () => resolve(undefined));
        readinessStatus = { ...remote, error: 'Could not verify current search coverage.' };
        await act(async () => vi.advanceTimersByTimeAsync(60_000));
        expect(store.get(backgroundProcessingStatusAtom)).toMatchObject({
            searchReadiness: { ...remote, error: 'Could not verify current search coverage.' }, error: null,
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
    (Zotero as any).Beaver = { db: {}, background: { collectStatus: collect, searchReadiness: { refresh: coverage, getStatus: () => readinessStatus } }, runtime: { subscribeWindow: subscribe } };
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
    (Zotero as any).Beaver = { db: {}, background: { collectStatus: collect, searchReadiness: { refresh: coverage, getStatus: () => readinessStatus } }, runtime: { subscribeWindow: subscribe } };
    const store = createStore();
    const initial = store.get(backgroundProcessingStatusAtom);
    collect.mockResolvedValue(null);
    const root = createRoot(document.createElement('div'));
    try {
        await act(async () => root.render(React.createElement(Provider, { store }, React.createElement(Consumer))));
        expect(store.get(backgroundProcessingStatusAtom)).toEqual(initial);
    } finally {
        act(() => root.unmount());
        Zotero.Beaver = previous;
    }
});


it('coalesces activity during a slow local read and ignores results after unmount', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const previous = Zotero.Beaver;
    (Zotero as any).Beaver = { db: {}, background: { collectStatus: collect, searchReadiness: { refresh: coverage, getStatus: () => readinessStatus } }, runtime: { subscribeWindow: subscribe } };
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
