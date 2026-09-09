import { expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
const mocks = vi.hoisted(() => ({ win: undefined as any, counts: vi.fn() }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ getContextWindow: () => mocks.win }));
vi.mock('../../../react/utils/readerUtils', () => ({ getCurrentReader: () => null, getCurrentPage: () => null, getEpubReaderPage: () => null }));
vi.mock('../../../react/atoms/messageComposition', async () => {
    const { atom } = await import('jotai');
    return { currentReaderAttachmentAtom: atom(null), readerTextSelectionAtom: atom(null), readerActionContextAtom: atom(null), currentMessageItemsAtom: atom([]) };
});
vi.mock('../../../react/atoms/zoteroContext', async () => ({ currentNoteItemAtom: (await import('jotai')).atom(null) }));
vi.mock('../../../react/atoms/ui', async () => ({ isLibraryTabAtom: (await import('jotai')).atom(true) }));
vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    const { ProcessingMode } = await import('@beaver/agent-core/types/profile');
    return { searchableLibraryIdsAtom: atom([1]), processingModeAtom: atom(ProcessingMode.BACKEND) };
});
vi.mock('../../../react/atoms/embeddingIndex', async () => ({ embeddingIndexStateAtom: (await import('jotai')).atom({}) }));
vi.mock('../../../src/services/database', () => ({ BeaverDB: class {} }));
vi.mock('../../../src/services/embeddingIndexer', () => ({ EmbeddingIndexer: class {} }));
vi.mock('../../../src/services/agentDataProvider/libraryCounts', () => ({ getLibrarySummaries: async () => undefined }));
vi.mock('../../../src/services/agentDataProvider/collectionCounts', () => ({
    getCollectionItemCounts: mocks.counts, getSubcollectionCounts: async () => new Map(),
    countsFor: () => ({ itemCount: 1, standaloneAttachmentCount: 0, standaloneNoteCount: 0 }),
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
});
