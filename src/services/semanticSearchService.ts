import { BeaverDB, EmbeddingRecord } from './database';
import { embeddingsService } from './embeddingsService';
import { logger } from '../utils/logger';


/**
 * Result of a semantic similarity search
 */
export interface SearchResult {
    itemId: number;
    libraryId: number;
    zoteroKey: string;
    similarity: number;         // 0-1 normalized similarity score
}

/**
 * Options for semantic search
 */
export interface SearchOptions {
    topK?: number;              // Maximum number of results to return (default: 20)
    minSimilarity?: number;     // Minimum similarity threshold 0-1 (default: 0.3)
    libraryIds?: number[];      // Optional: filter to specific libraries
}

/**
 * Semantic search service for finding similar papers.
 * Reads embeddings directly from SQLite database and computes similarity.
 */
export class semanticSearchService {
    private db: BeaverDB;
    private dimensions: number;

    /**
     * Creates a new semanticSearchService instance
     * @param db The BeaverDB instance for accessing embeddings
     * @param dimensions Embedding dimensions (256 or 512, default: 512)
     */
    constructor(db: BeaverDB, dimensions: number = 512) {
        this.db = db;
        this.dimensions = dimensions;
    }

    /**
     * Search for papers similar to a query string.
     * @param query The search query text
     * @param options Search options (topK, minSimilarity, libraryIds)
     * @returns Array of search results sorted by similarity (highest first)
     */
    async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
        const { topK = 20, minSimilarity = 0.3, libraryIds } = options;

        if (!query || query.trim().length === 0) {
            return [];
        }

        // 1. Generate query embedding from backend API
        const queryEmbeddingResponse = await embeddingsService.generateQueryEmbedding(query);
        const queryEmbedding = new Int8Array(queryEmbeddingResponse.embedding);

        // 2. Load embeddings from database
        let embeddings: EmbeddingRecord[];
        if (libraryIds && libraryIds.length > 0) {
            embeddings = await this.db.getEmbeddingsByLibraries(libraryIds);
        } else {
            embeddings = await this.db.getAllEmbeddings();
        }

        if (embeddings.length === 0) {
            return [];
        }

        // 3. Compute similarities
        const results = this.computeSimilarities(queryEmbedding, embeddings, minSimilarity);

        // 4. Sort by similarity (descending) and return top K
        results.sort((a, b) => b.similarity - a.similarity);
        return results.slice(0, topK);
    }

    /**
     * Find papers similar to a given paper by its item ID.
     * @param itemId The Zotero item ID to find similar papers for
     * @param options Search options (topK, minSimilarity, libraryIds)
     * @returns Array of search results sorted by similarity (highest first)
     */
    async findSimilar(itemId: number, options: SearchOptions = {}): Promise<SearchResult[]> {
        const { topK = 20, minSimilarity = 0.3, libraryIds } = options;

        // 1. Get the embedding for the source item
        const sourceEmbedding = await this.db.getEmbedding(itemId);
        if (!sourceEmbedding) {
            logger(`findSimilar: No embedding found for item ${itemId}`, 2);
            return [];
        }

        const queryEmbedding = BeaverDB.blobToEmbedding(sourceEmbedding.embedding);

        // 2. Load embeddings from database
        let embeddings: EmbeddingRecord[];
        if (libraryIds && libraryIds.length > 0) {
            embeddings = await this.db.getEmbeddingsByLibraries(libraryIds);
        } else {
            embeddings = await this.db.getAllEmbeddings();
        }

        if (embeddings.length === 0) {
            return [];
        }

        // 3. Compute similarities (excluding the source item)
        const results = this.computeSimilarities(
            queryEmbedding, 
            embeddings.filter(e => e.item_id !== itemId), 
            minSimilarity
        );

        // 4. Sort by similarity (descending) and return top K
        results.sort((a, b) => b.similarity - a.similarity);
        return results.slice(0, topK);
    }

    /**
     * Compute similarity scores between a query embedding and a set of document embeddings.
     * @param queryEmbedding The query embedding as Int8Array
     * @param embeddings Array of embedding records from the database
     * @param minSimilarity Minimum similarity threshold
     * @returns Array of search results above the threshold
     */
    private computeSimilarities(
        queryEmbedding: Int8Array,
        embeddings: EmbeddingRecord[],
        minSimilarity: number
    ): SearchResult[] {
        const results: SearchResult[] = [];

        for (const record of embeddings) {
            const docEmbedding = BeaverDB.blobToEmbedding(record.embedding);
            
            // Ensure dimensions match
            if (docEmbedding.length !== queryEmbedding.length) {
                logger(`Dimension mismatch for item ${record.item_id}: expected ${queryEmbedding.length}, got ${docEmbedding.length}`, 2);
                continue;
            }

            const similarity = this.int8CosineSimilarity(queryEmbedding, docEmbedding);

            if (similarity >= minSimilarity) {
                results.push({
                    itemId: record.item_id,
                    libraryId: record.library_id,
                    zoteroKey: record.zotero_key,
                    similarity,
                });
            }
        }

        return results;
    }

    /**
     * Compute similarity between two int8 vectors using dot product.
     * Normalizes the result to [0, 1] range.
     * @param a First embedding
     * @param b Second embedding
     * @returns Normalized similarity score between 0 and 1
     */
    private int8DotProductSimilarity(a: Int8Array, b: Int8Array): number {
        if (a.length !== b.length) {
            throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
        }

        // Compute dot product
        let dotProduct = 0;
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
        }

        // Normalize to [0, 1] range
        // For int8 vectors, dot product range is:
        //   min: -128 * 127 * dimensions (if vectors are opposite)
        //   max: 127 * 127 * dimensions (if vectors are identical positive)
        const dimensions = a.length;
        const maxDotProduct = 127 * 127 * dimensions;
        const minDotProduct = -128 * 127 * dimensions;

        return (dotProduct - minDotProduct) / (maxDotProduct - minDotProduct);
    }

    /**
     * Alternative: Compute cosine similarity for int8 vectors.
     * More accurate for comparing normalized embeddings, slightly slower.
     * @param a First embedding
     * @param b Second embedding
     * @returns Cosine similarity normalized to [0, 1] range
     */
    private int8CosineSimilarity(a: Int8Array, b: Int8Array): number {
        if (a.length !== b.length) {
            throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
        }

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        normA = Math.sqrt(normA);
        normB = Math.sqrt(normB);

        if (normA === 0 || normB === 0) {
            return 0;
        }

        // Cosine similarity returns [-1, 1], normalize to [0, 1]
        const cosineSim = dotProduct / (normA * normB);
        return (cosineSim + 1) / 2;
    }

    /**
     * Get statistics about the embedding index.
     * @param libraryId Optional library ID to filter stats
     * @returns Object with count and dimension info
     */
    async getIndexStats(libraryId?: number): Promise<{
        totalEmbeddings: number;
        dimensions: number;
    }> {
        const count = await this.db.getEmbeddingCount(libraryId);
        return {
            totalEmbeddings: count,
            dimensions: this.dimensions,
        };
    }
}
