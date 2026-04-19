/** @vitest-environment jsdom */
/**
 * Mounted wrapper tests for `useZoteroItemTitle`. Cover wiring that the
 * pure-helper tests leave uncovered: real Zotero.Items APIs, the resolver
 * ref (stable identity across rerenders), cancellation on unmount, default
 * resolver path (shortItemTitle), and cacheKey=null gating.
 *
 * The pure helper `resolveAndCacheTitle` is already exhaustively tested in
 * useZoteroItemTitle.test.ts — these tests focus on the React glue.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { Provider, createStore } from 'jotai';

// Mock shortItemTitle before the hook module is imported so the default
// resolver path resolves through the stub. Same transitive-import reason
// as the pure-helper test file.
vi.mock('../../../src/utils/zoteroUtils', () => ({
    shortItemTitle: vi.fn(async (_item: any) => 'default-resolver-title'),
}));
vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

import { useZoteroItemTitle } from '../../../react/hooks/useZoteroItemTitle';
import { agentActionItemTitlesAtom } from '../../../react/atoms/messageUIState';
import { shortItemTitle } from '../../../src/utils/zoteroUtils';
import { logger } from '../../../src/utils/logger';
import { createMockItem } from '../../helpers/factories';

const zoteroItems = {
    getByLibraryAndKeyAsync: vi.fn(),
    getAsync: vi.fn(),
    loadDataTypes: vi.fn(),
};

beforeEach(() => {
    (globalThis as any).Zotero.Items = zoteroItems;
    zoteroItems.getByLibraryAndKeyAsync.mockReset();
    zoteroItems.getAsync.mockReset();
    zoteroItems.loadDataTypes.mockReset();
    zoteroItems.loadDataTypes.mockResolvedValue(undefined);
    zoteroItems.getAsync.mockResolvedValue(null);
    vi.mocked(shortItemTitle).mockReset();
    vi.mocked(shortItemTitle).mockResolvedValue('default-resolver-title');
    vi.mocked(logger).mockReset();
});

function renderWithStore<TProps>(
    callback: (props: TProps) => unknown,
    initialProps: TProps,
    store = createStore(),
) {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
        <Provider store={store}>{children}</Provider>
    );
    const result = renderHook(callback, { wrapper, initialProps });
    return { ...result, store };
}

describe('useZoteroItemTitle (mounted)', () => {
    it('cache miss: fetch → load → custom resolver → atom write', async () => {
        const item = createMockItem({ libraryID: 1, key: 'ABC' });
        zoteroItems.getByLibraryAndKeyAsync.mockResolvedValue(item);

        const { store } = renderWithStore(
            () =>
                useZoteroItemTitle({
                    libraryId: 1,
                    zoteroKey: 'ABC',
                    cacheKey: 'cache-1',
                    resolveTitle: () => 'custom-title',
                }),
            {},
        );

        await waitFor(() => {
            expect(store.get(agentActionItemTitlesAtom)).toEqual({ 'cache-1': 'custom-title' });
        });
        expect(zoteroItems.getByLibraryAndKeyAsync).toHaveBeenCalledWith(1, 'ABC');
        expect(zoteroItems.loadDataTypes).toHaveBeenCalledWith([item], ['itemData', 'note']);
    });

    it('cacheKey=null: returns null, does NOT call Zotero APIs', async () => {
        const { result } = renderWithStore(
            () =>
                useZoteroItemTitle({
                    libraryId: 1,
                    zoteroKey: 'ABC',
                    cacheKey: null,
                }),
            {},
        );

        // Flush microtasks so any stray effect would have a chance to fire.
        await Promise.resolve();

        expect(result.current).toBeNull();
        expect(zoteroItems.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });

    it('cache hit: pre-seeded atom returns cached title, does NOT re-fetch', async () => {
        const store = createStore();
        store.set(agentActionItemTitlesAtom, { 'cache-1': 'already-cached' });

        const { result } = renderWithStore(
            () =>
                useZoteroItemTitle({
                    libraryId: 1,
                    zoteroKey: 'ABC',
                    cacheKey: 'cache-1',
                }),
            {},
            store,
        );

        await Promise.resolve();

        expect(result.current).toBe('already-cached');
        expect(zoteroItems.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });

    it('inline resolver stability: rerender with a fresh resolver identity does NOT re-fetch', async () => {
        const item = createMockItem({ libraryID: 1, key: 'ABC' });
        zoteroItems.getByLibraryAndKeyAsync.mockResolvedValue(item);

        const { store, rerender } = renderWithStore(
            (p: { resolverTag: string }) =>
                useZoteroItemTitle({
                    libraryId: 1,
                    zoteroKey: 'ABC',
                    cacheKey: 'cache-1',
                    // New function identity each render — if the resolver were
                    // in the effect dep list, each rerender would re-fire the
                    // effect. The ref-held resolver prevents that.
                    resolveTitle: () => `resolver-${p.resolverTag}`,
                }),
                { resolverTag: 'a' },
        );

        await waitFor(() => {
            expect(store.get(agentActionItemTitlesAtom)).toEqual({ 'cache-1': 'resolver-a' });
        });
        expect(zoteroItems.getByLibraryAndKeyAsync).toHaveBeenCalledTimes(1);

        rerender({ resolverTag: 'b' });
        await Promise.resolve();
        await Promise.resolve();

        // Still only one fetch across the whole lifecycle. The atom value
        // also does not change — cachedTitle short-circuits the effect.
        expect(zoteroItems.getByLibraryAndKeyAsync).toHaveBeenCalledTimes(1);
        expect(store.get(agentActionItemTitlesAtom)).toEqual({ 'cache-1': 'resolver-a' });
    });

    it('unmount during fetch: cancellation prevents atom write and does not throw', async () => {
        const item = createMockItem({ libraryID: 1, key: 'ABC' });
        let resolveFetch: (value: any) => void = () => {};
        const pending = new Promise((resolve) => { resolveFetch = resolve; });
        zoteroItems.getByLibraryAndKeyAsync.mockReturnValue(pending);

        const { store, unmount } = renderWithStore(
            () =>
                useZoteroItemTitle({
                    libraryId: 1,
                    zoteroKey: 'ABC',
                    cacheKey: 'cache-1',
                    resolveTitle: () => 'unsafe-title',
                }),
            {},
        );

        // Unmount while the fetch is still pending. Hook cleanup sets
        // cancelled=true; the post-fetch check in the helper must short-circuit.
        unmount();
        resolveFetch(item);
        await Promise.resolve();
        await Promise.resolve();

        expect(store.get(agentActionItemTitlesAtom)).toEqual({});
        expect(vi.mocked(logger)).not.toHaveBeenCalled();
    });

    it('default resolver path: uses shortItemTitle when no resolveTitle is passed', async () => {
        const item = createMockItem({ libraryID: 1, key: 'ABC' });
        zoteroItems.getByLibraryAndKeyAsync.mockResolvedValue(item);

        const { store } = renderWithStore(
            () =>
                useZoteroItemTitle({
                    libraryId: 1,
                    zoteroKey: 'ABC',
                    cacheKey: 'cache-1',
                }),
            {},
        );

        await waitFor(() => {
            expect(store.get(agentActionItemTitlesAtom)).toEqual({ 'cache-1': 'default-resolver-title' });
        });
        expect(vi.mocked(shortItemTitle)).toHaveBeenCalledWith(item);
    });
});
