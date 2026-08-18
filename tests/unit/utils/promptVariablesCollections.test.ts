import { describe, it, expect, vi, beforeEach } from 'vitest';

// Atom identity sentinels — the mocked store dispatches on these. Hoisted so
// the vi.mock factories (which run before module init) can close over them.
const {
    LIBRARY_VIEW_ATOM,
    SEARCHABLE_ATOM,
    SELECTED_ITEMS_ATOM,
    NOTE_ITEM_ATOM,
    READER_ATTACHMENT_ATOM,
    state,
} = vi.hoisted(() => ({
    LIBRARY_VIEW_ATOM: { __atom: 'libraryView' },
    SEARCHABLE_ATOM: { __atom: 'searchableLibraryIds' },
    SELECTED_ITEMS_ATOM: { __atom: 'selectedItems' },
    NOTE_ITEM_ATOM: { __atom: 'noteItem' },
    READER_ATTACHMENT_ATOM: { __atom: 'readerAttachment' },
    state: new Map<unknown, unknown>(),
}));

vi.mock('../../../react/store', () => ({
    store: { get: (a: unknown) => state.get(a) },
}));
vi.mock('../../../react/atoms/zoteroContext', () => ({
    libraryViewAtom: LIBRARY_VIEW_ATOM,
    selectedZoteroItemsAtom: SELECTED_ITEMS_ATOM,
    currentNoteItemAtom: NOTE_ITEM_ATOM,
}));
vi.mock('../../../react/atoms/profile', () => ({ searchableLibraryIdsAtom: SEARCHABLE_ATOM }));
vi.mock('../../../react/atoms/messageComposition', () => ({
    currentReaderAttachmentAtom: READER_ATTACHMENT_ATOM,
}));
vi.mock('../../../react/utils/readerUtils', () => ({ getCurrentReader: () => null }));
vi.mock('../../../src/utils/agentItemSupport', () => ({
    agentItemFilter: () => true,
    isAgentSupportedItem: () => true,
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({ safeIsInTrash: () => false }));
vi.mock('../../../react/utils/sourceUtils', () => ({ getDisplayNameFromItem: () => 'Mock Item' }));
vi.mock('../../../src/utils/libraryIdentity', () => ({
    libraryRefForLibraryID: (id: number) => (id === 1 ? 'u' : `group:${id}`),
    UNRESOLVED_LIBRARY_ID: -1,
}));

import { resolvePromptVariables } from '../../../react/utils/promptVariables';

const ALLOWED_LIBRARY = 1;
const EXCLUDED_LIBRARY = 5;

const collectionsGet = vi.fn();

function libraryViewWith(collections: { collectionId: number; collectionName: string; libraryId: number }[]) {
    return {
        treeRowType: 'collection',
        libraryId: collections[0]?.libraryId ?? ALLOWED_LIBRARY,
        libraryName: 'My Library',
        collectionId: collections[0]?.collectionId ?? null,
        collectionName: collections[0]?.collectionName ?? null,
        searchName: null,
        selectedRowCount: collections.length,
        selectedCollections: collections,
        selectedLibraryIds: [...new Set(collections.map(c => c.libraryId))],
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    state.clear();
    state.set(SELECTED_ITEMS_ATOM, []);
    state.set(NOTE_ITEM_ATOM, null);
    state.set(READER_ATTACHMENT_ATOM, null);
    state.set(SEARCHABLE_ATOM, [ALLOWED_LIBRARY]);

    collectionsGet.mockImplementation((id: number) => ({
        id,
        key: `KEY${id}`,
        // Distinct name for the excluded collection so a leak into resolved
        // text is visible rather than passing trivially.
        name: id === 99 ? 'Secret' : `Collection ${id}`,
        libraryID: id === 99 ? EXCLUDED_LIBRARY : ALLOWED_LIBRARY,
        parentKey: null,
    }));
    (globalThis as any).Zotero = {
        ...(globalThis as any).Zotero,
        Collections: { get: collectionsGet },
    };
});

describe('collection target context — library exclusion', () => {
    it('keeps collections from searchable libraries', async () => {
        state.set(LIBRARY_VIEW_ATOM, libraryViewWith([
            { collectionId: 1, collectionName: 'A', libraryId: ALLOWED_LIBRARY },
        ]));
        const result = await resolvePromptVariables('Summarize.', 'collection');
        expect(result.collections.map(c => c.zotero_key)).toEqual(['KEY1']);
    });

    it('drops collections in excluded libraries but keeps the allowed ones', async () => {
        state.set(LIBRARY_VIEW_ATOM, libraryViewWith([
            { collectionId: 1, collectionName: 'A', libraryId: ALLOWED_LIBRARY },
            { collectionId: 99, collectionName: 'Secret', libraryId: EXCLUDED_LIBRARY },
        ]));
        const result = await resolvePromptVariables('Summarize.', 'collection');
        expect(result.collections.map(c => c.zotero_key)).toEqual(['KEY1']);
    });

    it('never looks up a collection in an excluded library', async () => {
        state.set(LIBRARY_VIEW_ATOM, libraryViewWith([
            { collectionId: 1, collectionName: 'A', libraryId: ALLOWED_LIBRARY },
            { collectionId: 99, collectionName: 'Secret', libraryId: EXCLUDED_LIBRARY },
        ]));
        await resolvePromptVariables('Summarize.', 'collection');
        // The exclusion gate runs on the library ID the selection already
        // carries, so the excluded collection is never read.
        expect(collectionsGet).toHaveBeenCalledWith(1);
        expect(collectionsGet).not.toHaveBeenCalledWith(99);
    });

    it('resolves to no collections when the whole selection is excluded', async () => {
        state.set(LIBRARY_VIEW_ATOM, libraryViewWith([
            { collectionId: 99, collectionName: 'Secret', libraryId: EXCLUDED_LIBRARY },
        ]));
        const result = await resolvePromptVariables('Summarize.', 'collection');
        expect(result.collections).toEqual([]);
        expect(collectionsGet).not.toHaveBeenCalled();
    });

    it('{{current_collection}} does not name an excluded collection', async () => {
        state.set(LIBRARY_VIEW_ATOM, libraryViewWith([
            { collectionId: 1, collectionName: 'A', libraryId: ALLOWED_LIBRARY },
            { collectionId: 99, collectionName: 'Secret', libraryId: EXCLUDED_LIBRARY },
        ]));
        const result = await resolvePromptVariables('In {{current_collection}}.');
        expect(result.text).toContain('Collection 1');
        expect(result.text).not.toContain('Secret');
    });
});

// ---------------------------------------------------------------------------
// Bound (auto-attached) targets — the target an action binds to is attached by
// target type rather than named by a {{variable}}, so exclusion emptying it has
// to be reported explicitly or the action would be sent with a target type and
// nothing attached.
// ---------------------------------------------------------------------------

function itemIn(libraryId: number, key: string, kind: 'regular' | 'note' = 'regular') {
    return {
        libraryID: libraryId,
        key,
        isRegularItem: () => kind === 'regular',
        isNote: () => kind === 'note',
        isAttachment: () => false,
    };
}

describe('bound target context — library exclusion', () => {
    it('flags an items target whose every item is excluded', async () => {
        state.set(SELECTED_ITEMS_ATOM, [itemIn(EXCLUDED_LIBRARY, 'AAAAAAAA')]);
        const result = await resolvePromptVariables('Summarize.', 'items');
        expect(result.items).toEqual([]);
        expect(result.targetContextExcluded).toBe(true);
    });

    it('flags a note target open in an excluded library', async () => {
        state.set(NOTE_ITEM_ATOM, itemIn(EXCLUDED_LIBRARY, 'BBBBBBBB', 'note'));
        const result = await resolvePromptVariables('Rewrite.', 'note');
        expect(result.items).toEqual([]);
        expect(result.targetContextExcluded).toBe(true);
    });

    it('does not flag when a searchable item survives filtering', async () => {
        state.set(SELECTED_ITEMS_ATOM, [
            itemIn(ALLOWED_LIBRARY, 'CCCCCCCC'),
            itemIn(EXCLUDED_LIBRARY, 'DDDDDDDD'),
        ]);
        const result = await resolvePromptVariables('Summarize.', 'items');
        expect(result.items.map((i: any) => i.key)).toEqual(['CCCCCCCC']);
        expect(result.targetContextExcluded).toBe(false);
    });

    it('does not flag when the target resolved to nothing in the first place', async () => {
        // Genuinely empty is not the same as emptied by exclusion; only the
        // latter should abort the action.
        state.set(SELECTED_ITEMS_ATOM, []);
        const result = await resolvePromptVariables('Summarize.', 'items');
        expect(result.targetContextExcluded).toBe(false);
    });
});

/** {{active_item}}'s library-view step reads the pane, not the selection atom. */
function mockPaneSelection(items: unknown[]) {
    (globalThis as any).Zotero = {
        ...(globalThis as any).Zotero,
        getActiveZoteroPane: () => ({ getSelectedItems: () => items }),
    };
}

describe('{{active_item}} fallback — library exclusion', () => {
    it('falls through an excluded note to a searchable selected item', async () => {
        state.set(NOTE_ITEM_ATOM, itemIn(EXCLUDED_LIBRARY, 'BBBBBBBB', 'note'));
        mockPaneSelection([itemIn(ALLOWED_LIBRARY, 'CCCCCCCC')]);

        const result = await resolvePromptVariables('Use {{active_item}}.');

        expect(result.items.map((i: any) => i.key)).toEqual(['CCCCCCCC']);
        expect(result.emptyItemVariables).toEqual([]);
    });

    it('does not resolve the variable to the excluded candidate itself', async () => {
        state.set(NOTE_ITEM_ATOM, itemIn(EXCLUDED_LIBRARY, 'BBBBBBBB', 'note'));
        mockPaneSelection([itemIn(ALLOWED_LIBRARY, 'CCCCCCCC')]);

        const result = await resolvePromptVariables('Use {{active_item}}.');

        expect(result.items.some((i: any) => i.libraryID === EXCLUDED_LIBRARY)).toBe(false);
    });

    it('drops an excluded selected item so the chain continues past it', async () => {
        state.set(NOTE_ITEM_ATOM, itemIn(EXCLUDED_LIBRARY, 'BBBBBBBB', 'note'));
        mockPaneSelection([itemIn(EXCLUDED_LIBRARY, 'EEEEEEEE')]);

        const result = await resolvePromptVariables('Use {{active_item}}.');

        // Nothing searchable in any step here, but the excluded candidates
        // must not be what the variable resolves to.
        expect(result.items).toEqual([]);
    });
});
