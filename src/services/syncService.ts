import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';

// Types that match the backend models
export interface Library {
    id: string;
    user_id: string;
    library_id: number;
    sync_enabled: boolean;
    name: string;
    type: string;
    last_sync_time: string | null;
    last_sync_version: number | null;
}

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
    library: Library;
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
     * Initiates an initial sync for a library
     * @param libraryId The Zotero library ID
     * @param name The library name
     * @param type The library type (e.g., "user", "group")
     * @param totalItems Total number of items to sync
     * @returns Promise with the sync response
     */
    async startInitialSync(libraryId: number, name: string, type: string, totalItems: number): Promise<SyncResponse> {
        return this.post<SyncResponse>('/zotero/sync/initial', {
            library_id: libraryId,
            name,
            type,
            total_items: totalItems
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
     * @param newVersion The new library version (optional)
     * @returns Promise with the complete sync response
     */
    async completeSync(syncId: string, newVersion?: number): Promise<SyncCompleteResponse> {
        let endpoint = `/zotero/sync/${syncId}/complete`;
        if (newVersion !== undefined) {
            endpoint += `?new_version=${newVersion}`;
        }
        return this.post<SyncCompleteResponse>(endpoint, {});
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