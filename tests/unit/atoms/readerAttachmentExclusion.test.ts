/**
 * `updateReaderAttachmentAtom` is the choke point for the reader attachment
 * that Beaver treats as live chat context (input chip, prompt variables,
 * `application_state`). An attachment in a library the user excluded from
 * Beaver must never enter it — and must not even be read out of Zotero.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { atom, createStore } from 'jotai';

// The real module's import chain reaches Supabase and Zotero APIs at load
// time; stub those out.
vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test' })),
}));

vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(() => true),
    setPref: vi.fn(),
}));

// Spy on the excluded-library notice so tests can assert the user is told why
// the open file did not become context.
const { excludedLibraryPopupMock, removePopupMock } = vi.hoisted(() => ({
    excludedLibraryPopupMock: vi.fn(),
    removePopupMock: vi.fn(),
}));

// The real module pulls in popup UI, validation, and reader utils. Mock the
// pieces the reader-attachment path touches; keep everything else real.
vi.mock('../../../react/utils/popupMessageUtils', async () => {
    const { atom: jotaiAtom } = await import('jotai');
    return {
        addPopupMessageAtom: jotaiAtom(null, () => undefined),
        addRegularItemPopupAtom: jotaiAtom(null, () => undefined),
        addRegularItemsSummaryPopupAtom: jotaiAtom(null, () => undefined),
        removePopupMessageAtom: jotaiAtom(null, (_get, _set, messageId: unknown) => {
            removePopupMock(messageId);
        }),
        addExcludedLibraryPopupAtom: jotaiAtom(null, (_get, _set, payload: unknown) => {
            excludedLibraryPopupMock(payload);
        }),
        EXCLUDED_LIBRARY_READER_POPUP_ID: 'library-excluded-reader',
        EXCLUDED_LIBRARY_SELECTION_POPUP_ID: 'library-excluded-selection',
        safeChildAttachments: vi.fn(() => []),
    };
});

// Spy on validation so tests can assert that an excluded item is never handed
// to it, not merely kept out of the atom.
const { validateItemsMock } = vi.hoisted(() => ({ validateItemsMock: vi.fn() }));

vi.mock('../../../react/atoms/itemValidation', async () => {
    const { atom: jotaiAtom } = await import('jotai');
    return {
        getItemValidationAtom: jotaiAtom(() => () => undefined),
        isHardBlockedValidation: vi.fn(() => false),
        isRejectedItemValidation: vi.fn(() => false),
        validateItemsAtom: jotaiAtom(null, (_get, _set, payload: unknown) => {
            validateItemsMock(payload);
            return Promise.resolve();
        }),
        validateRegularItemAtom: jotaiAtom(null, () => Promise.resolve()),
    };
});

vi.mock('../../../react/components/ui/popup/InvalidItemsMessageContent', () => ({
    InvalidItemsMessageContent: () => null,
}));

vi.mock('../../../react/utils/readerUtils', () => ({
    getCurrentReader: vi.fn(() => undefined),
}));

const SEARCHABLE_LIBRARY_ID = 1;
const EXCLUDED_LIBRARY_ID = 2;
// A library type Beaver never supports (e.g. a feed): unsearchable, but not
// something the user excluded and not something Preferences can change.
const UNSUPPORTED_LIBRARY_ID = 3;

// Stand in for the derived searchable-libraries atom so the test controls the
// exclusion scope directly.
const searchableLibraryIdsTestAtom = atom<number[]>([SEARCHABLE_LIBRARY_ID]);
// Only the libraries the user explicitly excluded — the narrower set that may
// be reported as an exclusion.
const excludedLibraryIdsTestAtom = atom<number[]>([EXCLUDED_LIBRARY_ID]);
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: searchableLibraryIdsTestAtom,
    excludedLibraryIdsAtom: excludedLibraryIdsTestAtom,
}));

const {
    currentReaderAttachmentAtom,
    updateReaderAttachmentAtom,
    clearReaderAttachmentAtom,
} = await import('../../../react/atoms/messageComposition');

const READER_ITEM_ID = 55;

function stubZotero(libraryID: number) {
    const getAsync = vi.fn(async () => ({
        id: READER_ITEM_ID,
        key: 'ABCD1234',
        libraryID,
        isRegularItem: () => false,
        isAttachment: () => true,
        isNote: () => false,
        isAnnotation: () => false,
    }));
    vi.stubGlobal('Zotero', {
        Items: {
            getLibraryAndKeyFromID: vi.fn(() => ({ libraryID, key: 'ABCD1234' })),
            getAsync,
        },
    });
    return { getAsync };
}

describe('updateReaderAttachmentAtom library exclusion', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('stores the attachment when the reader library is searchable', async () => {
        stubZotero(SEARCHABLE_LIBRARY_ID);
        const store = createStore();

        await store.set(updateReaderAttachmentAtom, { itemID: READER_ITEM_ID });

        expect(store.get(currentReaderAttachmentAtom)).toMatchObject({ key: 'ABCD1234' });
    });

    it('rejects the attachment without reading the item when the library is excluded', async () => {
        const { getAsync } = stubZotero(EXCLUDED_LIBRARY_ID);
        const store = createStore();
        store.set(currentReaderAttachmentAtom, { key: 'STALE123' } as any);

        await store.set(updateReaderAttachmentAtom, { itemID: READER_ITEM_ID });

        expect(store.get(currentReaderAttachmentAtom)).toBeNull();
        expect(getAsync).not.toHaveBeenCalled();
    });

    it('tells the user why the open file was not added when the library is excluded', async () => {
        stubZotero(EXCLUDED_LIBRARY_ID);
        const store = createStore();

        await store.set(updateReaderAttachmentAtom, { itemID: READER_ITEM_ID });

        expect(excludedLibraryPopupMock).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'library-excluded-reader',
                libraryIDs: [EXCLUDED_LIBRARY_ID],
                expire: false,
            }),
        );
    });

    it('clears only the reader notice, leaving another funnel\'s notice alone', async () => {
        stubZotero(SEARCHABLE_LIBRARY_ID);
        const store = createStore();

        store.set(clearReaderAttachmentAtom);

        // Both funnels run as Beaver opens and share the popup list, so reader
        // teardown must not delete the selection funnel's notice.
        expect(removePopupMock).toHaveBeenCalledWith('library-excluded-reader');
        expect(removePopupMock).not.toHaveBeenCalledWith('library-excluded-selection');
    });

    it('does not warn about exclusion when the reader library is searchable', async () => {
        stubZotero(SEARCHABLE_LIBRARY_ID);
        const store = createStore();

        await store.set(updateReaderAttachmentAtom, { itemID: READER_ITEM_ID });

        expect(excludedLibraryPopupMock).not.toHaveBeenCalled();
    });

    it('rejects the attachment from an unsupported library type', async () => {
        stubZotero(UNSUPPORTED_LIBRARY_ID);
        const store = createStore();

        await store.set(updateReaderAttachmentAtom, { itemID: READER_ITEM_ID });

        expect(store.get(currentReaderAttachmentAtom)).toBeNull();
    });

    it('does not blame an exclusion for an unsupported library type', async () => {
        stubZotero(UNSUPPORTED_LIBRARY_ID);
        const store = createStore();

        await store.set(updateReaderAttachmentAtom, { itemID: READER_ITEM_ID });

        // Unsearchable but never excluded: pointing at Beaver Preferences would
        // send the user to a setting that cannot change the outcome.
        expect(excludedLibraryPopupMock).not.toHaveBeenCalled();
    });

    it('rejects the attachment while the searchable scope is still loading', async () => {
        stubZotero(SEARCHABLE_LIBRARY_ID);
        const store = createStore();
        // Fail closed: the derived atom is empty until the profile loads.
        store.set(searchableLibraryIdsTestAtom, []);

        await store.set(updateReaderAttachmentAtom, { itemID: READER_ITEM_ID });

        expect(store.get(currentReaderAttachmentAtom)).toBeNull();
    });

    it('does not blame an exclusion while the library-access snapshot is loading', async () => {
        stubZotero(SEARCHABLE_LIBRARY_ID);
        const store = createStore();
        // Same fail-closed empty scope, but nothing is known yet — reporting it
        // as the user's exclusion setting would be a false warning.
        store.set(searchableLibraryIdsTestAtom, []);
        store.set(excludedLibraryIdsTestAtom, []);

        await store.set(updateReaderAttachmentAtom, { itemID: READER_ITEM_ID });

        expect(excludedLibraryPopupMock).not.toHaveBeenCalled();
    });
});

describe('updateReaderAttachmentAtom staleness', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    /** Stub Zotero with an item lookup the test resolves by hand. */
    function stubZoteroWithPendingLookup(key: string) {
        let release: (() => void) | undefined;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        vi.stubGlobal('Zotero', {
            Items: {
                getLibraryAndKeyFromID: vi.fn(() => ({
                    libraryID: SEARCHABLE_LIBRARY_ID,
                    key,
                })),
                getAsync: vi.fn(async () => {
                    await pending;
                    return {
                        id: READER_ITEM_ID,
                        key,
                        libraryID: SEARCHABLE_LIBRARY_ID,
                        isRegularItem: () => false,
                        isAttachment: () => true,
                        isNote: () => false,
                        isAnnotation: () => false,
                    };
                }),
            },
        });
        return { release: release! };
    }

    it('drops the attachment when the library is excluded during the lookup', async () => {
        const { release } = stubZoteroWithPendingLookup('EXCLUDEDMID');
        const store = createStore();

        const update = store.set(updateReaderAttachmentAtom, { itemID: READER_ITEM_ID });
        // The user excludes the library in Preferences while the item loads.
        store.set(searchableLibraryIdsTestAtom, []);
        store.set(excludedLibraryIdsTestAtom, [SEARCHABLE_LIBRARY_ID]);
        release();
        await update;

        expect(store.get(currentReaderAttachmentAtom)).toBeNull();
        expect(validateItemsMock).not.toHaveBeenCalled();
        expect(excludedLibraryPopupMock).toHaveBeenCalledWith(
            expect.objectContaining({ libraryIDs: [SEARCHABLE_LIBRARY_ID] }),
        );
    });

    it('does not repopulate the attachment after it was cleared', async () => {
        const { release } = stubZoteroWithPendingLookup('LEFTREADER');
        const store = createStore();

        const update = store.set(updateReaderAttachmentAtom, { itemID: READER_ITEM_ID });
        // The user leaves the reader while the item is still loading.
        store.set(clearReaderAttachmentAtom);
        release();
        await update;

        expect(store.get(currentReaderAttachmentAtom)).toBeNull();
    });
});
