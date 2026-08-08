/**
 * `currentThreadIdAtom` is defined with the run state and re-exported from the
 * thread module, so consumers import it from either path. If that ever becomes
 * two atom instances, thread state splits silently: components read an atom
 * nobody writes, and no other test notices.
 */
import { describe, expect, it } from 'vitest';
import { createStore } from 'jotai';
import { currentThreadIdAtom as fromRunState } from '../../../react/agents/atoms';
import { currentThreadIdAtom as fromThreads } from '../../../react/atoms/threads';

describe('currentThreadIdAtom', () => {
    it('is one atom whichever module it is imported from', () => {
        // Guards against both bindings being undefined, which would make the
        // identity check below pass vacuously.
        expect(fromRunState).toBeDefined();
        expect(fromThreads).toBeDefined();
        expect(fromRunState).toBe(fromThreads);
    });

    it('carries writes made through either module', () => {
        const store = createStore();

        store.set(fromRunState, 'thread-a');
        expect(store.get(fromThreads)).toBe('thread-a');

        store.set(fromThreads, 'thread-b');
        expect(store.get(fromRunState)).toBe('thread-b');
    });
});
