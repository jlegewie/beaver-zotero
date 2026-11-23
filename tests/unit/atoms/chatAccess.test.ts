/**
 * The sidebar must not offer sign-in while Beaver is still finding out whether
 * the user is signed in.
 */
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

vi.mock('../../../react/atoms/threads', async () => {
    const { atom } = await import('jotai');
    return { isLoadingThreadAtom: atom(false) };
});

import { chatAccessGateAtom } from '../../../react/atoms/chatAccess';
import { authLoadingAtom, sessionAtom } from '../../../react/atoms/auth';
import { isProfileLoadedAtom } from '../../../react/atoms/profile';

const session = { access_token: 'token', user: { id: 'a' } } as any;

describe('chat access gate during sign-in restore', () => {
    it('reports restoring, not signed out, until the account is initialized', () => {
        const store = createStore();
        store.set(authLoadingAtom, true);
        store.set(sessionAtom, null);
        expect(store.get(chatAccessGateAtom)).toBe('restoring');
    });

    it('reports signed out once the account is initialized without a session', () => {
        const store = createStore();
        store.set(authLoadingAtom, false);
        store.set(sessionAtom, null);
        expect(store.get(chatAccessGateAtom)).toBe('signed-out');
    });

    it('moves on to connecting as soon as a session is restored', () => {
        const store = createStore();
        store.set(authLoadingAtom, false);
        store.set(sessionAtom, session);
        store.set(isProfileLoadedAtom, false);
        expect(store.get(chatAccessGateAtom)).toBe('connecting');
    });
});
