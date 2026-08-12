/**
 * The HTTP surface of the two item-search handlers.
 *
 * A typed failure (an unresolvable collection filter, an excluded library, …)
 * must reach the caller over HTTP too: forwarding only `items` would turn every
 * one of them into a search that appears to have found nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/agentDataProvider', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    handleItemSearchByMetadataRequest: vi.fn(),
    handleItemSearchByTopicRequest: vi.fn(),
}));

import {
    handleItemSearchByMetadataRequest,
    handleItemSearchByTopicRequest,
} from '../../../src/services/agentDataProvider';
import {
    handleMetadataSearchHttpRequest,
    handleTopicSearchHttpRequest,
} from '../../../react/hooks/useHttpEndpoints';

const metadataHandler = handleItemSearchByMetadataRequest as unknown as ReturnType<typeof vi.fn>;
const topicHandler = handleItemSearchByTopicRequest as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.clearAllMocks();
});

describe('metadata search HTTP endpoint', () => {
    it('forwards a typed collection-filter failure', async () => {
        metadataHandler.mockResolvedValue({
            type: 'item_search_by_metadata',
            request_id: 'req-1',
            items: [],
            error: 'No search was run: 1 of 1 collection filters could not be resolved.',
            error_code: 'collection_not_found',
        });

        const response = await handleMetadataSearchHttpRequest({
            title_query: 'anything',
            collections_filter: ['No Such Collection'],
            limit: 10,
        });

        expect(response).toMatchObject({
            items: [],
            error_code: 'collection_not_found',
        });
        expect(response.error).toContain('could not be resolved');
        expect(metadataHandler).toHaveBeenCalledWith(
            expect.objectContaining({ collections_filter: ['No Such Collection'] })
        );
    });

    it('reports null error fields on a successful search', async () => {
        metadataHandler.mockResolvedValue({
            type: 'item_search_by_metadata',
            request_id: 'req-1',
            items: [{ item: { zotero_key: 'ITEM2222' }, attachments: [] }],
        });

        const response = await handleMetadataSearchHttpRequest({ title_query: 'anything', limit: 10 });

        expect(response.items).toHaveLength(1);
        expect(response.error).toBeNull();
        expect(response.error_code).toBeNull();
    });
});

describe('topic search HTTP endpoint', () => {
    it('forwards a typed collection-filter failure', async () => {
        topicHandler.mockResolvedValue({
            type: 'item_search_by_topic',
            request_id: 'req-1',
            items: [],
            error: 'Collection not found: No Such Collection',
            error_code: 'collection_not_found',
        });

        const response = await handleTopicSearchHttpRequest({
            topic_query: 'anything',
            collections_filter: ['No Such Collection'],
            limit: 10,
        });

        expect(response).toMatchObject({
            items: [],
            error_code: 'collection_not_found',
        });
        expect(response.error).toContain('No Such Collection');
    });

    it('reports null error fields on a successful search', async () => {
        topicHandler.mockResolvedValue({
            type: 'item_search_by_topic',
            request_id: 'req-1',
            items: [{ item: { zotero_key: 'ITEM2222' }, attachments: [], similarity: 0.9 }],
        });

        const response = await handleTopicSearchHttpRequest({ topic_query: 'anything', limit: 10 });

        expect(response.items).toHaveLength(1);
        expect(response.error).toBeNull();
        expect(response.error_code).toBeNull();
    });
});
