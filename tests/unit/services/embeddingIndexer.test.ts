import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/embeddingsService', () => ({
    embeddingsService: {
        generateEmbeddingsWithRetry: vi.fn(),
    },
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    getClientDateModifiedAsISOString: vi.fn(),
    getClientDateModifiedBatch: vi.fn(),
}));

import { EmbeddingIndexer } from '../../../src/services/embeddingIndexer';
import { getClientDateModifiedBatch } from '../../../src/utils/zoteroUtils';

describe('EmbeddingIndexer - incomplete batch recovery', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.Items = {
            getAsync: vi.fn(),
            loadDataTypes: vi.fn().mockResolvedValue(undefined),
        };
    });

    it('queues only items that passed the content-length gate after a pre-API failure', async () => {
        const longItem = {
            id: 11,
            libraryID: 7,
            key: 'LONG0001',
            version: 3,
            isRegularItem: () => true,
            getField: (field: string) => {
                if (field === 'title') return 'A long enough title';
                if (field === 'abstractNote')
                    return 'This abstract is long enough to exceed the minimum content threshold.';
                return '';
            },
        };
        const shortItem = {
            id: 12,
            libraryID: 7,
            key: 'SHORT001',
            version: 3,
            isRegularItem: () => true,
            getField: (field: string) => {
                if (field === 'title') return 'Tiny';
                if (field === 'abstractNote') return '';
                return '';
            },
        };

        (globalThis as any).Zotero.Items.getAsync.mockResolvedValue([
            longItem,
            shortItem,
        ]);
        vi.mocked(getClientDateModifiedBatch).mockResolvedValue(
            new Map([
                [11, '2026-01-01T00:00:00.000Z'],
                [12, '2026-01-01T00:00:00.000Z'],
            ]),
        );

        const db = {
            getContentHashes: vi
                .fn()
                .mockRejectedValue(new Error('hash lookup failed')),
            recordFailedEmbeddingsBatch: vi.fn().mockResolvedValue(undefined),
        };

        const indexer = new EmbeddingIndexer(db as any);
        const result = await indexer.indexItemIdsBatch([11, 12], {
            skipUnchanged: true,
            batchSize: 2,
        });

        expect(result.incomplete).toBe(true);
        expect(result.skipped).toBe(1);
        expect(db.recordFailedEmbeddingsBatch).toHaveBeenCalledWith(
            [{ itemId: 11, libraryId: 7 }],
            'hash lookup failed',
            { incrementExisting: false },
        );
    });
});
