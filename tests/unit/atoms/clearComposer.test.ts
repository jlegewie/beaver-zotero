/**
 * `clearComposerAtom` is the choke point for discarding a draft (new thread,
 * thread switch, after sending). Everything an action staged for that draft
 * must go with it: an action attaches its targets when the user picks it, so a
 * pill left waiting for insertion would surface in the next draft with nothing
 * behind it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { atom, createStore } from 'jotai';

// The real module's import chain reaches Supabase and Zotero APIs at load
// time; stub those out.
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test' })),
}));

vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(() => true),
    setPref: vi.fn(),
}));

vi.mock('../../../react/utils/popupMessageUtils', async () => {
    const { atom: jotaiAtom } = await import('jotai');
    return {
        addPopupMessageAtom: jotaiAtom(null, () => undefined),
        addRegularItemPopupAtom: jotaiAtom(null, () => undefined),
        addRegularItemsSummaryPopupAtom: jotaiAtom(null, () => undefined),
        removePopupMessageAtom: jotaiAtom(null, () => undefined),
        safeChildAttachments: vi.fn(() => []),
    };
});

vi.mock('../../../react/atoms/itemValidation', async () => {
    const { atom: jotaiAtom } = await import('jotai');
    return {
        getItemValidationAtom: jotaiAtom(() => () => undefined),
        isHardBlockedValidation: vi.fn(() => false),
        isRejectedItemValidation: vi.fn(() => false),
        validateItemsAtom: jotaiAtom(null, () => Promise.resolve()),
        validateRegularItemAtom: jotaiAtom(null, () => Promise.resolve()),
    };
});

vi.mock('../../../react/components/ui/popup/InvalidItemsMessageContent', () => ({
    InvalidItemsMessageContent: () => null,
}));

vi.mock('../../../react/utils/readerUtils', () => ({
    getCurrentReader: vi.fn(() => undefined),
}));

// The add path pre-filters with the real support check, which needs a fuller
// Zotero.Item than these tests build.
vi.mock('../../../src/utils/agentItemSupport', () => ({
    agentItemFilter: vi.fn(() => true),
}));

vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: atom<number[]>([1]),
}));

const {
    addItemsToCurrentMessageItemsAtom,
    clearComposerAtom,
    composerResetTokenAtom,
    currentMessageContentAtom,
    currentMessageItemsAtom,
    currentMessagePillsAtom,
    pendingPillInsertsAtom,
    removeItemFromMessageAtom,
} = await import('../../../react/atoms/messageComposition');

const pill = { commandName: 'summarize', actionId: 'custom-1' };

function draftStore() {
    const store = createStore();
    store.set(currentMessageContentAtom, '/summarize draft text');
    store.set(currentMessagePillsAtom, [pill]);
    return store;
}

describe('clearComposerAtom', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('clears the text and the pills in it', () => {
        const store = draftStore();
        store.set(clearComposerAtom);
        expect(store.get(currentMessageContentAtom)).toBe('');
        expect(store.get(currentMessagePillsAtom)).toEqual([]);
    });

    it('cancels pills that were staged but not yet inserted', () => {
        // An editor claims a staged pill on a timer, so a thread switch can
        // land between staging and insertion. Their targets went with the
        // draft, so none of them may reach the next one.
        const store = draftStore();
        store.set(pendingPillInsertsAtom, [{ descriptor: pill }, { descriptor: pill }]);
        store.set(clearComposerAtom);
        expect(store.get(pendingPillInsertsAtom)).toEqual([]);
    });

    it('bumps the reset token so mounted editors learn about the clear', () => {
        const store = draftStore();
        const before = store.get(composerResetTokenAtom);
        store.set(clearComposerAtom);
        expect(store.get(composerResetTokenAtom)).toBe(before + 1);
    });

    it('bumps the reset token even when the composer is already empty', () => {
        const store = createStore();
        const before = store.get(composerResetTokenAtom);
        store.set(clearComposerAtom);
        expect(store.get(composerResetTokenAtom)).toBe(before + 1);
        expect(store.get(pendingPillInsertsAtom)).toEqual([]);
    });
});

// A Zotero key is only unique within its library, so two libraries can hold
// the same key. Attached items — including the targets an action binds — are
// identified by library and key together.
describe('attached item identity', () => {
    const item = (libraryID: number, key: string) => ({
        libraryID,
        key,
        isRegularItem: () => true,
        isAttachment: () => false,
        isNote: () => false,
        isAnnotation: () => false,
    }) as unknown as Zotero.Item;

    beforeEach(() => {
        vi.stubGlobal('Zotero', { Items: {} });
    });

    it('adds an item that shares a key with one from another library', async () => {
        const store = createStore();
        const mine = item(1, 'SAMEKEY');
        const group = item(2, 'SAMEKEY');
        await store.set(addItemsToCurrentMessageItemsAtom, [mine]);
        await store.set(addItemsToCurrentMessageItemsAtom, [group]);
        expect(store.get(currentMessageItemsAtom)).toEqual([mine, group]);
    });

    it('removes only the item from the library it was removed in', () => {
        const store = createStore();
        const mine = item(1, 'SAMEKEY');
        const group = item(2, 'SAMEKEY');
        store.set(currentMessageItemsAtom, [mine, group]);
        store.set(removeItemFromMessageAtom, group);
        expect(store.get(currentMessageItemsAtom)).toEqual([mine]);
    });
});
