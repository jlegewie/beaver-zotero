// @vitest-environment jsdom

/**
 * What the sidebar shows while the saved sign-in is being restored.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SessionRestorePage from '../../../../react/components/pages/SessionRestorePage';
import { sessionRestoreAtom } from '../../../../react/atoms/auth';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('SessionRestorePage', () => {
    let container: HTMLDivElement;
    let root: Root;
    let account: { retrySessionRestore: ReturnType<typeof vi.fn>; abandonSessionRestore: ReturnType<typeof vi.fn> };
    let previousBeaver: unknown;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        account = {
            retrySessionRestore: vi.fn().mockResolvedValue(undefined),
            abandonSessionRestore: vi.fn(),
        };
        previousBeaver = (Zotero as any).Beaver;
        (Zotero as any).Beaver = { account };
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        (Zotero as any).Beaver = previousBeaver;
    });

    const render = (restore: { attempt: number; offline: boolean; message: string } | null) => {
        const store = createStore();
        store.set(sessionRestoreAtom, restore);
        act(() => {
            root.render(React.createElement(Provider, { store }, React.createElement(SessionRestorePage)));
        });
    };
    const text = () => container.textContent ?? '';
    const button = (label: string) =>
        Array.from(container.querySelectorAll('button, a')).find((el) => el.textContent?.includes(label)) as HTMLElement | undefined;

    it('shows a plain connecting state with no actions while the first restore runs', () => {
        render(null);
        expect(text()).toContain('Connecting…');
        expect(text()).not.toContain('Sign in');
        expect(button('Try again')).toBeUndefined();
    });

    it('offers to sign in instead when the first restore takes long', () => {
        render({ attempt: 0, offline: false, message: '' });
        expect(text()).toContain('Still connecting…');
        expect(button('Try again')).toBeUndefined();
        act(() => button('Sign in again')!.click());
        expect(account.abandonSessionRestore).toHaveBeenCalledOnce();
    });

    it('says the user is still signed in and retries on request after a failure', async () => {
        render({ attempt: 3, offline: false, message: 'AuthRetryableFetchError' });
        expect(text()).toContain('Reconnecting…');
        expect(text()).toContain("You're still signed in");
        expect(text()).toContain('attempt 3');
        await act(async () => button('Try again')!.click());
        expect(account.retrySessionRestore).toHaveBeenCalledOnce();
    });

    it('waits for the connection while offline', () => {
        render({ attempt: 1, offline: true, message: '' });
        expect(text()).toContain("You're offline");
        expect(text()).toContain('reconnect automatically');
        expect(button('Sign in again')).toBeDefined();
    });
});
