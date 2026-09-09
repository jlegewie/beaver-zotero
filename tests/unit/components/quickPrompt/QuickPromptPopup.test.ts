// @vitest-environment jsdom

/**
 * When the quick prompt popup shows, and what makes it go away.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    dispatch: vi.fn(),
    subscribers: new Map<string, (detail: unknown) => void>(),
    focusToggleButton: vi.fn(),
    newThread: vi.fn(async (_options?: unknown) => {}),
}));

vi.mock('../../../../react/events/eventManager', () => ({
    eventManager: {
        dispatch: mocks.dispatch,
        subscribe: (name: string, callback: (detail: unknown) => void) => {
            mocks.subscribers.set(name, callback);
            return () => { mocks.subscribers.delete(name); };
        },
    },
}));
vi.mock('../../../../react/ui/UIManager', () => ({
    uiManager: { focusToggleButton: mocks.focusToggleButton },
}));
vi.mock('../../../../react/atoms/threads', async () => {
    const { atom } = await import('jotai');
    return {
        threadNavigationSeqAtom: atom(0),
        newThreadAtom: atom(null, async (_get, _set, options?: unknown) => mocks.newThread(options)),
    };
});
vi.mock('../../../../react/atoms/agentRunAtoms', async () => {
    const { atom } = await import('jotai');
    return { isWSChatPendingAtom: atom(false) };
});
vi.mock('../../../../react/atoms/chatAccess', async () => {
    const { atom } = await import('jotai');
    return { chatAccessGateAtom: atom<string | null>(null) };
});
vi.mock('../../../../react/atoms/runStatusPopup', async () => {
    const { atom } = await import('jotai');
    return { runStatusPopupEnabledAtom: atom(true) };
});
vi.mock('../../../../react/atoms/ui', async () => {
    const { atom } = await import('jotai');
    const quickPromptStateAtom = atom<{ mode: string } | null>(null);
    return {
        isSidebarVisibleAtom: atom(false),
        isThreadListViewAtom: atom(false),
        selectedZoteroTabIdAtom: atom<string | null>('tab-library'),
        quickPromptStateAtom,
        isQuickPromptOpenAtom: atom((get) => get(quickPromptStateAtom) !== null),
    };
});
vi.mock('../../../../react/atoms/messageComposition', async () => {
    const { atom } = await import('jotai');
    return {
        currentReaderAttachmentAtom: atom<unknown>(null),
        addItemsToCurrentMessageItemsAtom: atom(null, async () => {}),
    };
});
vi.mock('../../../../react/utils/readerUtils', () => ({ getCurrentReader: () => null }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
// The composer drags in the whole Zotero-side composition stack; a stub that
// exposes an editor to press keys in is all these tests need.
vi.mock('../../../../react/components/input/InputArea', () => ({
    default: () => React.createElement('div', { className: 'stub-composer' },
        React.createElement('div', { className: 'beaver-lexical-content', contentEditable: true, tabIndex: 0, 'data-testid': 'editor' })),
}));
vi.mock('../../../../react/components/input/DragDropWrapper', () => ({
    default: ({ children }: { children: React.ReactNode }) => React.createElement('div', { 'data-testid': 'drop-zone' }, children),
}));
vi.mock('../../../../react/components/PopupOverlayContainer', () => ({ default: () => null }));
vi.mock('../../../../react/components/runStatusPopup/RunPulse', () => ({ default: () => null }));

import type { AgentRun } from '@beaver/agent-core/agents/types';
import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';
import { isWSChatPendingAtom } from '../../../../react/atoms/agentRunAtoms';
import { isSidebarVisibleAtom, selectedZoteroTabIdAtom } from '../../../../react/atoms/ui';
import { chatAccessGateAtom } from '../../../../react/atoms/chatAccess';
import { runStatusPopupEnabledAtom } from '../../../../react/atoms/runStatusPopup';
import { quickPromptStateAtom } from '../../../../react/atoms/quickPrompt';
import QuickPromptPopup from '../../../../react/components/quickPrompt/QuickPromptPopup';

function run(status: AgentRun['status']): AgentRun {
    return {
        id: 'run-1',
        user_id: 'user-1',
        thread_id: 'thread-1',
        agent_name: 'beaver',
        user_prompt: { content: 'Summarize the neighborhood effects literature', attachments: [] } as any,
        status,
        model_messages: [],
        model_name: 'test',
        created_at: '2026-09-08T10:00:00.000Z',
        consent_to_share: false,
    };
}

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let store = createStore();
let root: Root | null = null;
let container: HTMLDivElement;
let floatingRoot: HTMLDivElement;

function mount() {
    floatingRoot = document.createElement('div');
    floatingRoot.id = 'beaver-pane-floating-popup';
    container = document.createElement('div');
    floatingRoot.appendChild(container);
    document.body.appendChild(floatingRoot);
    root = createRoot(container);
    act(() => {
        root!.render(React.createElement(Provider, { store }, React.createElement(QuickPromptPopup)));
    });
}

async function fireShortcut() {
    await act(async () => {
        mocks.subscribers.get('toggleQuickPrompt')?.({});
        await Promise.resolve();
    });
}

function pressEscape(target: Element) {
    act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.subscribers.clear();
    (globalThis as any).Zotero = { getMainWindow: () => window };
    store = createStore();
});

afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    floatingRoot.remove();
});

describe('QuickPromptPopup', () => {
    it('draws nothing until the shortcut opens it', () => {
        mount();
        expect(container.querySelector('.beaver-quick-prompt')).toBeNull();
    });

    it('opens on the shortcut with the composer on a fresh thread', async () => {
        mount();
        await fireShortcut();
        expect(store.get(quickPromptStateAtom)).toEqual({ mode: 'compose' });
        expect(container.querySelector('[data-testid="drop-zone"] .stub-composer')).not.toBeNull();
        expect(mocks.newThread).toHaveBeenCalledWith({ skipActiveRunConfirm: true, preserveDraft: true });
    });

    it('offers a close button that names the Escape shortcut', async () => {
        mount();
        await fireShortcut();
        expect(container.querySelector('.beaver-quick-prompt__header')).toBeNull();
        const close = container.querySelector<HTMLButtonElement>('.beaver-quick-prompt__dismiss button[aria-label="Close"]')!;
        expect(close).not.toBeNull();
        act(() => { close.click(); });
        expect(store.get(quickPromptStateAtom)).toBeNull();
    });

    it('focuses the sidebar composer instead while the sidebar is open', async () => {
        store.set(isSidebarVisibleAtom, true);
        mount();
        await fireShortcut();
        expect(mocks.dispatch).toHaveBeenCalledWith('focusInput', {});
        expect(store.get(quickPromptStateAtom)).toBeNull();
    });

    it('closes on Escape from the editor and returns focus where it was', async () => {
        const tree = document.createElement('button');
        document.body.appendChild(tree);
        tree.focus();
        mount();
        await fireShortcut();
        const editor = container.querySelector('[data-testid="editor"]')!;
        pressEscape(editor);
        expect(store.get(quickPromptStateAtom)).toBeNull();
        expect(container.querySelector('.beaver-quick-prompt')).toBeNull();
        expect(document.activeElement).toBe(tree);
        tree.remove();
    });

    it('leaves Escape to a menu the composer has open', async () => {
        mount();
        await fireShortcut();
        const menu = document.createElement('div');
        menu.setAttribute('role', 'menu');
        floatingRoot.appendChild(menu);
        pressEscape(container.querySelector('[data-testid="editor"]')!);
        expect(store.get(quickPromptStateAtom)).toEqual({ mode: 'compose' });
        menu.remove();
        pressEscape(container.querySelector('[data-testid="editor"]')!);
        expect(store.get(quickPromptStateAtom)).toBeNull();
    });

    it('ignores an Escape another handler has already claimed', async () => {
        mount();
        await fireShortcut();
        const editor = container.querySelector('[data-testid="editor"]')!;
        act(() => {
            const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
            event.preventDefault();
            editor.dispatchEvent(event);
        });
        expect(store.get(quickPromptStateAtom)).toEqual({ mode: 'compose' });
    });

    it('closes after sending without focusing the toolbar', async () => {
        mount();
        await fireShortcut();
        act(() => { store.set(isWSChatPendingAtom, true); });
        expect(store.get(quickPromptStateAtom)).toBeNull();
        expect(mocks.focusToggleButton).not.toHaveBeenCalled();
    });

    it('hands focus from the sent composer to the approval button', async () => {
        mount();
        await fireShortcut();
        container.querySelector<HTMLElement>('[data-testid="editor"]')!.focus();
        act(() => { store.set(isWSChatPendingAtom, true); });
        const card = document.createElement('div');
        card.className = 'beaver-run-status-popup__card';
        const approve = document.createElement('button');
        approve.setAttribute('data-run-status-approve', '');
        card.appendChild(approve);
        floatingRoot.appendChild(card);
        act(() => { store.set(activeRunAtom, run('in_progress')); });
        expect(document.activeElement).toBe(approve);
        expect(mocks.focusToggleButton).not.toHaveBeenCalled();
    });

    it('restores the original focus after sending when run popups are disabled', async () => {
        store.set(runStatusPopupEnabledAtom, false);
        const tree = document.createElement('button');
        document.body.appendChild(tree);
        tree.focus();
        mount();
        await fireShortcut();
        container.querySelector<HTMLElement>('[data-testid="editor"]')!.focus();
        act(() => { store.set(isWSChatPendingAtom, true); });
        expect(document.activeElement).toBe(tree);
        tree.remove();
    });

    it('closes when the sidebar opens over it', async () => {
        mount();
        await fireShortcut();
        act(() => { store.set(isSidebarVisibleAtom, true); });
        expect(store.get(quickPromptStateAtom)).toBeNull();
    });

    it('closes when the user switches tabs, leaving focus where Zotero put it', async () => {
        mount();
        await fireShortcut();
        const elsewhere = document.createElement('button');
        document.body.appendChild(elsewhere);
        elsewhere.focus();
        act(() => { store.set(selectedZoteroTabIdAtom, 'tab-reader-1'); });
        expect(store.get(quickPromptStateAtom)).toBeNull();
        expect(document.activeElement).toBe(elsewhere);
        expect(mocks.focusToggleButton).not.toHaveBeenCalled();
        elsewhere.remove();
    });

    it('stays open while the tab does not change', async () => {
        mount();
        await fireShortcut();
        act(() => { store.set(selectedZoteroTabIdAtom, 'tab-library'); });
        expect(store.get(quickPromptStateAtom)).toEqual({ mode: 'compose' });
    });

    it('is tied to the tab it was reopened in, not the one from an earlier open', async () => {
        mount();
        await fireShortcut();
        act(() => { store.set(selectedZoteroTabIdAtom, 'tab-reader-1'); });
        expect(store.get(quickPromptStateAtom)).toBeNull();
        await fireShortcut();
        expect(store.get(quickPromptStateAtom)).toEqual({ mode: 'compose' });
        act(() => { store.set(selectedZoteroTabIdAtom, 'tab-reader-2'); });
        expect(store.get(quickPromptStateAtom)).toBeNull();
    });

    it('shows the busy notice while a run is live, and closes when it ends', async () => {
        store.set(activeRunAtom, run('in_progress'));
        mount();
        await fireShortcut();
        expect(store.get(quickPromptStateAtom)).toEqual({ mode: 'busy' });
        expect(container.querySelector('.beaver-quick-prompt__card--busy')?.textContent).toContain('Beaver is still working');
        expect(container.querySelector('.stub-composer')).toBeNull();
        expect(container.querySelector('[data-testid="drop-zone"]')).toBeNull();
        act(() => { store.set(activeRunAtom, run('completed')); });
        expect(store.get(quickPromptStateAtom)).toBeNull();
    });

    it('opens Beaver from the busy notice', async () => {
        store.set(activeRunAtom, run('in_progress'));
        mount();
        await fireShortcut();
        const open = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Open Beaver'))!;
        act(() => { open.click(); });
        expect(mocks.dispatch).toHaveBeenCalledWith('toggleChat', { forceOpen: true });
    });

    it('explains a gated account and offers Beaver instead of a composer', async () => {
        store.set(chatAccessGateAtom as any, 'signed-out');
        mount();
        await fireShortcut();
        expect(store.get(quickPromptStateAtom)).toEqual({ mode: 'blocked', reason: 'signed-out' });
        expect(container.querySelector('.stub-composer')).toBeNull();
        expect(container.querySelector('[data-testid="drop-zone"]')).toBeNull();
        expect(container.textContent).toContain('Sign in to use Beaver');
        const open = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Open Beaver'))!;
        act(() => { open.click(); });
        expect(mocks.dispatch).toHaveBeenCalledWith('toggleChat', { forceOpen: true });
    });

    it('moves from a loading notice to the composer once Beaver is ready', async () => {
        store.set(chatAccessGateAtom as any, 'connecting');
        mount();
        await fireShortcut();
        expect(container.textContent).toContain('Beaver is still loading');
        await act(async () => {
            store.set(chatAccessGateAtom as any, null);
            await Promise.resolve();
        });
        expect(store.get(quickPromptStateAtom)).toEqual({ mode: 'compose' });
        expect(container.querySelector('[data-testid="drop-zone"] .stub-composer')).not.toBeNull();
    });

    it('toggles closed on a second shortcut press', async () => {
        mount();
        await fireShortcut();
        await fireShortcut();
        expect(store.get(quickPromptStateAtom)).toBeNull();
    });
});
