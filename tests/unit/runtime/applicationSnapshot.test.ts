import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
const mocks = vi.hoisted(() => ({ win: undefined as any, reader: undefined as any, counts: vi.fn(), specialCounts: vi.fn() }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ getContextWindow: () => mocks.win }));
vi.mock('../../../react/utils/readerUtils', () => ({ getCurrentReader: () => mocks.reader, getCurrentPage: () => null, getEpubReaderPage: () => null }));
vi.mock('../../../react/atoms/messageComposition', async () => {
    const { atom } = await import('jotai');
    const readerActionContextAtom = atom<any>(null);
    const currentMessageItemsAtom = atom<any[]>([]);
    return { currentReaderAttachmentAtom: atom(null), readerTextSelectionAtom: atom(null), readerActionContextAtom, currentMessageItemsAtom,
        stagedReaderActionContextAtom: atom(get => {
            const context = get(readerActionContextAtom);
            return context && get(currentMessageItemsAtom).some(item => item.id === context.item.id) ? context : null;
        }),
    };
});
vi.mock('../../../react/atoms/zoteroContext', async () => ({ currentNoteItemAtom: (await import('jotai')).atom(null) }));
vi.mock('../../../react/atoms/ui', async () => ({ isLibraryTabAtom: (await import('jotai')).atom(true) }));
vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    const { ProcessingMode } = await import('@beaver/agent-core/types/profile');
    return { searchableLibraryIdsAtom: atom([1, 3]), excludedLibraryIdsAtom: atom([2]), processingModeAtom: atom(ProcessingMode.BACKEND) };
});
vi.mock('../../../react/atoms/embeddingIndex', async () => ({ embeddingIndexStateAtom: (await import('jotai')).atom({}) }));
vi.mock('../../../src/services/database', () => ({ BeaverDB: class {} }));
vi.mock('../../../src/services/embeddingIndexer', () => ({ EmbeddingIndexer: class {} }));
vi.mock('../../../src/services/agentDataProvider/libraryCounts', () => ({ getLibrarySummaries: async () => undefined }));
vi.mock('../../../src/services/agentDataProvider/collectionCounts', () => ({
    getCollectionItemCounts: mocks.counts, getSubcollectionCounts: async () => new Map(),
    countsFor: () => ({ itemCount: 1, standaloneAttachmentCount: 0, standaloneNoteCount: 0 }),
}));
vi.mock('../../../src/services/agentDataProvider/specialCollectionCounts', () => ({
    getSpecialCollectionItemCounts: mocks.specialCounts,
}));
vi.mock('../../../src/utils/libraryIdentity', () => ({ libraryRefForLibraryID: () => 'u' }));
import { buildZoteroApplicationState } from '../../../react/atoms/applicationState';

it('captures items, searches and collections before database awaits or a focus change', async () => {
    const originalItem = { libraryID: 1, key: 'ORIGINAL' };
    let selection = [originalItem];
    let searches = [{ libraryID: 1, key: 'SEARCH_A', name: 'A' }];
    let collections = [{ id: 1, libraryID: 1, key: 'COLL_A', name: 'A' }];
    mocks.win = { ZoteroPane: {
        getSelectedItems: () => selection,
        getSelectedLibraryID: () => 1,
        getSelectedCollections: () => collections,
        getSelectedSavedSearches: () => searches,
    } };
    vi.stubGlobal('Zotero', { Libraries: { get: () => ({ libraryID: 1, name: 'Library', editable: true }) }, getMainWindow: () => ({ ZoteroPane: {} }) });
    let finish!: (value: Map<number, any>) => void;
    mocks.counts.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = buildZoteroApplicationState(createStore().get);
    selection = [{ libraryID: 1, key: 'LATER' }];
    searches = [{ libraryID: 1, key: 'SEARCH_B', name: 'B' }];
    collections = [{ id: 2, libraryID: 1, key: 'COLL_B', name: 'B' }];
    finish(new Map());
    const state = await pending;
    expect(state.library_selection?.map(item => item.zotero_key)).toEqual(['ORIGINAL']);
    expect(state.current_collections?.map(collection => collection.collection_key)).toEqual(['COLL_A']);
    expect(state.current_searches?.map(search => search.search_key)).toEqual(['SEARCH_A']);
    // Saved searches are reported by portable library only.
    expect(state.current_searches?.[0]).not.toHaveProperty('library_id');
    expect(state.current_searches?.[0].library_ref).toEqual(expect.any(String));
});

it('uses a staged annotation-action paper instead of the destination reader context', async () => {
    const { getReaderState } = await import('../../../react/atoms/applicationState');
    const { readerActionContextAtom, currentMessageItemsAtom, currentReaderAttachmentAtom } = await import('../../../react/atoms/messageComposition');
    const store = createStore();
    const source = { id: 42, libraryID: 1, key: 'SOURCE' } as any;
    store.set(currentReaderAttachmentAtom, { id: 99, libraryID: 1, key: 'DESTINATION' } as any);
    store.set(currentMessageItemsAtom, [source]);
    store.set(readerActionContextAtom, { item: source, selection: null });
    expect(getReaderState(store.get, new Set([1]))).toMatchObject({ zotero_key: 'SOURCE', current_page: null });
    expect(getReaderState(store.get, new Set([2]))).toBeNull();
});

it.each(['epub', 'snapshot'] as const)('preserves staged %s reader metadata after leaving its source reader', async (contentKind) => {
    const { getReaderState } = await import('../../../react/atoms/applicationState');
    const { readerActionContextAtom, currentMessageItemsAtom } = await import('../../../react/atoms/messageComposition');
    const store = createStore();
    const source = { id: 42, libraryID: 1, key: 'SOURCE' } as any;
    mocks.reader = { itemID: 42, type: 'pdf' }; // A different live instance must not supply metadata.
    store.set(currentMessageItemsAtom, [source]);
    store.set(readerActionContextAtom, {
        item: source, selection: { text: 'passage' },
        location: { contentKind, currentPage: contentKind === 'epub' ? 8 : null },
    });
    expect(getReaderState(store.get, new Set([1]))).toMatchObject({
        zotero_key: 'SOURCE', content_kind: contentKind,
        current_page: contentKind === 'epub' ? 8 : null, text_selection: { text: 'passage' },
    });
});


it('suppresses destination library and note state for a staged reader action', async () => {
    const { readerActionContextAtom, currentMessageItemsAtom } = await import('../../../react/atoms/messageComposition');
    const { currentNoteItemAtom } = await import('../../../react/atoms/zoteroContext');
    const store = createStore();
    const source = { id: 42, libraryID: 1, key: 'SOURCE' } as any;
    store.set(currentMessageItemsAtom, [source]);
    store.set(readerActionContextAtom, { item: source, selection: null });
    store.set(currentNoteItemAtom, { libraryID: 1, key: 'DESTINATION', getNoteTitle: () => 'Other note' } as any);
    const state = await buildZoteroApplicationState(store.get);
    expect(state.current_view).toBe('file_reader');
    expect(state.reader_state?.zotero_key).toBe('SOURCE');
    expect(state.note_state).toBeUndefined();
    expect(state.library_selection).toBeUndefined();
    expect(state.current_collections ?? []).toEqual([]);
});

it('reports the Zotero interface language when the host exposes one', async () => {
    mocks.win = undefined;
    vi.stubGlobal('Zotero', { locale: 'de', Libraries: { get: () => null } });
    expect((await buildZoteroApplicationState(createStore().get)).interface_language).toBe('de');

    vi.stubGlobal('Zotero', { Libraries: { get: () => null } });
    expect(await buildZoteroApplicationState(createStore().get)).not.toHaveProperty('interface_language');
});

it('reports selected special collection rows with counts, skipping unknown views and excluded libraries', async () => {
    const row = (type: string, libraryID: number) => ({ type, ref: { libraryID } });
    mocks.specialCounts.mockImplementation(async (type: string) => (type === 'duplicates'
        ? null
        : { itemCount: type === 'trash' ? 4 : 2, standaloneAttachmentCount: 1, standaloneNoteCount: 0 }));
    mocks.win = { ZoteroPane: {
        getSelectedItems: () => [],
        getSelectedLibraryID: () => 1,
        getSelectedCollections: () => [],
        getSelectedSavedSearches: () => [],
        getCollectionTreeRows: () => [
            row('duplicates', 1),
            row('unfiled', 1),
            row('publications', 1),
            row('retracted', 1),
            row('trash', 1),
            row('recentlyRead', 1),
            row('unfiled', 2),
        ],
    } };
    vi.stubGlobal('Zotero', { Libraries: { get: () => ({ libraryID: 1, name: 'Library', editable: true }) } });
    mocks.counts.mockResolvedValue(new Map());
    const state = await buildZoteroApplicationState(createStore().get);
    const counted = (itemCount: number) => ({ item_count: itemCount, standalone_attachment_count: 1, note_count: 0 });
    expect(state.current_special_collections).toEqual([
        { type: 'duplicates', library_id: 1, library_ref: 'u' },
        { type: 'unfiled', library_id: 1, library_ref: 'u', ...counted(2) },
        { type: 'publications', library_id: 1, library_ref: 'u', ...counted(2) },
        { type: 'retracted', library_id: 1, library_ref: 'u', ...counted(2) },
        { type: 'trash', library_id: 1, library_ref: 'u', ...counted(4) },
    ]);
    expect(mocks.specialCounts).not.toHaveBeenCalledWith('unfiled', 2);
});

it('omits special collections when only regular rows are selected', async () => {
    mocks.win = { ZoteroPane: {
        getSelectedItems: () => [],
        getSelectedLibraryID: () => 1,
        getSelectedCollections: () => [],
        getSelectedSavedSearches: () => [],
        getCollectionTreeRows: () => [{ type: 'library', ref: { libraryID: 1 } }],
    } };
    vi.stubGlobal('Zotero', { Libraries: { get: () => ({ libraryID: 1, name: 'Library', editable: true }) } });
    mocks.counts.mockResolvedValue(new Map());
    expect(await buildZoteroApplicationState(createStore().get)).not.toHaveProperty('current_special_collections');
});

describe('excluded libraries', () => {
    const pane = (libraryID: number, rows: any[] = [], items: any[] = []) => ({ ZoteroPane: {
        getSelectedItems: () => items,
        getSelectedLibraryID: () => libraryID,
        getSelectedCollections: () => [],
        getSelectedSavedSearches: () => [],
        getCollectionTreeRows: () => rows,
    } });

    beforeEach(() => {
        mocks.specialCounts.mockResolvedValue({ itemCount: 2, standaloneAttachmentCount: 0, standaloneNoteCount: 0 });
        mocks.counts.mockResolvedValue(new Map());
        vi.stubGlobal('Zotero', { Libraries: { get: (id: number) => ({ libraryID: id, name: `Library ${id}`, editable: true }) } });
    });

    it('flags an excluded library in the library tab without identifying it', async () => {
        mocks.win = pane(2, [{ type: 'unfiled', ref: { libraryID: 2 } }], [{ libraryID: 2, key: 'HIDDEN01' }]);
        const state = await buildZoteroApplicationState(createStore().get);
        expect(state.current_library_excluded).toBe(true);
        expect(state).not.toHaveProperty('selection_partially_excluded');
        expect(state).not.toHaveProperty('current_library');
        expect(state).not.toHaveProperty('current_special_collections');
        expect(state).not.toHaveProperty('library_selection');
        expect(JSON.stringify(state)).not.toContain('Library 2');
    });

    it('flags a selection that reaches into an excluded library', async () => {
        mocks.win = pane(1, [{ type: 'unfiled', ref: { libraryID: 1 } }, { type: 'unfiled', ref: { libraryID: 2 } }]);
        const state = await buildZoteroApplicationState(createStore().get);
        expect(state.selection_partially_excluded).toBe(true);
        expect(state).not.toHaveProperty('current_library_excluded');
        expect(state.current_library?.library_id).toBe(1);
        expect(state.current_special_collections?.map(entry => entry.library_id)).toEqual([1]);
    });

    it('reports the allowed library when an excluded library is selected first', async () => {
        mocks.win = pane(2, [{ type: 'group', ref: { libraryID: 2 } }, { type: 'group', ref: { libraryID: 3 } }]);
        const state = await buildZoteroApplicationState(createStore().get);
        expect(state).not.toHaveProperty('current_library_excluded');
        expect(state.selection_partially_excluded).toBe(true);
        expect(state.current_library?.library_id).toBe(3);
        expect(state.current_libraries?.map(library => library.library_id)).toEqual([3]);
        expect(JSON.stringify(state)).not.toContain('Library 2');
    });

    it('lists every selected library row', async () => {
        mocks.win = pane(1, [{ type: 'library', ref: { libraryID: 1 } }, { type: 'group', ref: { libraryID: 3 } }, { type: 'unfiled', ref: { libraryID: 3 } }]);
        const state = await buildZoteroApplicationState(createStore().get);
        expect(state.current_library?.library_id).toBe(1);
        expect(state.current_libraries?.map(library => library.name)).toEqual(['Library 1', 'Library 3']);
    });

    it('flags selected items from an excluded library', async () => {
        mocks.win = pane(1, [{ type: 'library', ref: { libraryID: 1 } }], [{ libraryID: 1, key: 'SHOWN001' }, { libraryID: 2, key: 'HIDDEN01' }]);
        const state = await buildZoteroApplicationState(createStore().get);
        expect(state.selection_partially_excluded).toBe(true);
        expect(state.library_selection?.map(item => item.zotero_key)).toEqual(['SHOWN001']);
    });

    it('reports no flags for a fully accessible selection', async () => {
        mocks.win = pane(1, [{ type: 'library', ref: { libraryID: 1 } }]);
        const state = await buildZoteroApplicationState(createStore().get);
        expect(state).not.toHaveProperty('current_library_excluded');
        expect(state).not.toHaveProperty('selection_partially_excluded');
    });

    it('flags a reader tab open on an attachment in an excluded library', async () => {
        // The reader attachment atom stays empty for excluded libraries; only
        // the open reader itself identifies the attachment.
        const { isLibraryTabAtom } = await import('../../../react/atoms/ui');
        const store = createStore();
        store.set(isLibraryTabAtom as any, false);
        mocks.reader = { itemID: 7, type: 'pdf' };
        vi.stubGlobal('Zotero', {
            Libraries: { get: () => null },
            Items: { getLibraryAndKeyFromID: (id: number) => (id === 7 ? { libraryID: 2, key: 'HIDDEN01' } : false) },
        });
        const state = await buildZoteroApplicationState(store.get);
        mocks.reader = undefined;
        expect(state.current_view).toBe('file_reader');
        expect(state.current_library_excluded).toBe(true);
        expect(state).not.toHaveProperty('reader_state');
        expect(state).not.toHaveProperty('current_library');
    });

    it('flags a note tab open on a note in an excluded library', async () => {
        const { currentNoteItemAtom } = await import('../../../react/atoms/zoteroContext');
        const { isLibraryTabAtom } = await import('../../../react/atoms/ui');
        const store = createStore();
        store.set(isLibraryTabAtom as any, false);
        store.set(currentNoteItemAtom, { libraryID: 2, key: 'HIDDEN01', getNoteTitle: () => 'Secret' } as any);
        const state = await buildZoteroApplicationState(store.get);
        expect(state.current_view).toBe('note_editor');
        expect(state.current_library_excluded).toBe(true);
        expect(state).not.toHaveProperty('note_state');
        expect(JSON.stringify(state)).not.toContain('Secret');
    });
});
