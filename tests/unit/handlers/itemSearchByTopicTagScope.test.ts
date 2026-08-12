/**
 * Tests for the tag scoping of handleItemSearchByTopicRequest: a tags_filter is
 * resolved before the semantic search, an entry that matches no existing tag is
 * reported as an error rather than as an empty result, and the ranked results
 * are filtered by the resolved tag names. Resolving the filter itself is covered
 * by resolveTagsFilter.test.ts.
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
    collectionsFilterError: vi.fn(() => null),
    getCollectionScopeItemIds: vi.fn(),
    getSearchableLibraryIds: vi.fn(() => [1]),
    prepareAttachmentInfoBatchData: vi.fn(async () => ({})),
    processAttachmentInfoBatch: vi.fn(async () => []),
    resolveLibrariesFilter: vi.fn(() => ({ libraryIds: [1], unresolved: [], excluded: [] })),
    librariesFilterError: vi.fn(() => null),
    resolveTagsFilter: vi.fn(async () => ({ tags: [], unresolved: [] })),
    tagsFilterError: vi.fn(() => null),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    deduplicateItems: vi.fn((items: any[]) => items),
}));

vi.mock('../../../src/utils/agentItemSupport', () => ({
    agentItemFilter: vi.fn(() => true),
}));

vi.mock('../../../src/utils/zoteroSerializers', () => ({
    serializeItem: vi.fn(async (item: any) => ({ zotero_key: item.key })),
}));

import type { WSItemSearchByTopicRequest } from '@beaver/agent-core/protocol/agentProtocol';
import { handleItemSearchByTopicRequest } from '../../../src/services/agentDataProvider/handleItemSearchByTopicRequest';
import {
    resolveTagsFilter,
    tagsFilterError,
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

/** A ranked item carrying the given tags. */
function taggedItem(id: number, tags: string[]) {
    return {
        id,
        key: `KEY${id}`,
        libraryID: 1,
        getTags: () => tags.map((tag) => ({ tag })),
    };
}

/** Wire the semantic search and item loading to return exactly these items. */
function rankItems(items: any[]) {
    searchMock.mockResolvedValue(items.map((item, i) => ({ itemId: item.id, similarity: 0.9 - i / 100 })));
    (globalThis as any).Zotero.Items.getAsync = vi.fn(async () => items);
}

describe('handleItemSearchByTopicRequest tag scoping', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        searchMock.mockResolvedValue([]);
        vi.mocked(tagsFilterError).mockReturnValue(null);
        vi.mocked(resolveTagsFilter).mockResolvedValue({ tags: [], unresolved: [] });
        (globalThis as any).Zotero = {
            Beaver: { db: {} },
            Collections: { get: vi.fn(() => null) },
            Items: { getAsync: vi.fn(async () => []), loadDataTypes: vi.fn(async () => undefined) },
        };
    });

    it('resolves the filter against the searched libraries', async () => {
        vi.mocked(resolveTagsFilter).mockResolvedValue({ tags: ['Economics'], unresolved: [] });

        await handleItemSearchByTopicRequest(makeRequest({ tags_filter: ['economics'] }));

        expect(resolveTagsFilter).toHaveBeenCalledWith(['economics'], [1]);
        expect(searchMock).toHaveBeenCalledTimes(1);
    });

    it('returns an error and skips the search when no tag exists', async () => {
        vi.mocked(resolveTagsFilter).mockResolvedValue({
            tags: [],
            unresolved: [{ input: 'econimics', suggestions: ['Economics'] }],
        });
        vi.mocked(tagsFilterError).mockReturnValue({
            message: 'Tag not found: "econimics" (did you mean "Economics"?).',
            error_code: 'tag_not_found',
        });

        const response = await handleItemSearchByTopicRequest(
            makeRequest({ tags_filter: ['econimics'] })
        );

        expect(response.items).toEqual([]);
        expect(response.error_code).toBe('tag_not_found');
        expect(response.error).toContain('did you mean "Economics"');
        expect(response.timing).toBeDefined();
        expect(searchMock).not.toHaveBeenCalled();
    });

    it('returns no results rather than ranking without a tags_filter that resolved to nothing', async () => {
        vi.mocked(resolveTagsFilter).mockResolvedValue({ tags: [], unresolved: [] });

        const response = await handleItemSearchByTopicRequest(
            makeRequest({ tags_filter: ['economics'] })
        );

        expect(response.items).toEqual([]);
        expect(response.error ?? null).toBeNull();
        expect(searchMock).not.toHaveBeenCalled();
    });

    it('keeps a ranked item whose tag differs from the request only in casing', async () => {
        vi.mocked(resolveTagsFilter).mockResolvedValue({ tags: ['Economics'], unresolved: [] });
        rankItems([taggedItem(11, ['Economics'])]);

        const response = await handleItemSearchByTopicRequest(
            makeRequest({ tags_filter: ['economics'] })
        );

        expect(response.error ?? null).toBeNull();
        expect(response.items.map((i: any) => i.item.zotero_key)).toEqual(['KEY11']);
    });

    it('drops ranked items that carry none of the resolved tags', async () => {
        vi.mocked(resolveTagsFilter).mockResolvedValue({ tags: ['Economics'], unresolved: [] });
        rankItems([taggedItem(11, ['Economics']), taggedItem(12, ['Sociology'])]);

        const response = await handleItemSearchByTopicRequest(
            makeRequest({ tags_filter: ['economics'] })
        );

        expect(response.items.map((i: any) => i.item.zotero_key)).toEqual(['KEY11']);
    });

    it('does not resolve or filter by tags when no tags_filter is requested', async () => {
        rankItems([taggedItem(11, [])]);

        const response = await handleItemSearchByTopicRequest(makeRequest());

        expect(resolveTagsFilter).not.toHaveBeenCalled();
        expect(response.items.map((i: any) => i.item.zotero_key)).toEqual(['KEY11']);
    });
});
