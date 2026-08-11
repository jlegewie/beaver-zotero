/**
 * Tests for the collection scoping of handleItemSearchByTopicRequest: the
 * collections filter is resolved to an item allowlist that is handed to the
 * semantic search, rather than applied to the ranked results — and a filter
 * that resolves to no usable collection is reported as an error rather than as
 * an empty result. Resolving the filter itself is covered by the
 * `resolveCollectionsFilter` tests in collectionScope.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { searchMock } = vi.hoisted(() => ({ searchMock: vi.fn() }));

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));

vi.mock('../../../src/services/semanticSearchService', () => ({
    semanticSearchService: vi.fn(() => ({ search: searchMock })),
}));

vi.mock('../../../src/services/database', () => ({
    BeaverDB: class {},
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    resolveCollectionsFilter: vi.fn(),
    collectionsFilterError: vi.fn(),
    getCollectionScopeItemIds: vi.fn(),
    getSearchableLibraryIds: vi.fn(() => [1]),
    prepareAttachmentInfoBatchData: vi.fn(),
    processAttachmentInfoBatch: vi.fn(),
    resolveLibrariesFilterToSearchableIds: vi.fn(() => [1]),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    deduplicateItems: vi.fn((items: any[]) => items),
}));

vi.mock('../../../src/utils/agentItemSupport', () => ({
    agentItemFilter: vi.fn(() => true),
}));

vi.mock('../../../src/utils/zoteroSerializers', () => ({
    serializeItem: vi.fn(),
}));

import type { WSItemSearchByTopicRequest } from '@beaver/agent-core/protocol/agentProtocol';
import { handleItemSearchByTopicRequest } from '../../../src/services/agentDataProvider/handleItemSearchByTopicRequest';
import {
    collectionsFilterError,
    getCollectionScopeItemIds,
    resolveCollectionsFilter,
} from '../../../src/services/agentDataProvider/utils';

function makeRequest(overrides: Partial<WSItemSearchByTopicRequest> = {}): WSItemSearchByTopicRequest {
    return {
        type: 'item_search_by_topic_request',
        request_id: 'req-1',
        topic_query: 'climate adaptation',
        limit: 10,
        ...overrides,
    } as WSItemSearchByTopicRequest;
}

/** Options the handler passed to semanticSearchService.search(). */
const searchOptions = () => searchMock.mock.calls[0]?.[1];

const collection = { id: 7, key: 'COLL7', libraryID: 1 };

describe('handleItemSearchByTopicRequest collection scoping', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        searchMock.mockResolvedValue([]);
        vi.mocked(collectionsFilterError).mockReturnValue(null);
        vi.mocked(resolveCollectionsFilter).mockReturnValue({
            collections: [],
            unresolved: [],
            outOfScope: [],
        });
        (globalThis as any).Zotero = {
            Beaver: { db: {} },
            Collections: { get: vi.fn(() => null) },
            Items: { getAsync: vi.fn(async () => []), loadDataTypes: vi.fn(async () => undefined) },
        };
    });

    it('returns an error and skips the search when the collections filter resolves to nothing', async () => {
        vi.mocked(resolveCollectionsFilter).mockReturnValue({
            collections: [],
            unresolved: ['Nonexistent'],
            outOfScope: [],
        });
        vi.mocked(collectionsFilterError).mockReturnValue({
            message: 'Collection not found: "Nonexistent". Use list_collections to discover the available collections.',
            error_code: 'collection_not_found',
        });

        const response = await handleItemSearchByTopicRequest(
            makeRequest({ collections_filter: ['Nonexistent'] })
        );

        expect(response.items).toEqual([]);
        expect(response.error).toContain('Collection not found: "Nonexistent"');
        expect(response.error_code).toBe('collection_not_found');
        expect(response.timing).toBeDefined();
        expect(searchMock).not.toHaveBeenCalled();
        // The allowlist is never built for a filter that resolved to nothing.
        expect(getCollectionScopeItemIds).not.toHaveBeenCalled();
    });

    it('reports an excluded library rather than a missing collection', async () => {
        vi.mocked(resolveCollectionsFilter).mockReturnValue({
            collections: [],
            unresolved: [],
            outOfScope: [{ input: 'ABCD1234', name: 'Private', libraryId: 42 }],
        });
        vi.mocked(collectionsFilterError).mockReturnValue({
            message: 'The library "Excluded" is excluded from Beaver.',
            error_code: 'library_not_searchable',
        });

        const response = await handleItemSearchByTopicRequest(
            makeRequest({ collections_filter: ['ABCD1234'] })
        );

        expect(response.error_code).toBe('library_not_searchable');
        // The excluded collection's own name never reaches the model.
        expect(response.error).not.toContain('Private');
        expect(searchMock).not.toHaveBeenCalled();
    });

    it('returns no items and no error when the collection scope holds no items', async () => {
        vi.mocked(resolveCollectionsFilter).mockReturnValue({
            collections: [collection],
            unresolved: [],
            outOfScope: [],
        });
        vi.mocked(getCollectionScopeItemIds).mockResolvedValue([]);

        const response = await handleItemSearchByTopicRequest(
            makeRequest({ collections_filter: ['Empty'] })
        );

        expect(response.items).toEqual([]);
        // The collection exists and is simply empty: an honest empty result.
        expect(response.error ?? null).toBeNull();
        expect(response.timing).toBeDefined();
        expect(getCollectionScopeItemIds).toHaveBeenCalledWith([collection]);
        expect(searchMock).not.toHaveBeenCalled();
    });

    it('passes the collection scope item IDs to the search as an allowlist', async () => {
        vi.mocked(resolveCollectionsFilter).mockReturnValue({
            collections: [collection],
            unresolved: [],
            outOfScope: [],
        });
        vi.mocked(getCollectionScopeItemIds).mockResolvedValue([11, 22, 33]);

        await handleItemSearchByTopicRequest(makeRequest({ collections_filter: ['Reading'] }));

        expect(resolveCollectionsFilter).toHaveBeenCalledWith(['Reading'], [1]);
        expect(searchMock).toHaveBeenCalledTimes(1);
        expect(searchOptions()).toMatchObject({ itemIds: [11, 22, 33], libraryIds: [1] });
    });

    it('does not pass an allowlist when no collections filter is requested', async () => {
        await handleItemSearchByTopicRequest(makeRequest());

        expect(searchMock).toHaveBeenCalledTimes(1);
        expect(searchOptions().itemIds).toBeUndefined();
        expect(resolveCollectionsFilter).not.toHaveBeenCalled();
        expect(getCollectionScopeItemIds).not.toHaveBeenCalled();
    });
});
