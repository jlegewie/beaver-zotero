import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';

// Types that match the backend models
export interface SyncResponse {
    sync_id: string;
    library_id: number;
    total_items: number;
    sync_type: string;
}

export interface BatchResult {
    processed: number;
    success: number;
    failed: number;
}

export interface SyncCompleteResponse {
    status: string;
}

export interface ItemData {
    zotero_key: string;
    item_type: string;
    library_id: number;
    title?: string;
    authors?: any;
    year?: number;
    abstract?: string;
    reference?: string;
    identifiers?: any;
    tags?: any[];
    date_added?: string;
    date_modified?: string;
    version: number;
    deleted: boolean;
    item_json?: any;
}

/**
 * Sync-specific API service that extends the base API service
 */
export class SyncService extends ApiService {
    /**
     * Creates a new SyncService instance
     * @param backendUrl The base URL of the backend API
     */
    constructor(backendUrl: string) {
        super(backendUrl);
    }

    /**
     * Initiates a sync for a library
     * @param libraryId The Zotero library ID
     * @param totalItems Total number of items to sync
     * @returns Promise with the sync response
     */
    async startSync(libraryId: number, sync_type: string, totalItems: number, syncDate: string): Promise<SyncResponse> {
        return this.post<SyncResponse>('/zotero/sync/start', {
            library_id: libraryId,
            sync_type: sync_type,
            total_items: totalItems,
            zotero_sync_date: syncDate
        });
    }

    /**
     * Processes a batch of items for syncing
     * @param syncId The sync operation ID
     * @param libraryId The Zotero library ID
     * @param items Array of items to process
     * @returns Promise with the batch processing result
     */
    async processItemsBatch(syncId: string, libraryId: number, items: ItemData[]): Promise<BatchResult> {
        return this.post<BatchResult>('/zotero/sync/items', {
            sync_id: syncId,
            library_id: libraryId,
            items
        });
    }

    /**
     * Completes a sync operation
     * @param syncId The sync operation ID
     * @returns Promise with the complete sync response
     */
    async completeSync(syncId: string): Promise<SyncCompleteResponse> {
        return this.post<SyncCompleteResponse>(`/zotero/sync/${syncId}/complete`, {});
    }

    /**
     * Gets active sync operations
     * @returns Promise with array of active syncs
     */
    async getActiveSyncs(): Promise<any[]> {
        return this.get<any[]>('/zotero/sync/active');
    }
}

// Export syncService
export const syncService = new SyncService(API_BASE_URL);