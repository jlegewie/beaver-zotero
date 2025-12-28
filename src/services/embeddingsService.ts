import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';

/**
 * Request to generate embeddings for multiple texts
 */
interface GenerateEmbeddingsRequest {
    texts: string[];
    item_ids: number[];
    dimensions?: number;
}

/**
 * Individual embedding result
 */
interface EmbeddingResult {
    item_id: number;
    embedding: number[];
    dimensions: number;
}

/**
 * Response from generate embeddings endpoint
 */
interface GenerateEmbeddingsResponse {
    embeddings: EmbeddingResult[];
    model: string;
    total_tokens: number;
    total_cost: number;
}

/**
 * Request to generate a query embedding
 */
interface GenerateQueryRequest {
    query: string;
    dimensions?: number;
}

/**
 * Response from generate query embedding endpoint
 */
interface QueryEmbeddingResponse {
    item_id: number;
    embedding: number[];
    dimensions: number;
}

/**
 * Embeddings API service for generating int8 quantized embeddings
 */
export class EmbeddingsService extends ApiService {
    /**
     * Creates a new EmbeddingsService instance
     * @param backendUrl The base URL of the backend API
     */
    constructor(backendUrl: string) {
        super(backendUrl);
    }

    /**
     * Gets the base URL of this service
     * @returns The base URL
     */
    getBaseUrl(): string {
        return this.baseUrl;
    }

    /**
     * Generate int8 quantized embeddings for multiple paper texts
     * @param texts Array of paper texts to embed
     * @param itemIds Corresponding Zotero item IDs
     * @param dimensions Embedding dimensions: 256 or 512 (default: 512)
     * @returns Promise with embeddings and metadata
     */
    async generateEmbeddings(
        texts: string[],
        itemIds: number[],
        dimensions: number = 512
    ): Promise<GenerateEmbeddingsResponse> {
        if (texts.length !== itemIds.length) {
            throw new Error('texts and item_ids must have the same length');
        }
        
        if (texts.length === 0) {
            throw new Error('texts must not be empty');
        }
        
        if (dimensions !== 256 && dimensions !== 512) {
            throw new Error('dimensions must be 256 or 512');
        }

        return this.post<GenerateEmbeddingsResponse>('/api/v1/embeddings/generate', {
            texts,
            item_ids: itemIds,
            dimensions
        } as GenerateEmbeddingsRequest);
    }

    /**
     * Generate int8 quantized embedding for a single search query
     * @param query Search query text
     * @param dimensions Embedding dimensions: 256 or 512 (default: 512)
     * @returns Promise with query embedding
     */
    async generateQueryEmbedding(
        query: string,
        dimensions: number = 512
    ): Promise<QueryEmbeddingResponse> {
        if (!query || query.trim().length === 0) {
            throw new Error('Query cannot be empty');
        }
        
        if (dimensions !== 256 && dimensions !== 512) {
            throw new Error('dimensions must be 256 or 512');
        }

        return this.post<QueryEmbeddingResponse>('/api/v1/embeddings/generate-query', {
            query,
            dimensions
        } as GenerateQueryRequest);
    }

    /**
     * Convert int8 array to Int8Array for storage
     * @param embedding Array of int8 values [-128 to 127]
     * @returns Int8Array suitable for SQLite BLOB storage
     */
    static toInt8Array(embedding: number[]): Int8Array {
        return new Int8Array(embedding);
    }

    /**
     * Convert Int8Array back to regular array
     * @param int8Array Int8Array from SQLite BLOB
     * @returns Array of int8 values
     */
    static fromInt8Array(int8Array: Int8Array): number[] {
        return Array.from(int8Array);
    }

    /**
     * Compute int8 dot product similarity between two embeddings
     * @param a First embedding as Int8Array
     * @param b Second embedding as Int8Array
     * @returns Similarity score normalized to [0, 1] range
     */
    static computeSimilarity(a: Int8Array, b: Int8Array): number {
        if (a.length !== b.length) {
            throw new Error('Embeddings must have the same dimensions');
        }

        let dotProduct = 0;
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
        }

        // Normalize to [0, 1] range
        const dimensions = a.length;
        const maxDotProduct = 127 * 127 * dimensions;
        const minDotProduct = -128 * 127 * dimensions;
        return (dotProduct - minDotProduct) / (maxDotProduct - minDotProduct);
    }

    /**
     * Batch process texts in chunks to respect API limits
     * @param texts Array of paper texts to embed
     * @param itemIds Corresponding Zotero item IDs
     * @param dimensions Embedding dimensions
     * @param batchSize Maximum texts per batch (default: 100)
     * @returns Promise with all embeddings and combined metadata
     */
    async generateEmbeddingsBatch(
        texts: string[],
        itemIds: number[],
        dimensions: number = 512,
        batchSize: number = 100
    ): Promise<GenerateEmbeddingsResponse> {
        if (texts.length !== itemIds.length) {
            throw new Error('texts and item_ids must have the same length');
        }

        const allEmbeddings: EmbeddingResult[] = [];
        let totalTokens = 0;
        let totalCost = 0;
        let model = '';

        // Process in batches
        for (let i = 0; i < texts.length; i += batchSize) {
            const batchTexts = texts.slice(i, i + batchSize);
            const batchItemIds = itemIds.slice(i, i + batchSize);

            const response = await this.generateEmbeddings(
                batchTexts,
                batchItemIds,
                dimensions
            );

            allEmbeddings.push(...response.embeddings);
            totalTokens += response.total_tokens;
            totalCost += response.total_cost;
            model = response.model;
        }

        return {
            embeddings: allEmbeddings,
            model,
            total_tokens: totalTokens,
            total_cost: totalCost
        };
    }
}

// Export embeddingsService singleton
export const embeddingsService = new EmbeddingsService(API_BASE_URL);

