/**
 * Collection scoping in `handleItemSearchByMetadataRequest`.
 *
 * A collection key only matches inside its own library, so the handler has to
 * bucket the resolved collections per library. These tests pin that bucketing
 * and the guard that turns an unusable filter into an error instead of a
 * library-wide search. Resolving the filter itself is covered by the
 * `resolveCollectionsFilter` tests in collectionScope.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    deduplicateItems: vi.fn((items: any[]) => items),
}));

vi.mock('../../../src/utils/agentItemSupport', () => ({
    agentItemFilter: vi.fn(() => true),
}));

vi.mock('../../../src/utils/zoteroSerializers', () => ({
    serializeItem: vi.fn(async (item: any) => ({
        zotero_key: item.key,
        library_id: item.libraryID,
    })),
}));

const mocks = vi.hoisted(() => ({
    searchItemsByMetadata: vi.fn(),
    getSearchableLibraryIds: vi.fn(() => [1, 5]),
    resolveLibrariesFilterToSearchableIds: vi.fn(() => [1, 5]),
    resolveCollectionsFilter: vi.fn(),
    collectionsFilterError: vi.fn(() => null),
}));
const { searchItemsByMetadata, resolveCollectionsFilter, collectionsFilterError } = mocks;

vi.mock('../../../react/utils/searchTools', () => ({
    searchItemsByMetadata: mocks.searchItemsByMetadata,
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getSearchableLibraryIds: mocks.getSearchableLibraryIds,
    resolveLibrariesFilterToSearchableIds: mocks.resolveLibrariesFilterToSearchableIds,
    resolveCollectionsFilter: mocks.resolveCollectionsFilter,
    collectionsFilterError: mocks.collectionsFilterError,
    prepareAttachmentInfoBatchData: vi.fn(async () => ({})),
    processAttachmentInfoBatch: vi.fn(async () => []),
}));

import { handleItemSearchByMetadataRequest } from '../../../src/services/agentDataProvider/handleItemSearchByMetadataRequest';

/** A regular, non-trashed item the handler will accept. */
function searchHit(libraryID: number, n: number) {
    return {
        id: libraryID * 10000 + n,
        key: `L${libraryID}K${n}`,
        libraryID,
        deleted: false,
        isRegularItem: () => true,
    };
}

/** A resolution holding the given collections and nothing unresolved. */
function resolvedTo(collections: { id: number; key: string; libraryID: number }[]) {
    return { collections, unresolved: [], outOfScope: [] };
}

beforeEach(() => {
    vi.clearAllMocks();
    collectionsFilterError.mockReturnValue(null);
    resolveCollectionsFilter.mockReturnValue(resolvedTo([]));
    const zotero = (globalThis as any).Zotero;
    zotero.Items = { ...(zotero.Items ?? {}), loadDataTypes: vi.fn(async () => {}) };
    zotero.Collections = { get: vi.fn() };
});

describe('handleItemSearchByMetadataRequest collection scope', () => {
    it('gives each library only the keys resolved in that library', async () => {
        // "Papers" exists in both libraries under different keys.
        resolveCollectionsFilter.mockReturnValue(
            resolvedTo([
                { id: 11, key: 'AAAAAAAA', libraryID: 1 },
                { id: 55, key: 'BBBBBBBB', libraryID: 5 },
            ])
        );
        searchItemsByMetadata.mockImplementation(async (libraryId: number) => [searchHit(libraryId, 1)]);

        const res = await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r1',
            collections_filter: ['Papers'],
            limit: 10,
        } as any);

        expect(resolveCollectionsFilter).toHaveBeenCalledWith(['Papers'], [1, 5]);
        const keysByLibrary = searchItemsByMetadata.mock.calls.map(
            (call) => [call[0], call[1].collection_keys] as const
        );
        expect(keysByLibrary).toEqual([
            [1, ['AAAAAAAA']],
            [5, ['BBBBBBBB']],
        ]);
        // Both libraries contribute; neither is emptied by a foreign key.
        expect(res.items.map((i: any) => i.item.library_id)).toEqual([1, 5]);
        expect(res.error ?? null).toBeNull();
    });

    it('skips libraries where no collection resolved instead of searching them library-wide', async () => {
        resolveCollectionsFilter.mockReturnValue(resolvedTo([{ id: 55, key: 'BBBBBBBB', libraryID: 5 }]));
        searchItemsByMetadata.mockImplementation(async (libraryId: number) => [searchHit(libraryId, 1)]);

        await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r2',
            collections_filter: ['Group papers'],
            limit: 10,
        } as any);

        expect(searchItemsByMetadata.mock.calls.map((call) => call[0])).toEqual([5]);
    });

    it('returns an error instead of searching when the filter resolves in no library', async () => {
        resolveCollectionsFilter.mockReturnValue({
            collections: [],
            unresolved: ['Typo'],
            outOfScope: [],
        });
        collectionsFilterError.mockReturnValue({
            message: 'Collection not found: "Typo". Use list_collections to discover the available collections.',
            error_code: 'collection_not_found',
        });
        searchItemsByMetadata.mockResolvedValue([searchHit(1, 1)]);

        const res = await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r3',
            title_query: 'the',
            collections_filter: ['Typo'],
            limit: 10,
        } as any);

        expect(res.items).toEqual([]);
        expect(res.error).toContain('Collection not found: "Typo"');
        expect(res.error_code).toBe('collection_not_found');
        expect(searchItemsByMetadata).not.toHaveBeenCalled();
    });

    it('reports an excluded library rather than a missing collection', async () => {
        resolveCollectionsFilter.mockReturnValue({
            collections: [],
            unresolved: [],
            outOfScope: [{ input: 'ABCD1234', name: 'Private', libraryId: 42 }],
        });
        collectionsFilterError.mockReturnValue({
            message: 'The library "Excluded" is excluded from Beaver.',
            error_code: 'library_not_searchable',
        });

        const res = await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r4',
            collections_filter: ['ABCD1234'],
            limit: 10,
        } as any);

        expect(res.error_code).toBe('library_not_searchable');
        // The excluded collection's own name never reaches the model.
        expect(res.error).not.toContain('Private');
        expect(searchItemsByMetadata).not.toHaveBeenCalled();
    });

    it('unions every requested collection in a library', async () => {
        resolveCollectionsFilter.mockReturnValue(
            resolvedTo([
                { id: 1, key: 'AAAAAAAA', libraryID: 1 },
                { id: 2, key: 'BBBBBBBB', libraryID: 1 },
            ])
        );
        searchItemsByMetadata.mockResolvedValue([]);

        await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r5',
            collections_filter: ['AAAAAAAA', 'BBBBBBBB'],
            limit: 10,
        } as any);

        expect(searchItemsByMetadata.mock.calls[0][1].collection_keys).toEqual([
            'AAAAAAAA',
            'BBBBBBBB',
        ]);
    });

    it('searches without a collection scope when no filter is requested', async () => {
        searchItemsByMetadata.mockResolvedValue([]);

        await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r6',
            title_query: 'the',
            limit: 10,
        } as any);

        expect(resolveCollectionsFilter).not.toHaveBeenCalled();
        expect(searchItemsByMetadata.mock.calls.map((call) => call[0])).toEqual([1, 5]);
        expect(searchItemsByMetadata.mock.calls[0][1].collection_keys).toBeUndefined();
    });
});
