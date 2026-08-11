/**
 * Collection scoping in `handleItemSearchByMetadataRequest`.
 *
 * A collection key only matches inside its own library, so the handler has to
 * bucket resolved keys per library. These tests pin that bucketing and the
 * guard that keeps an unresolvable filter from widening the search.
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
    getCollectionByIdOrName: vi.fn(),
}));
const { searchItemsByMetadata, getCollectionByIdOrName } = mocks;

vi.mock('../../../react/utils/searchTools', () => ({
    searchItemsByMetadata: mocks.searchItemsByMetadata,
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getSearchableLibraryIds: mocks.getSearchableLibraryIds,
    resolveLibrariesFilterToSearchableIds: mocks.resolveLibrariesFilterToSearchableIds,
    getCollectionByIdOrName: mocks.getCollectionByIdOrName,
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

beforeEach(() => {
    vi.clearAllMocks();
    const zotero = (globalThis as any).Zotero;
    zotero.Items = { ...(zotero.Items ?? {}), loadDataTypes: vi.fn(async () => {}) };
    zotero.Collections = { get: vi.fn() };
});

describe('handleItemSearchByMetadataRequest collection scope', () => {
    it('gives each library only the keys resolved in that library', async () => {
        // "Papers" exists in both libraries under different keys.
        getCollectionByIdOrName.mockImplementation((_name: string, libraryId: number) => ({
            collection: { libraryID: libraryId, key: libraryId === 1 ? 'AAAAAAAA' : 'BBBBBBBB' },
        }));
        searchItemsByMetadata.mockImplementation(async (libraryId: number) => [searchHit(libraryId, 1)]);

        const res = await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r1',
            collections_filter: ['Papers'],
            limit: 10,
        } as any);

        const keysByLibrary = searchItemsByMetadata.mock.calls.map(
            (call) => [call[0], call[1].collection_keys] as const
        );
        expect(keysByLibrary).toEqual([
            [1, ['AAAAAAAA']],
            [5, ['BBBBBBBB']],
        ]);
        // Both libraries contribute; neither is emptied by a foreign key.
        expect(res.items.map((i: any) => i.item.library_id)).toEqual([1, 5]);
    });

    it('skips libraries where no collection resolved instead of searching them library-wide', async () => {
        getCollectionByIdOrName.mockImplementation((_name: string, libraryId: number) =>
            libraryId === 5 ? { collection: { libraryID: 5, key: 'BBBBBBBB' } } : null
        );
        searchItemsByMetadata.mockImplementation(async (libraryId: number) => [searchHit(libraryId, 1)]);

        await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r2',
            collections_filter: ['Group papers'],
            limit: 10,
        } as any);

        expect(searchItemsByMetadata.mock.calls.map((call) => call[0])).toEqual([5]);
    });

    it('returns no items when the filter resolves in no library', async () => {
        getCollectionByIdOrName.mockReturnValue(null);
        searchItemsByMetadata.mockResolvedValue([searchHit(1, 1)]);

        const res = await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r3',
            title_query: 'the',
            collections_filter: ['Typo'],
            limit: 10,
        } as any);

        expect(res.items).toEqual([]);
        expect(searchItemsByMetadata).not.toHaveBeenCalled();
    });

    it('unions every requested collection in a library', async () => {
        getCollectionByIdOrName.mockImplementation((name: string, libraryId: number) =>
            libraryId === 1 ? { collection: { libraryID: 1, key: name } } : null
        );
        searchItemsByMetadata.mockResolvedValue([]);

        await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r4',
            collections_filter: ['AAAAAAAA', 'BBBBBBBB'],
            limit: 10,
        } as any);

        expect(searchItemsByMetadata.mock.calls[0][1].collection_keys).toEqual([
            'AAAAAAAA',
            'BBBBBBBB',
        ]);
    });
});
