import { useCallback } from 'react';
import type { WritableAtom } from 'jotai';
import { runSessionStore } from '../runtime/runSessionStore';

/**
 * `useSetAtom` for chat state the run session owns (`sessionStateAtoms`), or
 * an action atom that writes it: the write goes to the session's store, which
 * the window's copies follow.
 */
export function useSessionSetAtom<Value, Args extends unknown[], Result>(
    atom: WritableAtom<Value, Args, Result>,
): (...args: Args) => Result {
    return useCallback((...args: Args) => runSessionStore().set(atom, ...args), [atom]);
}
