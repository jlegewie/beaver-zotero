import { ApiService } from './apiService';
import { ApiError, ServerError } from '../../react/types/apiErrors';
import { logger } from '../utils/logger';
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
 * Stats for indexing completion report
 */
export interface IndexingCompleteStats {
    items_indexed: number;
    items_failed: number;
    items_skipped: number;
    items_deleted: number;
    libraries_count: number;
    duration_ms: number;
    is_force_reindex: boolean;
}

/**
 * Default retry configuration
 */
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;

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
     * Check if an error is transient (retryable).
     * Transient errors include network issues, server errors (5xx), and rate limits (429).
     * Client errors (4xx except 429) are not retryable.
     */
    private isTransientError(error: unknown): boolean {
        // Network errors (fetch failures)
        if (error instanceof TypeError && error.message.includes('fetch')) {
            return true;
        }
        
        // Server errors (5xx)
        if (error instanceof ServerError) {
            return true;
        }
        
        // API errors - check status code
        if (error instanceof ApiError) {
            // Rate limit (429) and server errors (5xx) are retryable
            return error.status === 429 || error.status >= 500;
        }
        
        // Unknown errors - assume transient (network issues, etc.)
        return true;
    }

    /**
     * Sleep for a specified duration
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
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
     * Generate embeddings with automatic retry for transient failures.
     * Uses exponential backoff: 1s, 2s, 4s delays between retries.
     * @param texts Array of paper texts to embed (max 500 items)
     * @param itemIds Corresponding Zotero item IDs
     * @param maxRetries Maximum number of retry attempts (default: 3)
     * @returns Promise with embeddings and metadata
     * @throws The last error if all retries are exhausted
     */
    async generateEmbeddingsWithRetry(
        texts: string[],
        itemIds: number[],
        maxRetries: number = DEFAULT_MAX_RETRIES
    ): Promise<GenerateEmbeddingsResponse> {
        let lastError: Error | null = null;
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await this.generateEmbeddings(texts, itemIds);
            } catch (error) {
                lastError = error as Error;
                
                // Don't retry non-transient errors
                if (!this.isTransientError(error)) {
                    logger(`EmbeddingsService: Non-transient error, not retrying: ${lastError.message}`, 2);
                    throw error;
                }
                
                // Don't retry if we've exhausted all attempts
                if (attempt >= maxRetries) {
                    logger(`EmbeddingsService: All ${maxRetries + 1} attempts failed: ${lastError.message}`, 1);
                    break;
                }
                
                // Exponential backoff: 1s, 2s, 4s
                const delay = DEFAULT_BASE_DELAY_MS * Math.pow(2, attempt);
                logger(`EmbeddingsService: Attempt ${attempt + 1} failed, retrying in ${delay}ms: ${lastError.message}`, 2);
                await this.sleep(delay);
            }
        }
        
        throw lastError;
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
     * Generate query embedding with automatic retry for transient failures.
     * @param query Search query text
     * @param maxRetries Maximum number of retry attempts (default: 3)
     * @returns Promise with query embedding
     */
    async generateQueryEmbeddingWithRetry(
        query: string,
        maxRetries: number = DEFAULT_MAX_RETRIES
    ): Promise<QueryEmbeddingResponse> {
        let lastError: Error | null = null;
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await this.generateQueryEmbedding(query);
            } catch (error) {
                lastError = error as Error;
                
                if (!this.isTransientError(error)) {
                    throw error;
                }
                
                if (attempt >= maxRetries) {
                    break;
                }
                
                const delay = DEFAULT_BASE_DELAY_MS * Math.pow(2, attempt);
                logger(`EmbeddingsService: Query attempt ${attempt + 1} failed, retrying in ${delay}ms`, 2);
                await this.sleep(delay);
            }
        }
        
        throw lastError;
    }

    /**
     * Report indexing completion stats to backend for analytics.
     * Fire-and-forget - errors are logged but don't affect the user.
     * @param stats Indexing completion statistics
     */
    async reportIndexingComplete(stats: IndexingCompleteStats): Promise<void> {
        try {
            await this.post<{ success: boolean }>('/api/v1/embeddings/indexing-complete', stats);
            logger(`EmbeddingsService: Reported indexing completion - ${stats.items_indexed} indexed, ${stats.items_failed} failed`, 3);
        } catch (error) {
            // Log but don't throw - this is non-critical analytics
            logger(`EmbeddingsService: Failed to report indexing completion: ${(error as Error).message}`, 2);
        }
    }

    /**
     * Batch process texts in chunks to respect API limits.
     * Uses retry logic for each batch.
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

        // Process in batches with retry
        for (let i = 0; i < texts.length; i += batchSize) {
            const batchTexts = texts.slice(i, i + batchSize);
            const batchItemIds = itemIds.slice(i, i + batchSize);

            const response = await this.generateEmbeddingsWithRetry(
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

