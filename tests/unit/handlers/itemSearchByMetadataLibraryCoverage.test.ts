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
    resolveLibrariesFilter: vi.fn(() => ({ libraryIds: [3, 1], unresolved: [], excluded: [] })),
    resolveTagsFilter: vi.fn(async () => ({ tags: [], unresolved: [] })),
}));
const {
    searchItemsByMetadata,
    getSearchableLibraryIds,
    resolveLibrariesFilter,
    resolveTagsFilter,
} = mocks;

vi.mock('../../../react/utils/searchTools', () => ({
    searchItemsByMetadata: mocks.searchItemsByMetadata,
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getSearchableLibraryIds: mocks.getSearchableLibraryIds,
    resolveLibrariesFilter: mocks.resolveLibrariesFilter,
    librariesFilterError: vi.fn(() => null),
    resolveCollectionsFilter: vi.fn(() => ({ collections: [], unresolved: [], outOfScope: [] })),
    collectionsFilterError: vi.fn(() => null),
    resolveTagsFilter: mocks.resolveTagsFilter,
    tagsFilterError: vi.fn(() => null),
    prepareAttachmentInfoBatchData: vi.fn(async () => ({})),
    processAttachmentInfoBatch: vi.fn(async () => []),
}));

import { librariesFilterError, tagsFilterError } from '../../../src/services/agentDataProvider/utils';
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
    resolveLibrariesFilter.mockReturnValue({ libraryIds: [3, 1], unresolved: [], excluded: [] });
    resolveTagsFilter.mockResolvedValue({ tags: [], unresolved: [] });
    // clearAllMocks() drops calls but keeps a mockReturnValue set by a prior test.
    vi.mocked(librariesFilterError).mockReturnValue(null);
    vi.mocked(tagsFilterError).mockReturnValue(null);
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

    it('forwards an unset tags_filter as undefined rather than the payload null', async () => {
        searchItemsByMetadata.mockResolvedValue([]);

        await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r6',
            author_query: 'Dean',
            tags_filter: null,
            limit: 10,
        } as any);

        const tags = searchItemsByMetadata.mock.calls.map((c) => c[1].tags);
        expect(tags).toEqual([undefined, undefined]);
    });

    it('searches for the resolved tag names rather than the requested spelling', async () => {
        // The Zotero search matches tags case-sensitively, so only the stored
        // spelling finds anything.
        resolveTagsFilter.mockResolvedValue({ tags: ['Economics'], unresolved: [] });
        searchItemsByMetadata.mockResolvedValue([]);

        await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r6a',
            author_query: 'Dean',
            tags_filter: ['economics'],
            limit: 10,
        } as any);

        expect(resolveTagsFilter).toHaveBeenCalledWith(['economics'], [3, 1]);
        const tags = searchItemsByMetadata.mock.calls.map((c) => c[1].tags);
        expect(tags).toEqual([['Economics'], ['Economics']]);
    });

    it('reports an unusable tags_filter as an error rather than an empty result', async () => {
        // A tag the library doesn't have must not read as "no item carries it".
        resolveTagsFilter.mockResolvedValue({
            tags: [],
            unresolved: [{ input: 'econimics', suggestions: ['Economics'] }],
        });
        vi.mocked(tagsFilterError).mockReturnValue({
            message: 'Tag not found: "econimics" (did you mean "Economics"?).',
            error_code: 'tag_not_found',
        });

        const res = await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r6b',
            author_query: 'Dean',
            tags_filter: ['econimics'],
            limit: 10,
        } as any);

        expect(res.items).toEqual([]);
        expect(res.error_code).toBe('tag_not_found');
        expect(res.error).toContain('did you mean "Economics"');
        // The search must never run unfiltered after an unusable filter.
        expect(searchItemsByMetadata).not.toHaveBeenCalled();
    });

    it('returns no results rather than dropping a tags_filter that resolved to nothing', async () => {
        // No error to report (no library in scope yet), but searching without the
        // requested tag would answer a different question.
        resolveTagsFilter.mockResolvedValue({ tags: [], unresolved: [] });

        const res = await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r6c',
            author_query: 'Dean',
            tags_filter: ['economics'],
            limit: 10,
        } as any);

        expect(res.items).toEqual([]);
        expect(res.error).toBeUndefined();
        expect(searchItemsByMetadata).not.toHaveBeenCalled();
    });

    it('reports an error when every searched library failed', async () => {
        searchItemsByMetadata.mockRejectedValue(new Error('boom'));

        const res = await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r7',
            author_query: 'Dean',
            limit: 10,
        } as any);

        // A failed search must not read as "this library has nothing".
        expect(res.items).toEqual([]);
        expect(res.error_code).toBe('internal_error');
        expect(res.error).toBeTruthy();
    });

    it('returns the libraries that answered when only some failed', async () => {
        searchItemsByMetadata.mockImplementation(async (libraryId: number) => {
            if (libraryId === 3) throw new Error('boom');
            return hits(1, 2);
        });

        const res = await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r8',
            author_query: 'Dean',
            limit: 10,
        } as any);

        expect(res.error).toBeUndefined();
        expect(res.items.map((i: any) => i.item.library_id)).toEqual([1, 1]);
    });

    it('reports an unusable libraries_filter as an error rather than an empty result', async () => {
        // A bad library reference must not read as "those libraries hold nothing".
        resolveLibrariesFilter.mockReturnValue({
            libraryIds: [],
            unresolved: ['g999999'],
            excluded: [],
        });
        vi.mocked(librariesFilterError).mockReturnValue({
            message: 'Library not found: "g999999".',
            error_code: 'library_not_found',
        });

        const res = await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r9',
            title_query: 'the',
            libraries_filter: ['g999999'],
            limit: 10,
        } as any);

        expect(res.items).toEqual([]);
        expect(res.error_code).toBe('library_not_found');
        expect(res.error).toBe('Library not found: "g999999".');
        // The search must never run library-wide after an unusable filter.
        expect(searchItemsByMetadata).not.toHaveBeenCalled();
    });

    it('searches only the libraries a partially resolvable filter found', async () => {
        resolveLibrariesFilter.mockReturnValue({
            libraryIds: [1],
            unresolved: ['g999999'],
            excluded: [],
        });
        searchItemsByMetadata.mockImplementation(async () => hits(1, 2));

        const res = await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata_request',
            request_id: 'r10',
            title_query: 'the',
            libraries_filter: ['u', 'g999999'],
            limit: 10,
        } as any);

        expect(res.error).toBeUndefined();
        expect(searchItemsByMetadata.mock.calls.map((c) => c[0])).toEqual([1]);
        expect(res.items).toHaveLength(2);
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
