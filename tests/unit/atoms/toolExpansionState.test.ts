import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
import {
    resetMessageUIStateAtom,
    setToolExpandedAtom,
    toolExpandedAtom,
    toolExpansionRevisionAtom,
} from '../../../react/atoms/messageUIState';

describe('tool expansion state', () => {
    it('reads undefined for a key never written, so the surface shows its default', () => {
        const store = createStore();
        expect(store.get(toolExpandedAtom('run-1:0:call-1'))).toBeUndefined();
    });

    it('stores an explicit value under its key, including false', () => {
        const store = createStore();
        store.set(setToolExpandedAtom, { key: 'run-1:0:call-1', expanded: false });
        store.set(setToolExpandedAtom, { key: 'run-1:0:call-2', expanded: true });

        expect(store.get(toolExpandedAtom('run-1:0:call-1'))).toBe(false);
        expect(store.get(toolExpandedAtom('run-1:0:call-2'))).toBe(true);
    });

    it('notifies only the readers of the key that was written', () => {
        const store = createStore();
        const first = vi.fn();
        const second = vi.fn();
        store.sub(toolExpandedAtom('run-1:0:call-3'), first);
        store.sub(toolExpandedAtom('run-1:0:call-4'), second);

        store.set(setToolExpandedAtom, { key: 'run-1:0:call-3', expanded: true });

        expect(first).toHaveBeenCalledTimes(1);
        expect(second).not.toHaveBeenCalled();
    });

    it('counts every write, even one that repeats the stored value', () => {
        const store = createStore();
        const before = store.get(toolExpansionRevisionAtom);

        store.set(setToolExpandedAtom, { key: 'run-1:0:call-5', expanded: true });
        store.set(setToolExpandedAtom, { key: 'run-1:0:call-5', expanded: true });

        expect(store.get(toolExpansionRevisionAtom)).toBe(before + 2);
    });

    it('clears every value and counts the change when the thread-local UI state is reset', () => {
        const store = createStore();
        const reader = toolExpandedAtom('run-1:0:call-6');
        store.set(setToolExpandedAtom, { key: 'run-1:0:call-6', expanded: true });
        const before = store.get(toolExpansionRevisionAtom);

        store.set(resetMessageUIStateAtom);

        expect(store.get(reader)).toBeUndefined();
        expect(store.get(toolExpandedAtom('run-1:0:call-6'))).toBeUndefined();
        expect(store.get(toolExpansionRevisionAtom)).toBe(before + 1);
    });
});
