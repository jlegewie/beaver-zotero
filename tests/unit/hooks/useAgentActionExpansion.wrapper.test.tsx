/** @vitest-environment jsdom */
/**
 * Mounted wrapper tests for `useAgentActionExpansion`. Cover the wiring
 * that the pure-helper tests leave uncovered: atom reads/writes, useEffect
 * dep list (non-trigger params must NOT re-fire the effect), setExpanded
 * vs toggleExpanded gating, and the forceCollapsedWhen compute-time override.
 *
 * Each test owns its own Jotai store via `createStore()` to prevent cross-
 * test state bleed.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { useAgentActionExpansion } from '../../../react/hooks/useAgentActionExpansion';
import { toolExpandedAtom } from '../../../react/atoms/messageUIState';

function renderWithStore<T>(
    callback: (props: T) => unknown,
    initialProps: T,
    store = createStore(),
) {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
        <Provider store={store}>{children}</Provider>
    );
    const result = renderHook(callback, { wrapper, initialProps });
    return { ...result, store };
}

describe('useAgentActionExpansion (mounted)', () => {
    it('writes initial expansion value to the atom on first mount when no entry exists', () => {
        const { store } = renderWithStore(
            (p: { autoExpandWhen: boolean }) =>
                useAgentActionExpansion({ expansionKey: 'k1', autoExpandWhen: p.autoExpandWhen }),
            { autoExpandWhen: true },
        );
        expect(store.get(toolExpandedAtom)).toEqual({ k1: true });

        const { store: store2 } = renderWithStore(
            (p: { autoExpandWhen: boolean }) =>
                useAgentActionExpansion({ expansionKey: 'k2', autoExpandWhen: p.autoExpandWhen }),
            { autoExpandWhen: false },
        );
        expect(store2.get(toolExpandedAtom)).toEqual({ k2: false });
    });

    it('does not overwrite atom when an entry already exists on first mount', () => {
        const store = createStore();
        store.set(toolExpandedAtom, { k1: false });

        renderWithStore(
            () => useAgentActionExpansion({
                expansionKey: 'k1',
                autoExpandWhen: true, // would have written true if effect overwrote
            }),
            {},
            store,
        );

        expect(store.get(toolExpandedAtom)).toEqual({ k1: false });
    });

    it('writes to atom on autoExpandWhen transition (false → true)', () => {
        const { store, rerender } = renderWithStore(
            (p: { autoExpandWhen: boolean }) =>
                useAgentActionExpansion({ expansionKey: 'k1', autoExpandWhen: p.autoExpandWhen }),
            { autoExpandWhen: false },
        );
        expect(store.get(toolExpandedAtom)).toEqual({ k1: false });

        rerender({ autoExpandWhen: true });
        expect(store.get(toolExpandedAtom)).toEqual({ k1: true });
    });

    it('does NOT write when autoExpandWhen is unchanged but initialExpanded changes (regression guard for error-only clause)', () => {
        const store = createStore();
        // Seed so initial-write path is skipped; we want to observe only
        // transition behavior.
        store.set(toolExpandedAtom, { k1: false });

        const { rerender } = renderWithStore(
            (p: { initialExpanded: boolean | undefined }) =>
                useAgentActionExpansion({
                    expansionKey: 'k1',
                    autoExpandWhen: false,
                    initialExpanded: p.initialExpanded,
                }),
            { initialExpanded: undefined },
            store,
        );
        expect(store.get(toolExpandedAtom)).toEqual({ k1: false });

        // Only initialExpanded flips; autoExpandWhen stays false. Atom must
        // not change — the hook's effect is keyed only to autoExpandWhen.
        rerender({ initialExpanded: true });
        expect(store.get(toolExpandedAtom)).toEqual({ k1: false });
    });

    it('setExpanded(true) writes unconditionally, even when forceCollapsedWhen=true', () => {
        const { store, result } = renderWithStore(
            () =>
                useAgentActionExpansion({
                    expansionKey: 'k1',
                    autoExpandWhen: false,
                    forceCollapsedWhen: true, // compute-time collapse
                }),
            {},
        );
        // Visible value stays false because forceCollapsedWhen overrides.
        expect(result.current.isExpanded).toBe(false);

        act(() => {
            result.current.setExpanded(true);
        });

        // Atom was written — preserves the undo-error auto-expand path.
        expect(store.get(toolExpandedAtom)).toEqual({ k1: true });
        // But visible value still false while the gate holds.
        expect(result.current.isExpanded).toBe(false);
    });

    it('toggleExpanded() is a no-op when forceCollapsedWhen=true', () => {
        const store = createStore();
        store.set(toolExpandedAtom, { k1: false });

        const { result } = renderWithStore(
            () =>
                useAgentActionExpansion({
                    expansionKey: 'k1',
                    autoExpandWhen: false,
                    forceCollapsedWhen: true,
                }),
            {},
            store,
        );

        act(() => {
            result.current.toggleExpanded();
        });

        // Atom unchanged — toggle was suppressed by the streaming gate.
        expect(store.get(toolExpandedAtom)).toEqual({ k1: false });
    });

    it('toggleExpanded() inverts atom value when forceCollapsedWhen=false', () => {
        const store = createStore();
        store.set(toolExpandedAtom, { k1: false });

        const { result } = renderWithStore(
            () =>
                useAgentActionExpansion({
                    expansionKey: 'k1',
                    autoExpandWhen: false,
                    forceCollapsedWhen: false,
                }),
            {},
            store,
        );

        act(() => {
            result.current.toggleExpanded();
        });
        expect(store.get(toolExpandedAtom)).toEqual({ k1: true });

        act(() => {
            result.current.toggleExpanded();
        });
        expect(store.get(toolExpandedAtom)).toEqual({ k1: false });
    });
});
