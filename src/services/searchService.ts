import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';

// Type for metadata search results that matches the ItemSearchResult from backend
export interface ItemSearchResult {
    id: string;                    // itemUUID
    library_id: number;
    zotero_key: string;
    item_type: string;
    deleted: boolean;
    title?: string;
    authors?: Array<Record<string, any>>;  // List of dict
    year?: number;
    publication?: string;
    reference?: string;
    date_added?: string;           // datetime
    date_modified?: string;        // datetime
    rank?: number;
}

// Type for search params to keep track of the various query parameters
export interface SearchParams {
    query: string;
    limit?: number;
    offset?: number;
    use_fuzzy?: boolean;
    similarity_threshold?: number;
}

/**
 * Search-specific API service that extends the base API service
 */
export class SearchService extends ApiService {
    /**
     * Creates a new SearchService instance
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
     * Searches metadata based on the provided query parameters
     * @param params Search parameters including query text and options
     * @returns Promise with an array of item search results
     */
    async searchMetadata(params: SearchParams): Promise<ItemSearchResult[]> {
        // Build query string from params
        const queryParams = new URLSearchParams();
        queryParams.append('query', params.query);
        
        if (params.limit !== undefined) {
            queryParams.append('limit', params.limit.toString());
        }
        
        if (params.offset !== undefined) {
            queryParams.append('offset', params.offset.toString());
        }
        
        if (params.use_fuzzy !== undefined) {
            queryParams.append('use_fuzzy', params.use_fuzzy.toString());
        }
        
        if (params.similarity_threshold !== undefined) {
            queryParams.append('similarity_threshold', params.similarity_threshold.toString());
        }
        
        // Use the full endpoint path: /search/metadata
        return this.get<ItemSearchResult[]>(`/search/metadata?${queryParams.toString()}`);
    }
    
    /**
     * Convenience method for simple metadata searches
     * @param query The search query text
     * @param limit Maximum number of results to return (default: 10)
     * @returns Promise with an array of item search results
     */
    async search(query: string, limit: number = 10): Promise<ItemSearchResult[]> {
        return this.searchMetadata({
            query,
            limit,
            offset: 0,
            use_fuzzy: true
        });
    }
}

// Export searchService
export const searchService = new SearchService(API_BASE_URL); 