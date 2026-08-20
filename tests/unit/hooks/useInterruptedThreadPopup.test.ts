// @vitest-environment jsdom

/**
 * The start-up offer to reopen the chat a shutdown interrupted.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider, useSetAtom } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
    clearInterruptedThreadMock,
    dispatchMock,
    getInterruptedThreadMock,
} = vi.hoisted(() => ({
    clearInterruptedThreadMock: vi.fn(),
    dispatchMock: vi.fn(),
    getInterruptedThreadMock: vi.fn(),
}));

vi.mock('../../../src/utils/interruptedThreadPrefs', () => ({
    clearInterruptedThread: clearInterruptedThreadMock,
    getInterruptedThread: getInterruptedThreadMock,
}));
vi.mock('../../../react/events/eventManager', () => ({
    eventManager: { dispatch: dispatchMock },
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('@beaver/agent-core/transport/agentService', () => ({
    agentService: { cancel: vi.fn(), close: vi.fn(), connect: vi.fn(), isConnected: vi.fn(() => false) },
    AgentConnectionError: class AgentConnectionError extends Error {},
}));
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn(), refreshSession: vi.fn() } },
}));
vi.mock('../../../react/atoms/applicationState', () => ({
    getApplicationStateProvider: vi.fn(() => async () => ({})),
}));
vi.mock('../../../src/services/systemNotifications', () => ({
    notifyRunComplete: vi.fn(),
    notifyUserQuestion: vi.fn(),
}));
vi.mock('../../../src/beaver-extract', () => ({ prewarmMuPDFWorker: vi.fn() }));

import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import type { InterruptedThread } from '../../../src/utils/interruptedThreadPrefs';
import { store } from '../../../react/store';
import { sessionAtom } from '../../../react/atoms/auth';
import { addFloatingPopupMessageAtom, floatingPopupMessagesAtom } from '../../../react/atoms/floatingPopup';
import type { PopupMessage } from '../../../react/types/popupMessage';
import {
    INTERRUPTED_THREAD_POPUP_ID,
    useInterruptedThreadPopup,
} from '../../../react/hooks/useInterruptedThreadPopup';

const INTERRUPTED: InterruptedThread = {
    threadId: 'thread-1',
    userId: 'user-1',
    threadName: 'Protein folding',
    closedAt: '2026-08-20T10:00:00.000Z',
};

/**
 * Stands in for the preference the hook consumes, so a second window really
 * reads what the first one wrote (or cleared).
 */
let record: InterruptedThread | null = null;

const roots: { root: Root; container: HTMLDivElement }[] = [];

/** Mounts the hook against the shared store, the way the global initializer does. */
function mount() {
    const Harness: React.FC = () => {
        useInterruptedThreadPopup();
        return null;
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    act(() => {
        root.render(React.createElement(Provider, { store }, React.createElement(Harness)));
    });
}

function popups(): PopupMessage[] {
    return store.get(floatingPopupMessagesAtom).filter((msg) => msg.id === INTERRUPTED_THREAD_POPUP_ID);
}

function popup(): PopupMessage | undefined {
    return popups()[0];
}

/** Signs in; the hook waits for a session before offering anything. */
function signIn(userId = 'user-1') {
    store.set(sessionAtom, { access_token: 'token', user: { id: userId } } as any);
}

beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    record = { ...INTERRUPTED };
    getInterruptedThreadMock.mockImplementation(() => record);
    clearInterruptedThreadMock.mockImplementation(() => { record = null; });
    store.set(floatingPopupMessagesAtom, []);
    store.set(currentThreadIdAtom, null);
    store.set(sessionAtom, null);
});

afterEach(() => {
    act(() => { roots.forEach(({ root }) => root.unmount()); });
    roots.forEach(({ container }) => container.remove());
    roots.length = 0;
});

describe('offering to reopen an interrupted chat', () => {
    it('shows a popup naming the interrupted chat', () => {
        signIn();
        mount();

        expect(popup()).toMatchObject({
            type: 'info',
            title: 'Beaver chat was interrupted',
            expire: false,
        });
        expect(popup()?.text).toContain('Protein folding');
    });

    it('reopens the thread when the button is clicked', () => {
        signIn();
        mount();

        popup()!.button!.onClick();

        expect(dispatchMock).toHaveBeenCalledExactlyOnceWith('loadThread', { threadId: 'thread-1' });
    });

    it('offers the chat in only one of two open windows', () => {
        signIn();
        mount();
        mount();

        expect(popups()).toHaveLength(1);
        // A second window that showed it would have consumed the record again.
        expect(clearInterruptedThreadMock).toHaveBeenCalledOnce();
    });

    it('does not offer the chat again after a window reloads', () => {
        signIn();
        mount();
        act(() => { store.set(floatingPopupMessagesAtom, []); });

        mount();

        expect(popup()).toBeUndefined();
    });

    it('says nothing about a chat that was never named', () => {
        record = { ...INTERRUPTED, threadName: null };
        signIn();
        mount();

        expect(popup()?.text).toBe('Beaver closed before it finished working on your last chat.');
    });

    it('shows nothing when no chat was interrupted', () => {
        record = null;
        signIn();
        mount();

        expect(popup()).toBeUndefined();
        expect(clearInterruptedThreadMock).not.toHaveBeenCalled();
    });

    it('waits for the session rather than dropping the record', () => {
        mount();

        expect(popup()).toBeUndefined();
        expect(clearInterruptedThreadMock).not.toHaveBeenCalled();

        act(() => { signIn(); });

        expect(popup()).toBeDefined();
    });

    it('discards a chat belonging to a different account', () => {
        signIn('user-2');
        mount();

        expect(popup()).toBeUndefined();
        expect(clearInterruptedThreadMock).toHaveBeenCalledOnce();
        expect(dispatchMock).not.toHaveBeenCalled();
    });

    it('consumes the record without a popup when that chat is already open', () => {
        store.set(currentThreadIdAtom, 'thread-1');
        signIn();
        mount();

        expect(popup()).toBeUndefined();
        expect(clearInterruptedThreadMock).toHaveBeenCalledOnce();
    });

    it('waits out a version-update popup added in the same commit', () => {
        // The upgrade hook is mounted first and adds its tour from an effect,
        // so this hook's render-time snapshot of the list is still empty.
        const Upgrade: React.FC = () => {
            const add = useSetAtom(addFloatingPopupMessageAtom);
            React.useEffect(() => {
                add({ id: 'version-popup', type: 'version_update', expire: false });
            }, [add]);
            return null;
        };
        const Interrupted: React.FC = () => {
            useInterruptedThreadPopup();
            return null;
        };
        signIn();

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        roots.push({ root, container });
        act(() => {
            root.render(
                React.createElement(
                    Provider,
                    { store },
                    React.createElement(Upgrade),
                    React.createElement(Interrupted),
                ),
            );
        });

        expect(popup()).toBeUndefined();
        expect(clearInterruptedThreadMock).not.toHaveBeenCalled();
    });

    it('waits out a version-update popup instead of stacking on it', () => {
        store.set(floatingPopupMessagesAtom, [
            { id: 'version-popup', type: 'version_update', expire: false } as PopupMessage,
        ]);
        signIn();
        mount();

        expect(popup()).toBeUndefined();
        expect(clearInterruptedThreadMock).not.toHaveBeenCalled();

        // Dismissing the tour releases the offer.
        act(() => { store.set(floatingPopupMessagesAtom, []); });

        expect(popup()).toBeDefined();
    });
});
