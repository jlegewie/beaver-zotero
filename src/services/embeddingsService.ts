import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';

/**
 * Request to generate embeddings for multiple texts
 */
interface GenerateEmbeddingsRequest {
    texts: string[];
    item_ids: number[];
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
}

/**
 * Request to generate a query embedding
 */
interface GenerateQueryRequest {
    query: string;
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
     * @param texts Array of paper texts to embed (max 500 items)
     * @param itemIds Corresponding Zotero item IDs
     * @returns Promise with embeddings and metadata
     */
    async generateEmbeddings(
        texts: string[],
        itemIds: number[]
    ): Promise<GenerateEmbeddingsResponse> {
        if (texts.length !== itemIds.length) {
            throw new Error('texts and item_ids must have the same length');
        }
        
        if (texts.length === 0) {
            throw new Error('texts must not be empty');
        }
        
        if (texts.length > 500) {
            throw new Error('Batch size cannot exceed 500 items');
        }

        return this.post<GenerateEmbeddingsResponse>('/api/v1/embeddings/generate', {
            texts,
            item_ids: itemIds
        } as GenerateEmbeddingsRequest);
    }

    /**
     * Generate int8 quantized embedding for a single search query
     * @param query Search query text
     * @returns Promise with query embedding (always 512 dimensions)
     */
    async generateQueryEmbedding(
        query: string
    ): Promise<QueryEmbeddingResponse> {
        if (!query || query.trim().length === 0) {
            throw new Error('Query cannot be empty');
        }

        return this.post<QueryEmbeddingResponse>('/api/v1/embeddings/generate-query', {
            query
        } as GenerateQueryRequest);
    }

    /**
     * Batch process texts in chunks to respect API limits
     * @param texts Array of paper texts to embed
     * @param itemIds Corresponding Zotero item IDs
     * @param batchSize Maximum texts per batch (default: 500)
     * @returns Promise with all embeddings and combined metadata
     */
    async generateEmbeddingsBatch(
        texts: string[],
        itemIds: number[],
        batchSize: number = 500
    ): Promise<GenerateEmbeddingsResponse> {
        if (texts.length !== itemIds.length) {
            throw new Error('texts and item_ids must have the same length');
        }

        const allEmbeddings: EmbeddingResult[] = [];
        let model = '';

        // Process in batches
        for (let i = 0; i < texts.length; i += batchSize) {
            const batchTexts = texts.slice(i, i + batchSize);
            const batchItemIds = itemIds.slice(i, i + batchSize);

            const response = await this.generateEmbeddings(
                batchTexts,
                batchItemIds
            );

            allEmbeddings.push(...response.embeddings);
            model = response.model;
        }

        return {
            embeddings: allEmbeddings,
            model
        };
    }
}

// Export embeddingsService singleton
export const embeddingsService = new EmbeddingsService(API_BASE_URL);

