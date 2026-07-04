import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/embeddingsService', () => ({
    embeddingsService: {
        generateQueryEmbeddingWithRetry: vi.fn(),
    },
}));

vi.mock('../../../src/services/apiService', () => ({
    ApiService: vi.fn(),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    safeIsInTrash: vi.fn(() => false),
}));

import { semanticSearchService } from '../../../src/services/semanticSearchService';

describe('semanticSearchService', () => {
    it('returns no results for an explicit empty library scope', async () => {
        const db = {
            getAllEmbeddings: vi.fn(),
            getEmbeddingsByLibraries: vi.fn(),
        };
        const service = new semanticSearchService(db as any);

        await expect(service.search('social capital', { libraryIds: [] })).resolves.toEqual([]);

        expect(db.getAllEmbeddings).not.toHaveBeenCalled();
        expect(db.getEmbeddingsByLibraries).not.toHaveBeenCalled();
    });

    it('returns no similar items for an explicit empty library scope', async () => {
        const db = {
            getEmbedding: vi.fn(),
            getAllEmbeddings: vi.fn(),
            getEmbeddingsByLibraries: vi.fn(),
        };
        const service = new semanticSearchService(db as any);

        await expect(service.findSimilar(123, { libraryIds: [] })).resolves.toEqual([]);

        expect(db.getEmbedding).not.toHaveBeenCalled();
        expect(db.getAllEmbeddings).not.toHaveBeenCalled();
        expect(db.getEmbeddingsByLibraries).not.toHaveBeenCalled();
    });
});
