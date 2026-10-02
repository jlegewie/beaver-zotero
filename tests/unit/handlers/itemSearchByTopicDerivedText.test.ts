/**
 * Topic search rows say what each item's embedding was built from and, for
 * items embedded from attachment text, carry that text for backend reranking.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { searchMock } = vi.hoisted(() => ({ searchMock: vi.fn() }));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/services/semanticSearchService', () => ({
    semanticSearchService: vi.fn(() => ({ search: searchMock })),
}));
vi.mock('../../../src/services/database', () => ({
    BeaverDB: class {},
    attachmentRefKey: (libraryId: number, zoteroKey: string) => `${libraryId}/${zoteroKey}`,
}));
vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getSearchableLibraryIds: vi.fn(() => [1]),
    prepareAttachmentInfoBatchData: vi.fn(async () => ({})),
    processAttachmentInfoBatch: vi.fn(async () => []),
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({ deduplicateItems: vi.fn((items: any[]) => items) }));
vi.mock('../../../src/utils/agentItemSupport', () => ({ agentItemFilter: vi.fn(() => true) }));
vi.mock('../../../src/utils/zoteroSerializers', () => ({
    serializeItem: vi.fn(async (item: any) => ({ zotero_key: item.key })),
}));

import type { WSItemSearchByTopicRequest } from '@beaver/agent-core/protocol/agentProtocol';
import { handleItemSearchByTopicRequest } from '../../../src/services/agentDataProvider/handleItemSearchByTopicRequest';

const request = {
    type: 'item_search_by_topic_request',
    request_id: 'req-1',
    topic_query: 'neighborhood effects',
    limit: 10,
} as unknown as WSItemSearchByTopicRequest;

const LONG_BODY = `${'word '.repeat(450)}tail`;

describe('handleItemSearchByTopicRequest derived text', () => {
    const items = new Map<number, any>();
    let db: any;

    beforeEach(() => {
        vi.clearAllMocks();
        items.clear();
        for (const id of [11, 12, 13]) items.set(id, { id, key: `KEY${id}`, libraryID: 1 });
        items.set(21, { id: 21, key: 'ATT21', libraryID: 1, parentID: 11 });
        // Moved to another item since it was indexed.
        items.set(23, { id: 23, key: 'ATT23', libraryID: 1, parentID: 99 });
        searchMock.mockResolvedValue([11, 12, 13].map((itemId, i) => ({ itemId, similarity: 0.9 - i / 10 })));
        db = {
            getEmbeddingSources: vi.fn(async () => new Map([
                [11, { source: 'attachment_text', sourceAttachmentId: 21 }],
                [12, { source: 'metadata', sourceAttachmentId: null }],
                [13, { source: 'attachment_text', sourceAttachmentId: 23 }],
            ])),
            getAttachmentEmbeddingTexts: vi.fn(async () => new Map([
                ['1/ATT21', { body: LONG_BODY, bodySource: 'opening', extractionSource: 'native', keywords: 'schools, poverty' }],
                ['1/ATT23', { body: 'Other text', bodySource: 'abstract', extractionSource: 'native', keywords: null }],
            ])),
        };
        (globalThis as any).Zotero = {
            Beaver: { db },
            Items: {
                getAsync: vi.fn(async (ids: number[]) => ids.map((id) => items.get(id) ?? false)),
                loadDataTypes: vi.fn(async () => undefined),
            },
        };
    });

    it('annotates rows embedded from attachment text with that text, capped', async () => {
        const response = await handleItemSearchByTopicRequest(request);
        const [first, second, third] = response.items;

        expect(first.embedding_source).toBe('attachment_text');
        expect(first.derived_text).toMatchObject({
            keywords: 'schools, poverty', source: 'opening', attachment_id: '1-ATT21',
        });
        expect(first.derived_text!.text.length).toBeLessThanOrEqual(2000);
        expect(first.derived_text!.text.length).toBeGreaterThan(1500);
        expect(second.embedding_source).toBeUndefined();
        expect(second.derived_text).toBeUndefined();
        expect(third).toMatchObject({ embedding_source: 'attachment_text' });
        expect(third.derived_text).toBeUndefined();
    });

    it('does not send text that fails the quality gate', async () => {
        db.getAttachmentEmbeddingTexts.mockResolvedValue(new Map([
            ['1/ATT21', { body: 'WELCOME 15. OUR STORE. LONG WHARF. TOTAL 25 -00.', bodySource: 'outline', extractionSource: 'ocr', keywords: null }],
        ]));
        const [first] = (await handleItemSearchByTopicRequest(request)).items;
        expect(first.embedding_source).toBe('attachment_text');
        expect(first.derived_text).toBeUndefined();
    });

    it('still returns results when the embedding sources cannot be read', async () => {
        db.getEmbeddingSources.mockRejectedValue(new Error('db closed'));
        const response = await handleItemSearchByTopicRequest(request);
        expect(response.items).toHaveLength(3);
        expect(response.items[0].embedding_source).toBeUndefined();
    });
});
