import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

// =============================================================================
// Module mocks — mirror importAction.test.ts so importing actions.ts doesn't
// drag in the WS / supabase / profile chains at import time. zoteroContextAtom
// and searchableLibraryIdsAtom are plain writable atoms here so each case can
// seed them directly.
// =============================================================================

vi.mock('../../../react/atoms/agentRunAtoms', async () => {
    const { atom } = await import('jotai');
    return { sendWSMessageAtom: atom(null, () => {}) };
});

vi.mock('../../../react/atoms/messageComposition', async () => {
    const { atom } = await import('jotai');
    return {
        currentMessageItemsAtom: atom<unknown[]>([]),
        currentMessageCollectionsAtom: atom<unknown[]>([]),
        pendingPillInsertsAtom: atom<unknown[]>([]),
    };
});

vi.mock('../../../react/atoms/zoteroContext', async () => {
    const { atom } = await import('jotai');
    return { zoteroContextAtom: atom<any>({}) };
});

vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return { searchableLibraryIdsAtom: atom<number[]>([1]) };
});

vi.mock('../../../react/utils/popupMessageUtils', async () => {
    const { atom } = await import('jotai');
    return { addPopupMessageAtom: atom(null, () => {}) };
});

vi.mock('../../../react/atoms/itemValidation', async () => {
    const { atom } = await import('jotai');
    return {
        itemValidationResultsAtom: atom(new Map()),
        isRejectedItemValidation: vi.fn(() => false),
    };
});

vi.mock('../../../react/utils/promptVariables', () => ({
    EMPTY_VARIABLE_HINTS: {},
    resolvePromptVariables: vi.fn(),
}));

vi.mock('../../../react/utils/actionVisibility', () => ({
    isActionVisible: vi.fn(() => true),
}));

vi.mock('../../../react/types/attachments/converters', () => ({
    toMessageAttachment: vi.fn(() => null),
}));

vi.mock('../../../react/types/actionStorage', () => ({
    getMergedActions: vi.fn(() => []),
    getActionCustomizations: vi.fn(() => ({ version: 1, overrides: {}, custom: [] })),
    saveActionCustomizations: vi.fn(),
    saveActionLastUsed: vi.fn(),
    isBuiltinAction: vi.fn(() => false),
    isLockedBuiltinAction: vi.fn(() => false),
}));

// =============================================================================
// Imports (after mocks)
// =============================================================================

import { actionContextAtom } from '../../../react/atoms/actions';
import { zoteroContextAtom } from '../../../react/atoms/zoteroContext';
import { searchableLibraryIdsAtom } from '../../../react/atoms/profile';

function item(libraryID: number, key: string): any {
    return { libraryID, key, isRegularItem: () => true, isAttachment: () => false, isNote: () => false };
}

function collection(collectionId: number, libraryId: number): any {
    return { collectionId, collectionName: `Collection ${collectionId}`, libraryId };
}

/**
 * `selectedRowCount` defaults to the number of collections (a pure collection
 * selection); pass a larger value to model a selection that also contains
 * non-collection rows such as the trash.
 */
function zoteroContext(
    selectedItems: any[],
    selectedCollections: any[] = [],
    selectedRowCount = selectedCollections.length,
): any {
    return {
        type: 'items_selected',
        isLibraryTab: true,
        selectedItemCount: selectedItems.length,
        selectedItems,
        libraryView: {
            treeRowType: 'collection',
            libraryId: 1,
            libraryName: 'My Library',
            collectionId: null,
            collectionName: null,
            searchName: null,
            selectedRowCount,
            selectedCollections,
            selectedLibraryIds: [
                ...new Set(selectedCollections.map((c: any) => c.libraryId)),
            ],
        },
        selectedTags: [],
        readerAttachment: null,
        noteItem: null,
        recentlyAddedTodayCount: 0,
    };
}

/** Mirrors pureCollectionSelection's rule, to assert the invariant survives. */
function readsAsPureCollectionSelection(libraryView: any): boolean {
    return libraryView.selectedCollections.length > 0
        && libraryView.selectedCollections.length === libraryView.selectedRowCount;
}

describe('actionContextAtom library exclusion', () => {
    let store: ReturnType<typeof createStore>;

    beforeEach(() => {
        vi.clearAllMocks();
        store = createStore();
        store.set(searchableLibraryIdsAtom, [1]);
    });

    it('drops selected items belonging to an excluded library', () => {
        const searchable = item(1, 'AAAAAAAA');
        const excluded = item(3, 'BBBBBBBB');
        store.set(zoteroContextAtom, zoteroContext([searchable, excluded]));

        const ctx = store.get(actionContextAtom);

        expect(ctx.zotero.selectedItems).toEqual([searchable]);
    });

    it('empties the selection when every selected item is excluded', () => {
        // A selection spanning libraries can leave every selected item in the
        // excluded one while another selected library is still searchable.
        // The action context must not offer those items as a target.
        store.set(zoteroContextAtom, zoteroContext([item(3, 'BBBBBBBB'), item(3, 'CCCCCCCC')]));

        const ctx = store.get(actionContextAtom);

        expect(ctx.zotero.selectedItems).toEqual([]);
    });

    it('keeps notes in an excluded library out of the context', () => {
        const note = { ...item(3, 'DDDDDDDD'), isRegularItem: () => false, isNote: () => true };
        store.set(zoteroContextAtom, zoteroContext([note]));

        const ctx = store.get(actionContextAtom);

        expect(ctx.zotero.selectedItems).toEqual([]);
    });

    it('passes the context through unchanged when every item is searchable', () => {
        const zotero = zoteroContext([item(1, 'AAAAAAAA'), item(1, 'EEEEEEEE')]);
        store.set(zoteroContextAtom, zotero);

        const ctx = store.get(actionContextAtom);

        // Identity is preserved so downstream memoization isn't invalidated on
        // every derivation.
        expect(ctx.zotero).toBe(zotero);
    });

    it('keeps items once their library is no longer excluded', () => {
        const excluded = item(3, 'BBBBBBBB');
        store.set(zoteroContextAtom, zoteroContext([excluded]));
        expect(store.get(actionContextAtom).zotero.selectedItems).toEqual([]);

        store.set(searchableLibraryIdsAtom, [1, 3]);

        expect(store.get(actionContextAtom).zotero.selectedItems).toEqual([excluded]);
    });
});

describe('actionContextAtom collection exclusion', () => {
    let store: ReturnType<typeof createStore>;

    beforeEach(() => {
        vi.clearAllMocks();
        store = createStore();
        store.set(searchableLibraryIdsAtom, [1]);
    });

    it('drops excluded collections so the label matches what is sent', () => {
        store.set(zoteroContextAtom, zoteroContext([], [collection(10, 1), collection(99, 3)]));

        const { libraryView } = store.get(actionContextAtom).zotero;

        expect(libraryView.selectedCollections.map((c: any) => c.collectionId)).toEqual([10]);
        expect(libraryView.selectedLibraryIds).toEqual([1]);
    });

    it('keeps a filtered pure selection reading as a pure collection selection', () => {
        // Both rows are collections; dropping the excluded one must not make
        // the remainder look like a mixed selection and hide collection actions.
        store.set(zoteroContextAtom, zoteroContext([], [collection(10, 1), collection(99, 3)]));

        const { libraryView } = store.get(actionContextAtom).zotero;

        expect(libraryView.selectedRowCount).toBe(1);
        expect(readsAsPureCollectionSelection(libraryView)).toBe(true);
    });

    it('resolves to no collections when every selected collection is excluded', () => {
        store.set(zoteroContextAtom, zoteroContext([], [collection(99, 3)]));

        const { libraryView } = store.get(actionContextAtom).zotero;

        expect(libraryView.selectedCollections).toEqual([]);
        expect(libraryView.selectedLibraryIds).toEqual([]);
        expect(readsAsPureCollectionSelection(libraryView)).toBe(false);
    });

    it('does not turn a collection + special-row selection into a pure one', () => {
        // One collection plus a non-collection row (rowCount 3), one of the
        // collections excluded. After filtering the selection is still mixed.
        store.set(zoteroContextAtom, zoteroContext([], [collection(10, 1), collection(99, 3)], 3));

        const { libraryView } = store.get(actionContextAtom).zotero;

        expect(libraryView.selectedRowCount).toBe(2);
        expect(readsAsPureCollectionSelection(libraryView)).toBe(false);
    });

    it('leaves a fully searchable collection selection untouched', () => {
        const zotero = zoteroContext([], [collection(10, 1), collection(11, 1)]);
        store.set(zoteroContextAtom, zotero);

        expect(store.get(actionContextAtom).zotero).toBe(zotero);
    });
});
