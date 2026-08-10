import { describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/transport/clients/embeddingsService', () => ({
    embeddingsService: {
        generateQueryEmbeddingWithRetry: vi.fn(),
    },
}));

vi.mock('@beaver/agent-core/transport/apiService', () => ({
    ApiService: vi.fn(),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    safeIsInTrash: vi.fn(() => false),
}));

import { embeddingsService } from '@beaver/agent-core/transport/clients/embeddingsService';
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

    it('returns no results for an explicit empty item scope', async () => {
        const db = {
            getAllEmbeddings: vi.fn(),
            getEmbeddingsByLibraries: vi.fn(),
            getEmbeddingsByItemIds: vi.fn(),
        };
        const service = new semanticSearchService(db as any);

        await expect(service.search('social capital', { itemIds: [] })).resolves.toEqual([]);

        expect(db.getAllEmbeddings).not.toHaveBeenCalled();
        expect(db.getEmbeddingsByLibraries).not.toHaveBeenCalled();
        expect(db.getEmbeddingsByItemIds).not.toHaveBeenCalled();
    });

    it('loads only the allowlisted items when searching with an item scope', async () => {
        const db = {
            getAllEmbeddings: vi.fn(),
            getEmbeddingsByLibraries: vi.fn(),
            getEmbeddingsByItemIds: vi.fn(async () => []),
        };
        const service = new semanticSearchService(db as any);
        vi.mocked(embeddingsService.generateQueryEmbeddingWithRetry).mockResolvedValue({
            embedding: [1, 2, 3],
        } as any);

        await expect(
            service.search('social capital', { itemIds: [7, 8], libraryIds: [1] })
        ).resolves.toEqual([]);

        expect(db.getEmbeddingsByItemIds).toHaveBeenCalledWith([7, 8], [1]);
        expect(db.getAllEmbeddings).not.toHaveBeenCalled();
        expect(db.getEmbeddingsByLibraries).not.toHaveBeenCalled();
    });

    it('returns no similar items for an explicit empty item scope', async () => {
        const db = {
            getEmbedding: vi.fn(),
            getAllEmbeddings: vi.fn(),
            getEmbeddingsByLibraries: vi.fn(),
            getEmbeddingsByItemIds: vi.fn(),
        };
        const service = new semanticSearchService(db as any);

        await expect(service.findSimilar(123, { itemIds: [] })).resolves.toEqual([]);

        expect(db.getEmbedding).not.toHaveBeenCalled();
        expect(db.getAllEmbeddings).not.toHaveBeenCalled();
        expect(db.getEmbeddingsByLibraries).not.toHaveBeenCalled();
        expect(db.getEmbeddingsByItemIds).not.toHaveBeenCalled();
    });

    it('loads only the allowlisted items when finding similar items', async () => {
        const db = {
            getEmbedding: vi.fn(async () => ({
                item_id: 123,
                library_id: 1,
                zotero_key: 'ABC',
                embedding: new Uint8Array([1, 2, 3]),
            })),
            getAllEmbeddings: vi.fn(),
            getEmbeddingsByLibraries: vi.fn(),
            getEmbeddingsByItemIds: vi.fn(async () => []),
        };
        const service = new semanticSearchService(db as any);

        await expect(
            service.findSimilar(123, { itemIds: [7, 8], libraryIds: [1] })
        ).resolves.toEqual([]);

        expect(db.getEmbeddingsByItemIds).toHaveBeenCalledWith([7, 8], [1]);
        expect(db.getAllEmbeddings).not.toHaveBeenCalled();
        expect(db.getEmbeddingsByLibraries).not.toHaveBeenCalled();
    });
});
