/**
 * `handleItemQuickSearchRequest` — ranking, projection and scope.
 *
 * The quick search exists because a picker has one string and cannot say which
 * field it belongs to, so what these tests pin is the contract that follows
 * from that: hits come back ranked (not in library order), paging that ranked
 * list is stable, and the projection is a parameter rather than a second op.
 * Filter *resolution* is shared with the fielded search and covered by its own
 * tests; what is pinned here is that an unusable filter narrows or errors and
 * never widens into a library-wide search.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    deduplicateItems: vi.fn((items: any[]) => items),
}));

vi.mock('../../../src/utils/agentItemSupport', () => ({
    agentItemFilter: vi.fn(() => true),
}));

vi.mock('../../../src/utils/itemDisplayName', () => ({
    getItemDisplayName: vi.fn((item: any) => `${item.firstCreator} ${item.year}`),
}));

// The row's second line has its own suite (utils/itemDescription.test.ts);
// stubbed here so these tests stay about ranking, paging and scope.
vi.mock('../../../src/utils/itemDescription', () => ({
    getItemDescription: vi.fn((item: any) => `Description ${item.key}`),
}));

// The reference line has its own suite (utils/itemReference.test.ts); here it
// only has to be distinguishable from the description.
vi.mock('../../../src/utils/itemReference', () => ({
    formatItemReference: vi.fn((item: any) => `Reference ${item.key}`),
}));

vi.mock('../../../src/utils/zoteroSerializers', () => ({
    getYearFromItem: (item: any) => item.year,
    serializeItem: mocks.serializeItem,
}));

vi.mock('../../../src/utils/libraryIdentity', () => ({
    libraryRefForLibraryID: vi.fn((libraryID: number) => (libraryID === 1 ? 'u' : `g${libraryID}`)),
}));

const mocks = vi.hoisted(() => ({
    quickSearchItems: vi.fn(),
    scoreSearchResult: vi.fn(),
    serializeItem: vi.fn(),
    getSearchableLibraryIds: vi.fn(() => [1, 5]),
    resolveLibrariesFilter: vi.fn(() => ({ libraryIds: [1, 5], unresolved: [], excluded: [] })),
    librariesFilterError: vi.fn(() => null),
    resolveCollectionsFilter: vi.fn(),
    collectionsFilterError: vi.fn(),
    resolveTagsFilter: vi.fn(),
    tagsFilterError: vi.fn(() => null),
}));
const {
    quickSearchItems,
    scoreSearchResult,
    resolveCollectionsFilter,
    collectionsFilterError,
    resolveTagsFilter,
    tagsFilterError,
} = mocks;

vi.mock('../../../src/services/librarySearch/quickSearch', () => ({
    quickSearchItems: mocks.quickSearchItems,
}));

vi.mock('../../../src/services/librarySearch/ranking', () => ({
    scoreSearchResult: mocks.scoreSearchResult,
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getSearchableLibraryIds: mocks.getSearchableLibraryIds,
    resolveLibrariesFilter: mocks.resolveLibrariesFilter,
    librariesFilterError: mocks.librariesFilterError,
    resolveCollectionsFilter: mocks.resolveCollectionsFilter,
    collectionsFilterError: mocks.collectionsFilterError,
    resolveTagsFilter: mocks.resolveTagsFilter,
    tagsFilterError: mocks.tagsFilterError,
    prepareAttachmentInfoBatchData: vi.fn(async () => ({})),
    processAttachmentInfoBatch: vi.fn(async () => []),
}));

import { handleItemQuickSearchRequest } from '../../../src/services/agentDataProvider/handleItemQuickSearchRequest';
import { formatItemReference } from '../../../src/utils/itemReference';

/** A regular, non-trashed item the handler will accept. */
function searchHit(libraryID: number, key: string, overrides: Record<string, any> = {}) {
    return {
        id: Number(`${libraryID}${key.length}`),
        key,
        libraryID,
        deleted: false,
        itemType: 'journalArticle',
        firstCreator: 'Legewie and DiPrete',
        year: 2014,
        isRegularItem: () => true,
        getField: (field: string) => (field === 'title' ? `Title ${key}` : ''),
        getDisplayTitle: () => `Title ${key}`,
        getAttachments: () => [],
        ...overrides,
    };
}

/** The envelope `quickSearchItems` returns for one library. */
function searchResult(items: any[], extraMatches = 0) {
    return {
        items,
        matchCount: items.length + extraMatches,
        truncated: extraMatches > 0,
    };
}

function request(overrides: Record<string, any> = {}) {
    return {
        event: 'item_quick_search_request',
        request_id: 'r1',
        query: 'legewie high school',
        ...overrides,
    } as any;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSearchableLibraryIds.mockReturnValue([1, 5]);
    collectionsFilterError.mockReturnValue(null);
    tagsFilterError.mockReturnValue(null);
    resolveCollectionsFilter.mockReturnValue({ collections: [], unresolved: [], outOfScope: [] });
    resolveTagsFilter.mockResolvedValue({ tags: [], unresolved: [] });
    quickSearchItems.mockResolvedValue(searchResult([]));
    mocks.serializeItem.mockImplementation(async (item: any) => ({
        zotero_key: item.key,
        library_id: item.libraryID,
    }));
    scoreSearchResult.mockReturnValue(1);
    const zotero = (globalThis as any).Zotero;
    zotero.Items = { ...(zotero.Items ?? {}), loadDataTypes: vi.fn(async () => {}) };
});

describe('handleItemQuickSearchRequest projection', () => {
    it('returns compact hits carrying the Zotero-computed display name and description', async () => {
        quickSearchItems.mockImplementation(async (libraryId: number) =>
            searchResult(libraryId === 1 ? [searchHit(1, 'AAAAAAAA', { getAttachments: () => [99] })] : [])
        );

        const res = await handleItemQuickSearchRequest(request());

        expect(res.detail).toBe('compact');
        expect(res.items).toEqual([
            {
                library_id: 1,
                library_ref: 'u',
                zotero_key: 'AAAAAAAA',
                item_type: 'journalArticle',
                display_name: 'Legewie and DiPrete 2014',
                description: 'Description AAAAAAAA',
                title: 'Title AAAAAAAA',
                year: 2014,
                formatted_citation: 'Reference AAAAAAAA',
                has_attachment: true,
                score: 1,
            },
        ]);
        expect(res.total_count).toBe(1);
    });

    it('renders a citation for every hit on the page', async () => {
        quickSearchItems.mockImplementation(async (libraryId: number) =>
            searchResult(libraryId === 1 ? [searchHit(1, 'AAAAAAAA'), searchHit(1, 'BBBBBBBB')] : [])
        );

        const res = await handleItemQuickSearchRequest(request());

        expect(formatItemReference).toHaveBeenCalledTimes(2);
        expect(res.items.every((hit: any) => typeof hit.formatted_citation === 'string')).toBe(true);
    });

    it('carries both the citation and the shorter description per hit', async () => {
        quickSearchItems.mockImplementation(async (libraryId: number) =>
            searchResult(libraryId === 1 ? [searchHit(1, 'AAAAAAAA')] : [])
        );

        const res = await handleItemQuickSearchRequest(request());

        expect((res.items[0] as any).formatted_citation).toBe('Reference AAAAAAAA');
        expect((res.items[0] as any).description).toBe('Description AAAAAAAA');
    });

    it('returns full search rows when detail is full', async () => {
        quickSearchItems.mockImplementation(async (libraryId: number) =>
            searchResult(libraryId === 1 ? [searchHit(1, 'AAAAAAAA')] : [])
        );

        const res = await handleItemQuickSearchRequest(request({ detail: 'full' }));

        expect(res.detail).toBe('full');
        expect(res.items).toEqual([
            { item: { zotero_key: 'AAAAAAAA', library_id: 1 }, attachments: [] },
        ]);
    });
});

describe('handleItemQuickSearchRequest ranking', () => {
    it('orders hits by score across libraries rather than by library', async () => {
        quickSearchItems.mockImplementation(async (libraryId: number) =>
            searchResult(libraryId === 1 ? [searchHit(1, 'LOWSCORE')] : [searchHit(5, 'TOPSCORE')])
        );
        scoreSearchResult.mockImplementation((item: any) => (item.key === 'TOPSCORE' ? 900 : 100));

        const res = await handleItemQuickSearchRequest(request());

        expect((res.items as any[]).map((hit) => hit.zotero_key)).toEqual(['TOPSCORE', 'LOWSCORE']);
        expect((res.items as any[]).map((hit) => hit.score)).toEqual([900, 100]);
    });

    it('keeps zero-score matches, ranked last, instead of discarding them', async () => {
        // Zotero's quicksearch also matches publicationTitle, shortTitle, court,
        // citationKey and the item key; the scorer reads none of those, so a
        // real match can score zero. Dropping it would lose, say, every article
        // found by its journal name.
        quickSearchItems.mockImplementation(async (libraryId: number) =>
            searchResult(libraryId === 1 ? [searchHit(1, 'UNSCORED'), searchHit(1, 'SCOREDXX')] : [])
        );
        scoreSearchResult.mockImplementation((item: any) => (item.key === 'SCOREDXX' ? 5 : 0));

        const res = await handleItemQuickSearchRequest(request());

        expect((res.items as any[]).map((hit) => hit.zotero_key)).toEqual(['SCOREDXX', 'UNSCORED']);
        expect(res.total_count).toBe(2);
    });

    it('pages the ranked list and reports the pre-pagination total', async () => {
        const keys = ['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC', 'DDDDDDDD'];
        quickSearchItems.mockImplementation(async (libraryId: number) =>
            searchResult(libraryId === 1 ? keys.map((key) => searchHit(1, key)) : [])
        );
        // Descending score in key order, so the ranked order is predictable.
        scoreSearchResult.mockImplementation((item: any) => 100 - keys.indexOf(item.key));

        const res = await handleItemQuickSearchRequest(request({ limit: 2, offset: 1 }));

        expect((res.items as any[]).map((hit) => hit.zotero_key)).toEqual(['BBBBBBBB', 'CCCCCCCC']);
        expect(res.total_count).toBe(4);
    });

    it('reports truncation when a library holds more matches than can be ranked', async () => {
        // Zotero returns matches in item-id order, so a library over the budget
        // is ranked on an arbitrary slice. total_count then undercounts, and
        // saying so is what stops a client reading it as the true match count.
        quickSearchItems.mockImplementation(async (libraryId: number) =>
            searchResult(libraryId === 1 ? [searchHit(1, 'AAAAAAAA')] : [], 4000)
        );

        const res = await handleItemQuickSearchRequest(request());

        expect(res.truncated).toBe(true);
        expect(res.total_count).toBe(1);
    });

    it('splits one global candidate budget across the libraries in scope', async () => {
        // The work after the search — data loading, and deduplication above all
        // — is global and grows faster than linearly, so the cap has to bound
        // the union rather than each library's share of it.
        const budgetFor = async (libraryIds: number[]) => {
            mocks.getSearchableLibraryIds.mockReturnValue(libraryIds);
            quickSearchItems.mockClear();
            await handleItemQuickSearchRequest(request());
            return quickSearchItems.mock.calls.map((call) => call[1].limit);
        };

        const one = await budgetFor([1]);
        const ten = await budgetFor([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

        expect(one).toEqual([2000]);
        expect(ten).toEqual(Array(10).fill(200));
        // The guarantee: total candidates stay bounded however many libraries
        // are in scope, rather than multiplying by the library count.
        for (const limits of [one, ten]) {
            expect(limits.reduce((sum, limit) => sum + limit, 0)).toBeLessThanOrEqual(2000);
        }
    });

    it('never repeats a full row on the next page when one fails to serialize', async () => {
        // Backfilling a failed row from beyond the page would hand the next
        // page's first hit to this one, so consecutive offsets would overlap.
        const keys = ['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC'];
        quickSearchItems.mockImplementation(async (libraryId: number) =>
            searchResult(libraryId === 1 ? keys.map((key) => searchHit(1, key)) : [])
        );
        scoreSearchResult.mockImplementation((item: any) => 100 - keys.indexOf(item.key));
        mocks.serializeItem.mockImplementation(async (item: any) => {
            if (item.key === 'AAAAAAAA') throw new Error('unreadable');
            return { zotero_key: item.key, library_id: item.libraryID };
        });

        const firstPage = await handleItemQuickSearchRequest(request({ detail: 'full', limit: 2, offset: 0 }));
        const secondPage = await handleItemQuickSearchRequest(request({ detail: 'full', limit: 2, offset: 2 }));

        const keysOf = (res: any) => (res.items as any[]).map((row) => row.item.zotero_key);
        // The page comes back short rather than borrowing from the next one.
        expect(keysOf(firstPage)).toEqual(['BBBBBBBB']);
        expect(keysOf(secondPage)).toEqual(['CCCCCCCC']);
        expect(keysOf(firstPage).filter((key) => keysOf(secondPage).includes(key))).toEqual([]);
    });

    it('does not report truncation when every match was ranked', async () => {
        quickSearchItems.mockImplementation(async (libraryId: number) =>
            searchResult(libraryId === 1 ? [searchHit(1, 'AAAAAAAA')] : [])
        );

        const res = await handleItemQuickSearchRequest(request());

        expect(res.truncated).toBe(false);
    });

    it('breaks score ties deterministically so offsets page a stable list', async () => {
        quickSearchItems.mockImplementation(async (libraryId: number) =>
            searchResult(libraryId === 1
                ? [searchHit(1, 'BBBBBBBB'), searchHit(1, 'AAAAAAAA')]
                : [searchHit(5, 'AAAAAAAA')])
        );
        scoreSearchResult.mockReturnValue(42);

        const res = await handleItemQuickSearchRequest(request());

        expect((res.items as any[]).map((hit) => `${hit.library_id}-${hit.zotero_key}`)).toEqual([
            '1-AAAAAAAA',
            '1-BBBBBBBB',
            '5-AAAAAAAA',
        ]);
    });
});

describe('handleItemQuickSearchRequest scope and validation', () => {
    it('rejects a blank query instead of searching every library', async () => {
        const res = await handleItemQuickSearchRequest(request({ query: '   ' }));

        expect(res.items).toEqual([]);
        expect(res.error_code).toBe('invalid_request');
        expect(quickSearchItems).not.toHaveBeenCalled();
    });

    it('searches only the libraries a collections_filter resolved in', async () => {
        resolveCollectionsFilter.mockReturnValue({
            collections: [{ id: 55, key: 'BBBBBBBB', libraryID: 5 }],
            unresolved: [],
            outOfScope: [],
        });

        await handleItemQuickSearchRequest(request({ collections_filter: ['Group papers'] }));

        expect(quickSearchItems.mock.calls.map((call) => call[0])).toEqual([5]);
        expect(quickSearchItems.mock.calls[0][1].collection_keys).toEqual(['BBBBBBBB']);
    });

    it('spends the whole budget on the libraries a collections_filter left in scope', async () => {
        // Dividing by every searchable library would spend most of the budget
        // on libraries that are then skipped, so a collection-scoped search
        // would rank a sliver of its one relevant library and report truncation
        // that never had to happen.
        mocks.getSearchableLibraryIds.mockReturnValue([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        resolveCollectionsFilter.mockReturnValue({
            collections: [{ id: 55, key: 'BBBBBBBB', libraryID: 5 }],
            unresolved: [],
            outOfScope: [],
        });

        await handleItemQuickSearchRequest(request({ collections_filter: ['Group papers'] }));

        expect(quickSearchItems.mock.calls.map((call) => [call[0], call[1].limit])).toEqual([[5, 2000]]);
    });

    it('returns an error instead of searching when a collections_filter resolves nowhere', async () => {
        resolveCollectionsFilter.mockReturnValue({ collections: [], unresolved: ['Typo'], outOfScope: [] });
        collectionsFilterError.mockReturnValue({
            message: 'Collection not found: "Typo".',
            error_code: 'collection_not_found',
        });

        const res = await handleItemQuickSearchRequest(request({ collections_filter: ['Typo'] }));

        expect(res.error_code).toBe('collection_not_found');
        expect(quickSearchItems).not.toHaveBeenCalled();
    });

    it('passes the tag names Zotero stores, not the ones the caller sent', async () => {
        resolveTagsFilter.mockResolvedValue({ tags: ['Methods'], unresolved: [] });

        await handleItemQuickSearchRequest(request({ tags_filter: ['methods'] }));

        expect(quickSearchItems.mock.calls[0][1].tags).toEqual(['Methods']);
    });

    it('returns nothing when a tags_filter resolves to no tag and no error explains why', async () => {
        resolveTagsFilter.mockResolvedValue({ tags: [], unresolved: [] });

        const res = await handleItemQuickSearchRequest(request({ tags_filter: ['methods'] }));

        expect(res.items).toEqual([]);
        expect(res.error ?? null).toBeNull();
        expect(quickSearchItems).not.toHaveBeenCalled();
    });

    it('reports an error when every searched library fails', async () => {
        quickSearchItems.mockRejectedValue(new Error('db locked'));

        const res = await handleItemQuickSearchRequest(request());

        expect(res.items).toEqual([]);
        expect(res.error_code).toBe('internal_error');
    });

    it('still returns the libraries that answered when only some fail', async () => {
        quickSearchItems.mockImplementation(async (libraryId: number) => {
            if (libraryId === 1) throw new Error('db locked');
            return searchResult([searchHit(5, 'AAAAAAAA')]);
        });

        const res = await handleItemQuickSearchRequest(request());

        expect((res.items as any[]).map((hit) => hit.zotero_key)).toEqual(['AAAAAAAA']);
        expect(res.error ?? null).toBeNull();
    });
});
