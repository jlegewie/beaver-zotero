/**
 * Focused unit tests for the collection-scope helpers in
 * src/services/agentDataProvider/utils.ts: getCollectionScopeItemIds,
 * resolveCollectionsFilter and collectionsFilterError.
 *
 * The module has a wide transitive dependency surface (document extraction,
 * sync, popups, etc.) that getCollectionScopeItemIds itself never touches, so
 * every unrelated dependency is stubbed out just to make the module
 * importable in isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    safeIsInTrash: vi.fn(),
    safeFileExists: vi.fn(),
    isLinkedUrlAttachment: vi.fn(),
}));
vi.mock('../../../src/utils/sync', () => ({
    syncingItemFilterAsync: vi.fn(),
}));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(),
}));
vi.mock('../../../src/utils/webAPI', () => ({
    isAttachmentOnServer: vi.fn(),
}));
vi.mock('../../../react/utils/popupMessageUtils', () => ({
    addPopupMessageAtom: {},
}));
vi.mock('../../../react/utils/sourceUtils', () => ({
    wasItemAddedBeforeLastSync: vi.fn(),
}));
vi.mock('../../../react/atoms/deferredToolPreferences', () => ({
    deferredToolPreferencesAtom: {},
}));
vi.mock('../../../src/utils/agentItemSupport', () => ({
    isAgentSupportedItem: vi.fn(),
}));
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => [1, 100]) },
}));
vi.mock('@beaver/agent-core/run-state/atoms', () => ({
    activeRunAtom: Symbol('activeRunAtom'),
}));
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
}));
vi.mock('../../../src/services/documentExtraction/attachmentInfo', () => ({
    getAttachmentInfo: vi.fn(),
}));
vi.mock('../../../src/services/documentExtraction/attachmentInfoBatch', () => ({
    getBestAttachmentBatch: vi.fn(),
    prepareAttachmentInfoBatchData: vi.fn(),
    processAttachmentInfoBatch: vi.fn(),
}));
vi.mock('../../../src/services/documentExtraction', () => ({
    loadPdfData: vi.fn(),
    isRemoteAccessAvailable: vi.fn(),
    validateZoteroItemReference: vi.fn(),
    checkRemotePdfSize: vi.fn(),
    preflightCachedPdfMeta: vi.fn(),
    resolveToPdfAttachment: vi.fn(),
    resolveToImageAttachment: vi.fn(),
}));

import {
    collectionsFilterError,
    getCollectionScopeItemIds,
    resolveCollectionsFilter,
} from '../../../src/services/agentDataProvider/utils';

/** Item IDs held directly by each collection ID. */
const itemsByCollectionId = new Map<number, number[]>([
    [10, []],
    [11, [101, 102]],
    [12, [102, 103]],
    [20, [201]],
]);

/** Descendant collection IDs by collection ID (all levels). */
const descendantsByCollectionId = new Map<number, number[]>([
    [10, [11, 12]],
    [11, []],
    [12, []],
    [20, []],
]);

function collection(id: number) {
    return {
        id,
        getDescendents: vi.fn(() =>
            (descendantsByCollectionId.get(id) ?? []).map(descendantId => ({
                id: descendantId,
                key: `COLL${descendantId}`,
                name: `Collection ${descendantId}`,
                type: 'collection',
                level: 1,
                parent: id,
            }))
        ),
    };
}

describe('getCollectionScopeItemIds', () => {
    let previousZotero: any;
    let queryAsync: any;

    beforeEach(() => {
        vi.clearAllMocks();
        previousZotero = (globalThis as any).Zotero;
        queryAsync = vi.fn(async (_sql: string, params: number[], options: any) => {
            for (const collectionId of params) {
                for (const itemId of itemsByCollectionId.get(collectionId) ?? []) {
                    options.onRow({ getResultByIndex: () => itemId });
                }
            }
        });
        (globalThis as any).Zotero = {
            Beaver: { searchableLibraryIds: [1, 100], libraryScopeInitialized: true },
            DB: { queryAsync },
        };
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('returns an empty array without querying the database', async () => {
        expect(await getCollectionScopeItemIds([])).toEqual([]);
        expect(queryAsync).not.toHaveBeenCalled();
    });

    it('includes items from subcollections when the parent holds none directly', async () => {
        const result = await getCollectionScopeItemIds([collection(10)]);

        expect(result.sort((a, b) => a - b)).toEqual([101, 102, 103]);
        expect(queryAsync).toHaveBeenCalledTimes(1);
        expect(queryAsync.mock.calls[0][1]).toEqual([10, 11, 12]);
        expect(queryAsync.mock.calls[0][0]).toContain('deletedItems');
    });

    it('returns an item once when it appears in several collections in the scope', async () => {
        const result = await getCollectionScopeItemIds([collection(10), collection(12), collection(20)]);

        expect(result.sort((a, b) => a - b)).toEqual([101, 102, 103, 201]);
        // Collection 12 is both an input and a descendant of collection 10, so
        // it is queried once.
        expect(queryAsync.mock.calls[0][1]).toEqual([10, 11, 12, 20]);
    });
});

/**
 * Collections available to the resolver tests. Library 42 stands in for a
 * library excluded from Beaver: the mocked store reports 1 and 100 as the
 * searchable ones.
 */
const COLLECTIONS = [
    { id: 11, key: 'AAAAAAAA', name: 'Papers', libraryID: 1 },
    { id: 12, key: 'BBBBBBBB', name: 'Papers', libraryID: 100 },
    { id: 13, key: 'CCCCCCCC', name: 'Private', libraryID: 42 },
];

const LIBRARY_NAMES = new Map([
    [1, 'My Library'],
    [100, 'Group Library'],
    [42, 'Excluded Library'],
]);

describe('resolveCollectionsFilter', () => {
    let previousZotero: any;

    beforeEach(() => {
        vi.clearAllMocks();
        previousZotero = (globalThis as any).Zotero;
        (globalThis as any).Zotero = {
            Beaver: { searchableLibraryIds: [1, 100], libraryScopeInitialized: true },
            Utilities: { isValidObjectKey: (input: string) => /^[A-Z0-9]{8}$/.test(input) },
            Collections: {
                get: (id: number) => COLLECTIONS.find(c => (c as any).id === id) ?? false,
                getByLibraryAndKey: (libraryId: number, key: string) =>
                    COLLECTIONS.find(c => (c as any).libraryID === libraryId && (c as any).key === key) ?? false,
                getByLibrary: (libraryId: number) =>
                    COLLECTIONS.filter(c => (c as any).libraryID === libraryId),
            },
            Libraries: {
                getAll: () => [{ libraryID: 1 }, { libraryID: 100 }, { libraryID: 42 }],
                get: (libraryId: number) =>
                    LIBRARY_NAMES.has(libraryId) ? { name: LIBRARY_NAMES.get(libraryId) } : false,
            },
        };
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('requires disambiguation for a shared name across searched libraries', () => {
        const resolution = resolveCollectionsFilter(['Papers'], [1, 100]);

        expect(resolution.collections).toEqual([]);
        expect(collectionsFilterError(resolution)).toMatchObject({ error_code: 'ambiguous_collection' });
        expect(resolution.ambiguity).toContain('AAAAAAAA');
        expect(resolution.ambiguity).toContain('BBBBBBBB');
        expect(resolution.ambiguity).not.toContain('Private');
        expect(resolution.unresolved).toEqual([]);
        expect(resolution.outOfScope).toEqual([]);
    });

    it('rejects duplicate names within one library and shows parent paths', () => {
        const root = { id: 21, key: 'ROOTAAAA', name: 'Root', libraryID: 1 };
        const first = { id: 22, key: 'CHILDAAA', name: 'Research', libraryID: 1, parentID: 21 };
        const second = { id: 23, key: 'CHILDBBB', name: 'Research', libraryID: 1 };
        COLLECTIONS.push(root, first, second);
        try {
            const result = resolveCollectionsFilter(['Research'], [1]);
            expect(result.collections).toEqual([]);
            expect(result.ambiguity).toContain('Root / Research');
            expect(result.ambiguity).toContain('CHILDAAA');
            expect(result.ambiguity).toContain('CHILDBBB');
        } finally { COLLECTIONS.splice(-3); }
    });

    it('does not treat an eight-character collection name as an unambiguous key', () => {
        COLLECTIONS.push({ id: 21, key: 'NAMEAAAA', name: 'Research', libraryID: 1 }, { id: 22, key: 'NAMEBBBB', name: 'Research', libraryID: 100 });
        try {
            const result = resolveCollectionsFilter(['Research'], [1, 100]);
            expect(collectionsFilterError(result)?.error_code).toBe('ambiguous_collection');
        } finally { COLLECTIONS.splice(-2); }
    });

    it('returns a collection once when several filter entries resolve to it', () => {
        const resolution = resolveCollectionsFilter(['Papers', 'AAAAAAAA'], [1]);

        expect(resolution.collections.map(c => (c as any).id)).toEqual([11]);
    });

    it('reports an entry that matches nothing as unresolved', () => {
        const resolution = resolveCollectionsFilter(['Typo'], [1]);

        expect(resolution.collections).toEqual([]);
        expect(resolution.unresolved).toEqual(['Typo']);
        expect(resolution.outOfScope).toEqual([]);
    });

    it('separates a key that resolves outside the searched libraries from a missing one', () => {
        // Key-like entries resolve through a cross-library fallback that can
        // land in a library the request is not scoped to.
        const resolution = resolveCollectionsFilter(['CCCCCCCC'], [1]);

        expect(resolution.collections).toEqual([]);
        expect(resolution.unresolved).toEqual([]);
        // Library 42 is excluded, so its collection name is not carried out.
        expect(resolution.outOfScope).toEqual([{ input: 'CCCCCCCC', name: null, libraryId: 42 }]);
    });

    it('reports a numeric ID from an unsearched library as out of scope', () => {
        const resolution = resolveCollectionsFilter([12], [1]);

        expect(resolution.outOfScope).toEqual([{ input: '12', name: 'Papers', libraryId: 100 }]);
    });

    it('keeps the collections it resolved when only some entries fail', () => {
        const resolution = resolveCollectionsFilter(['Papers', 'Typo'], [1]);

        expect(resolution.collections.map(c => (c as any).id)).toEqual([11]);
        expect(resolution.unresolved).toEqual(['Typo']);
    });

    it('looks nothing up when no library is searchable', () => {
        const zotero = (globalThis as any).Zotero;
        const getByLibrary = vi.fn(zotero.Collections.getByLibrary);
        const getByLibraryAndKey = vi.fn(zotero.Collections.getByLibraryAndKey);
        zotero.Collections = { ...zotero.Collections, getByLibrary, getByLibraryAndKey };

        const resolution = resolveCollectionsFilter(['Papers', 'CCCCCCCC'], []);

        // An empty searchable set is fail-closed (all libraries excluded, or the
        // profile still loading): reading collections out of those libraries to
        // classify the filter would be an unauthorized read, and would report an
        // allowed collection as excluded while loading.
        expect(resolution).toEqual({ collections: [], unresolved: [], outOfScope: [] });
        expect(getByLibrary).not.toHaveBeenCalled();
        expect(getByLibraryAndKey).not.toHaveBeenCalled();
    });
});

describe('collectionsFilterError', () => {
    let previousZotero: any;

    beforeEach(() => {
        previousZotero = (globalThis as any).Zotero;
        (globalThis as any).Zotero = {
            Beaver: { searchableLibraryIds: [1, 100], libraryScopeInitialized: true },
            Libraries: {
                get: (libraryId: number) =>
                    LIBRARY_NAMES.has(libraryId) ? { name: LIBRARY_NAMES.get(libraryId) } : false,
            },
        };
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('returns no error when at least one collection resolved', () => {
        const error = collectionsFilterError({
            collections: [COLLECTIONS[0]],
            unresolved: ['Typo'],
            outOfScope: [],
        });

        expect(error).toBeNull();
    });

    it('returns no error for an empty filter', () => {
        expect(collectionsFilterError({ collections: [], unresolved: [], outOfScope: [] })).toBeNull();
    });

    it('names the unresolved entries and points at list_collections', () => {
        const error = collectionsFilterError({
            collections: [],
            unresolved: ['Typo', 'KB7KVUEB'],
            outOfScope: [],
        });

        expect(error?.error_code).toBe('collection_not_found');
        expect(error?.message).toContain('"Typo", "KB7KVUEB"');
        expect(error?.message).toContain('list_collections');
    });

    it('reports an excluded library without echoing the collection name', () => {
        const error = collectionsFilterError({
            collections: [],
            unresolved: [],
            // A stale name here stands in for a caller that built the entry by
            // hand: the message must still not carry it.
            outOfScope: [{ input: 'CCCCCCCC', name: 'Private', libraryId: 42 }],
        });

        expect(error?.error_code).toBe('library_not_searchable');
        expect(error?.message).toContain('Excluded Library');
        expect(error?.message).not.toContain('Private');
    });

    it('reports a searchable library that the libraries_filter left out', () => {
        const error = collectionsFilterError({
            collections: [],
            unresolved: [],
            outOfScope: [{ input: '12', name: 'Papers', libraryId: 100 }],
        });

        expect(error?.error_code).toBe('collection_not_found');
        expect(error?.message).toContain('"Papers"');
        expect(error?.message).toContain('Group Library');
        expect(error?.message).toContain('libraries_filter');
    });
});
