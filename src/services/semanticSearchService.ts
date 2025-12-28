import { BeaverDB, EmbeddingRecord } from './database';
import { embeddingsService } from './embeddingsService';
import { logger } from '../utils/logger';
import { safeIsInTrash } from '../utils/zoteroUtils';


/**
 * Result of a semantic similarity search
 */
export interface SearchResult {
    itemId: number;
    libraryId: number;
    zoteroKey: string;
    similarity: number;         // Raw cosine similarity [-1, 1]
}

/**
 * Options for semantic search
 */
export interface SearchOptions {
    topK?: number;              // Maximum number of results to return (default: 20)
    minSimilarity?: number;     // Minimum cosine similarity threshold (default: 0.4)
                                // Interpretation: 0.7+ very similar, 0.5-0.7 related, 
                                // 0.3-0.5 weak, <0.3 noise
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
     * Uses retry with exponential backoff for transient failures.
     * Filters out items that are in the trash.
     * @param query The search query text
     * @param options Search options (topK, minSimilarity, libraryIds)
     * @returns Array of search results sorted by similarity (highest first)
     */
    async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
        const { topK = 20, minSimilarity = 0.4, libraryIds } = options;

        if (!query || query.trim().length === 0) {
            return [];
        }

        // 1. Generate query embedding from backend API (with retry)
        const queryEmbeddingResponse = await embeddingsService.generateQueryEmbeddingWithRetry(query);
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

        // 4. Sort by similarity (descending)
        results.sort((a, b) => b.similarity - a.similarity);

        // 5. Filter out trashed items and return top K
        // Fetch extra candidates to account for filtering, then slice to topK
        const candidates = results.slice(0, topK * 2);
        const filtered = await this.filterOutTrashedItems(candidates);
        return filtered.slice(0, topK);
    }

    /**
     * Find papers similar to a given paper by its item ID.
     * Filters out items that are in the trash.
     * @param itemId The Zotero item ID to find similar papers for
     * @param options Search options (topK, minSimilarity, libraryIds)
     * @returns Array of search results sorted by similarity (highest first)
     */
    async findSimilar(itemId: number, options: SearchOptions = {}): Promise<SearchResult[]> {
        const { topK = 20, minSimilarity = 0.4, libraryIds } = options;

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

        // 4. Sort by similarity (descending)
        results.sort((a, b) => b.similarity - a.similarity);

        // 5. Filter out trashed items and return top K
        // Fetch extra candidates to account for filtering, then slice to topK
        const candidates = results.slice(0, topK * 2);
        const filtered = await this.filterOutTrashedItems(candidates);
        return filtered.slice(0, topK);
    }

    /**
     * Filter out items that are in the trash from search results.
     * This ensures trashed items don't appear in search results even if their
     * embeddings haven't been cleaned up yet.
     * 
     * Note: isInTrash() requires primaryData to be loaded, and for child items
     * (attachments, notes, annotations), it also checks the parent's trash status,
     * so parent data must be loaded too.
     * 
     * @param results Array of search results to filter
     * @returns Filtered array with trashed items removed
     */
    private async filterOutTrashedItems(results: SearchResult[]): Promise<SearchResult[]> {
        if (results.length === 0) {
            return [];
        }

        const itemIds = results.map(r => r.itemId);
        const items = await Zotero.Items.getAsync(itemIds);

        // Filter out null items
        const validItems = items.filter((item): item is Zotero.Item => item !== null);
        if (validItems.length === 0) {
            return [];
        }

        // Load primaryData for all items
        await Zotero.Items.loadDataTypes(validItems, ["primaryData"]);

        // Load parent items for child items (needed for isInTrash() to check parent trash status)
        const parentIds = [...new Set(
            validItems
                .filter(item => item.parentID)
                .map(item => item.parentID as number)
        )];
        if (parentIds.length > 0) {
            const parentItems = await Zotero.Items.getAsync(parentIds);
            const validParents = parentItems.filter((item): item is Zotero.Item => item !== null);
            if (validParents.length > 0) {
                await Zotero.Items.loadDataTypes(validParents, ["primaryData"]);
            }
        }

        // Build a set of valid (non-trashed) item IDs using safeIsInTrash
        const validIds = new Set<number>();
        for (const item of validItems) {
            const trashState = safeIsInTrash(item);
            // Only include if we're certain it's NOT in trash
            // If trashState is null (unable to determine), exclude to be safe
            if (trashState === false) {
                validIds.add(item.id);
            }
        }

        const filtered = results.filter(r => validIds.has(r.itemId));
        
        if (filtered.length < results.length) {
            logger(`filterOutTrashedItems: Filtered out ${results.length - filtered.length} trashed items from search results`, 4);
        }

        return filtered;
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
     * Compute cosine similarity for int8 vectors.
     * Returns raw cosine similarity in [-1, 1] range.
     * Interpretation:
     *   1.0 = identical direction
     *   0.7+ = very similar
     *   0.5-0.7 = related
     *   0.3-0.5 = weakly related
     *   <0.3 = likely noise
     *   0 = orthogonal (unrelated)
     *   -1 = opposite
     * @param a First embedding
     * @param b Second embedding
     * @returns Raw cosine similarity [-1, 1]
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

        return dotProduct / (normA * normB);
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
