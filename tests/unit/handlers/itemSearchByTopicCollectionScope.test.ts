/**
 * Tests for the collection scoping of handleItemSearchByTopicRequest: the
 * collections filter is resolved to an item allowlist that is handed to the
 * semantic search, rather than applied to the ranked results.
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
    getCollectionByIdOrName: vi.fn(),
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
    getCollectionByIdOrName,
    getCollectionScopeItemIds,
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

describe('handleItemSearchByTopicRequest collection scoping', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        searchMock.mockResolvedValue([]);
        (globalThis as any).Zotero = {
            Beaver: { db: {} },
            Collections: { get: vi.fn(() => null) },
            Items: { getAsync: vi.fn(async () => []), loadDataTypes: vi.fn(async () => undefined) },
        };
    });

    it('returns no items and skips the search when the collections filter resolves to nothing', async () => {
        vi.mocked(getCollectionByIdOrName).mockReturnValue(null);
        vi.mocked(getCollectionScopeItemIds).mockResolvedValue([]);

        const response = await handleItemSearchByTopicRequest(
            makeRequest({ collections_filter: ['Nonexistent'] })
        );

        expect(response.items).toEqual([]);
        expect(response.timing).toBeDefined();
        expect(searchMock).not.toHaveBeenCalled();
        expect(getCollectionScopeItemIds).toHaveBeenCalledWith([]);
    });

    it('returns no items and skips the search when the collection scope holds no items', async () => {
        const collection = { id: 7, key: 'COLL7', libraryID: 1 } as unknown as Zotero.Collection;
        vi.mocked(getCollectionByIdOrName).mockReturnValue({ collection, libraryID: 1 });
        vi.mocked(getCollectionScopeItemIds).mockResolvedValue([]);

        const response = await handleItemSearchByTopicRequest(
            makeRequest({ collections_filter: ['Empty'] })
        );

        expect(response.items).toEqual([]);
        expect(response.timing).toBeDefined();
        expect(getCollectionScopeItemIds).toHaveBeenCalledWith([collection]);
        expect(searchMock).not.toHaveBeenCalled();
    });

    it('passes the collection scope item IDs to the search as an allowlist', async () => {
        const collection = { id: 7, key: 'COLL7', libraryID: 1 } as unknown as Zotero.Collection;
        vi.mocked(getCollectionByIdOrName).mockReturnValue({ collection, libraryID: 1 });
        vi.mocked(getCollectionScopeItemIds).mockResolvedValue([11, 22, 33]);

        await handleItemSearchByTopicRequest(makeRequest({ collections_filter: ['Reading'] }));

        expect(searchMock).toHaveBeenCalledTimes(1);
        expect(searchOptions()).toMatchObject({ itemIds: [11, 22, 33], libraryIds: [1] });
    });

    it('drops a collection resolved outside the searchable libraries', async () => {
        // Key-like filters resolve through a cross-library fallback that can
        // land in a library the request is not scoped to.
        const foreign = { id: 9, key: 'COLL9', libraryID: 42 } as unknown as Zotero.Collection;
        vi.mocked(getCollectionByIdOrName).mockReturnValue({ collection: foreign, libraryID: 42 });
        vi.mocked(getCollectionScopeItemIds).mockResolvedValue([]);

        const response = await handleItemSearchByTopicRequest(
            makeRequest({ collections_filter: ['ABCD1234'] })
        );

        expect(response.items).toEqual([]);
        expect(getCollectionScopeItemIds).toHaveBeenCalledWith([]);
        expect(searchMock).not.toHaveBeenCalled();
    });

    it('deduplicates collections resolved from several filter entries', async () => {
        const collection = { id: 7, key: 'COLL7', libraryID: 1 } as unknown as Zotero.Collection;
        vi.mocked(getCollectionByIdOrName).mockReturnValue({ collection, libraryID: 1 });
        vi.mocked(getCollectionScopeItemIds).mockResolvedValue([11]);

        await handleItemSearchByTopicRequest(
            makeRequest({ collections_filter: ['Reading', 'COLL7'] })
        );

        expect(getCollectionScopeItemIds).toHaveBeenCalledWith([collection]);
    });

    it('does not pass an allowlist when no collections filter is requested', async () => {
        await handleItemSearchByTopicRequest(makeRequest());

        expect(searchMock).toHaveBeenCalledTimes(1);
        expect(searchOptions().itemIds).toBeUndefined();
        expect(getCollectionScopeItemIds).not.toHaveBeenCalled();
    });
});
