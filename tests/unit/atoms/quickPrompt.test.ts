/**
 * What the quick prompt shortcut does, and how opening the popup prepares the
 * thread it composes into.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

const mocks = vi.hoisted(() => ({
    newThread: vi.fn(async (_options?: unknown) => {}),
    addItems: vi.fn(async (_items: unknown) => {}),
    reader: null as any,
    annotationItems: new Map<string, any>(),
}));

vi.mock('../../../react/atoms/threads', async () => {
    const { atom } = await import('jotai');
    return {
        newThreadAtom: atom(null, async (_get, _set, options?: unknown) => mocks.newThread(options)),
    };
});
vi.mock('../../../react/atoms/agentRunAtoms', async () => {
    const { atom } = await import('jotai');
    return { isWSChatPendingAtom: atom(false) };
});
vi.mock('../../../react/atoms/auth', async () => {
    const { atom } = await import('jotai');
    return { isAuthenticatedAtom: atom(true) };
});
vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return { isProfileLoadedAtom: atom(true) };
});
vi.mock('../../../react/atoms/ui', async () => {
    const { atom } = await import('jotai');
    const quickPromptStateAtom = atom<{ mode: string } | null>(null);
    return {
        isSidebarVisibleAtom: atom(false),
        isThreadListViewAtom: atom(false),
        quickPromptStateAtom,
        isQuickPromptOpenAtom: atom((get) => get(quickPromptStateAtom) !== null),
    };
});
vi.mock('../../../react/atoms/messageComposition', async () => {
    const { atom } = await import('jotai');
    return {
        currentReaderAttachmentAtom: atom<unknown>(null),
        addItemsToCurrentMessageItemsAtom: atom(null, async (_get, _set, items: unknown) => mocks.addItems(items)),
    };
});
vi.mock('../../../react/utils/readerUtils', () => ({ getCurrentReader: () => mocks.reader }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import type { AgentRun } from '@beaver/agent-core/agents/types';
import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';
import { isWSChatPendingAtom } from '../../../react/atoms/agentRunAtoms';
import { isAuthenticatedAtom } from '../../../react/atoms/auth';
import { isProfileLoadedAtom } from '../../../react/atoms/profile';
import { isSidebarVisibleAtom, isThreadListViewAtom } from '../../../react/atoms/ui';
import { currentReaderAttachmentAtom } from '../../../react/atoms/messageComposition';
import {
    closeQuickPromptAtom,
    hasActiveWorkAtom,
    isQuickPromptOpenAtom,
    openQuickPromptAtom,
    quickPromptStateAtom,
    toggleQuickPromptAtom,
} from '../../../react/atoms/quickPrompt';

function run(status: AgentRun['status']): AgentRun {
    return {
        id: 'run-1',
        user_id: 'user-1',
        thread_id: 'thread-1',
        agent_name: 'beaver',
        user_prompt: { content: 'Summarize', attachments: [] } as any,
        status,
        model_messages: [],
        model_name: 'test',
        created_at: '2026-09-08T10:00:00.000Z',
        consent_to_share: false,
    };
}

let store = createStore();

beforeEach(() => {
    vi.clearAllMocks();
    store = createStore();
    mocks.reader = null;
    mocks.annotationItems.clear();
    (globalThis as any).Zotero = {
        Items: {
            getByLibraryAndKeyAsync: async (_libraryID: number, key: string) => mocks.annotationItems.get(key) ?? null,
        },
    };
});

function attachment(id: number, libraryID = 1) {
    return { id, libraryID, key: `ATT${id}`, isAnnotation: () => false } as any;
}

function annotation(key: string) {
    const item = { key, libraryID: 1, isAnnotation: () => true } as any;
    mocks.annotationItems.set(key, item);
    return item;
}

describe('openQuickPromptAtom', () => {
    it('starts a fresh thread but keeps the draft, and leaves the chat list view', async () => {
        store.set(isThreadListViewAtom, true);
        await store.set(openQuickPromptAtom);
        expect(mocks.newThread).toHaveBeenCalledWith({ skipActiveRunConfirm: true, preserveDraft: true });
        expect(store.get(quickPromptStateAtom)).toEqual({ mode: 'compose' });
        expect(store.get(isThreadListViewAtom)).toBe(false);
        expect(store.get(isQuickPromptOpenAtom)).toBe(true);
    });

    it('shows the busy notice instead of touching a thread whose run is live', async () => {
        store.set(activeRunAtom, run('in_progress'));
        await store.set(openQuickPromptAtom);
        expect(mocks.newThread).not.toHaveBeenCalled();
        expect(store.get(quickPromptStateAtom)).toEqual({ mode: 'busy' });
    });

    it('treats a pending send as live work even before the run arrives', async () => {
        store.set(isWSChatPendingAtom, true);
        expect(store.get(hasActiveWorkAtom)).toBe(true);
        await store.set(openQuickPromptAtom);
        expect(mocks.newThread).not.toHaveBeenCalled();
        expect(store.get(quickPromptStateAtom)).toEqual({ mode: 'busy' });
    });

    it('attaches the annotations selected in the open reader', async () => {
        const file = attachment(82);
        const selected = annotation('ANN1');
        annotation('ANN2');
        mocks.reader = { itemID: 82, _internalReader: { _state: { selectedAnnotationIDs: ['ANN1', 'MISSING'] } } };
        store.set(currentReaderAttachmentAtom, file);
        await store.set(openQuickPromptAtom);
        expect(mocks.addItems).toHaveBeenCalledTimes(1);
        expect(mocks.addItems).toHaveBeenCalledWith([selected]);
        expect(store.get(quickPromptStateAtom)).toEqual({ mode: 'compose' });
    });

    it('does not attach annotations from a reader whose file is not the staged attachment', async () => {
        annotation('ANN1');
        mocks.reader = { itemID: 82, _internalReader: { _state: { selectedAnnotationIDs: ['ANN1'] } } };
        // An excluded library leaves no attachment; a different file is not the one in front of the user.
        store.set(currentReaderAttachmentAtom, null);
        await store.set(openQuickPromptAtom);
        store.set(currentReaderAttachmentAtom, attachment(99));
        await store.set(openQuickPromptAtom);
        expect(mocks.addItems).not.toHaveBeenCalled();
    });

    it('still opens when attaching the annotations fails', async () => {
        annotation('ANN1');
        mocks.reader = { itemID: 82, _internalReader: { _state: { selectedAnnotationIDs: ['ANN1'] } } };
        store.set(currentReaderAttachmentAtom, attachment(82));
        mocks.addItems.mockRejectedValueOnce(new Error('boom'));
        await store.set(openQuickPromptAtom);
        expect(store.get(quickPromptStateAtom)).toEqual({ mode: 'compose' });
    });

    it('does not count a finished run as live work', async () => {
        store.set(activeRunAtom, run('completed'));
        expect(store.get(hasActiveWorkAtom)).toBe(false);
        await store.set(openQuickPromptAtom);
        expect(store.get(quickPromptStateAtom)).toEqual({ mode: 'compose' });
    });
});

describe('toggleQuickPromptAtom', () => {
    it('opens the popup while the sidebar is closed', async () => {
        await expect(store.set(toggleQuickPromptAtom)).resolves.toBe('opened');
        expect(store.get(quickPromptStateAtom)).toEqual({ mode: 'compose' });
    });

    it('treats a second press while the first is still opening as the same press', async () => {
        let finish: () => void = () => {};
        mocks.newThread.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
        const first = store.set(toggleQuickPromptAtom);
        const second = store.set(toggleQuickPromptAtom);
        finish();
        await expect(first).resolves.toBe('opened');
        await expect(second).resolves.toBe('opened');
        expect(store.get(quickPromptStateAtom)).toEqual({ mode: 'compose' });
        expect(mocks.newThread).toHaveBeenCalledTimes(1);
    });

    it('closes an open popup', async () => {
        await store.set(openQuickPromptAtom);
        await expect(store.set(toggleQuickPromptAtom)).resolves.toBe('closed');
        expect(store.get(quickPromptStateAtom)).toBeNull();
    });

    it('hands the shortcut to the sidebar composer while the sidebar is open', async () => {
        store.set(isSidebarVisibleAtom, true);
        await expect(store.set(toggleQuickPromptAtom)).resolves.toBe('focus-sidebar');
        expect(store.get(quickPromptStateAtom)).toBeNull();
        expect(mocks.newThread).not.toHaveBeenCalled();
    });

    it('opens the sidebar instead when Beaver is signed out', async () => {
        store.set(isAuthenticatedAtom, false);
        await expect(store.set(toggleQuickPromptAtom)).resolves.toBe('open-sidebar');
        expect(store.get(quickPromptStateAtom)).toBeNull();
    });

    it('opens the sidebar instead while the profile is still loading', async () => {
        store.set(isProfileLoadedAtom, false);
        await expect(store.set(toggleQuickPromptAtom)).resolves.toBe('open-sidebar');
    });
});

describe('closeQuickPromptAtom', () => {
    it('clears the popup state', async () => {
        await store.set(openQuickPromptAtom);
        store.set(closeQuickPromptAtom);
        expect(store.get(isQuickPromptOpenAtom)).toBe(false);
    });
});
