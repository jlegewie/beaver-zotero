import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    // Identity: this suite is about which libraries reach the search, not about
    // duplicate collapsing.
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
    getSearchableLibraryIds: vi.fn(() => [3, 1]),
    resolveLibrariesFilterToSearchableIds: vi.fn(() => [3, 1]),
}));
const { searchItemsByMetadata, getSearchableLibraryIds, resolveLibrariesFilterToSearchableIds } = mocks;

vi.mock('../../../react/utils/searchTools', () => ({
    searchItemsByMetadata: mocks.searchItemsByMetadata,
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getSearchableLibraryIds: mocks.getSearchableLibraryIds,
    resolveLibrariesFilterToSearchableIds: mocks.resolveLibrariesFilterToSearchableIds,
    resolveCollectionsFilter: vi.fn(() => ({ collections: [], unresolved: [], outOfScope: [] })),
    collectionsFilterError: vi.fn(() => null),
    prepareAttachmentInfoBatchData: vi.fn(async () => ({})),
    processAttachmentInfoBatch: vi.fn(async () => []),
}));

import { handleItemSearchByMetadataRequest } from '../../../src/services/agentDataProvider/handleItemSearchByMetadataRequest';

/** A regular, non-trashed item the handler will accept. */
function searchHit(libraryID: number, n: number) {
    return {
        id: libraryID * 10000 + n,
        key: `L${libraryID}K${String(n).padStart(4, '0')}`,
        libraryID,
        deleted: false,
        isRegularItem: () => true,
    };
}

function hits(libraryID: number, count: number) {
    return Array.from({ length: count }, (_, i) => searchHit(libraryID, i));
}

beforeEach(() => {
    vi.clearAllMocks();
    getSearchableLibraryIds.mockReturnValue([3, 1]);
    resolveLibrariesFilterToSearchableIds.mockReturnValue([3, 1]);
    const zotero = (globalThis as any).Zotero;
    zotero.Items = { ...(zotero.Items ?? {}), loadDataTypes: vi.fn(async () => {}) };
});

describe('handleItemSearchByMetadataRequest library coverage', () => {
    it('searches every requested library even when the first one fills the search budget', async () => {
        // Library 3 alone returns more than the per-library budget of (0 + 4) * 2.
        searchItemsByMetadata.mockImplementation(async (libraryId: number) =>
            libraryId === 3 ? hits(3, 9) : hits(1, 30)
        );

        await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r1',
            title_query: 'the',
            limit: 4,
        } as any);

        const searched = searchItemsByMetadata.mock.calls.map((c) => c[0]);
        expect(searched).toEqual([3, 1]);
    });

    it('gives every library the same over-fetch budget', async () => {
        searchItemsByMetadata.mockResolvedValue([]);

        await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r2',
            title_query: 'the',
            limit: 10,
            offset: 5,
        } as any);

        const limits = searchItemsByMetadata.mock.calls.map((c) => c[1].limit);
        expect(limits).toEqual([30, 30]); // (5 + 10) * 2
    });

    it('caps the per-library budget so a deep offset cannot ask for unbounded rows', async () => {
        searchItemsByMetadata.mockResolvedValue([]);

        await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r3',
            title_query: 'the',
            limit: 25,
            offset: 5000,
        } as any);

        const limits = searchItemsByMetadata.mock.calls.map((c) => c[1].limit);
        expect(limits).toEqual([1000, 1000]);
    });

    it('passes a non-positive limit through as unlimited', async () => {
        searchItemsByMetadata.mockResolvedValue([]);

        await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r4',
            title_query: 'the',
            limit: 0,
        } as any);

        const limits = searchItemsByMetadata.mock.calls.map((c) => c[1].limit);
        expect(limits).toEqual([0, 0]);
    });

    it('keeps searching later libraries so their items can fill a later page', async () => {
        searchItemsByMetadata.mockImplementation(async (libraryId: number) =>
            libraryId === 3 ? hits(3, 9) : hits(1, 30)
        );

        const res = await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r5',
            title_query: 'the',
            limit: 4,
            offset: 8,
        } as any);

        // Positions 8.. span library 3's last hit and then library 1's.
        const libraryIds = res.items.map((i: any) => i.item.library_id);
        expect(libraryIds).toEqual([3, 1, 1, 1]);
    });
});
