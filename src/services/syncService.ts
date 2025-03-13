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

export interface LastSyncDateResponse {
    library_id: number;
    last_sync_date: string | null;
}

export interface ItemDeleteRequest {
    library_id: number;
    zotero_keys: string[];
}

export interface DeleteResult {
    requested: number;
    deleted: number;
    failed: number;
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
     * @param libraryId The Zotero library ID
     * @param items Array of items to process
     * @param syncId The sync operation ID (optional)
     * @returns Promise with the batch processing result
     */
    async processItemsBatch(libraryId: number, items: ItemData[], syncType: string, syncId?: string): Promise<BatchResult> {
        const payload: { library_id: number; items: ItemData[]; sync_type: string; sync_id?: string, zotero_sync_date: string } =
            { library_id: libraryId, items, sync_type: syncType, zotero_sync_date: Zotero.Date.dateToSQL(new Date(), true) };
        if (syncId) payload.sync_id = syncId;
        return this.post<BatchResult>('/zotero/sync/items', payload);
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

    /**
     * Gets the last sync date for a library
     * @param libraryId The Zotero library ID
     * @returns Promise with the last sync date response
     */
    async getLastSyncDate(libraryId: number): Promise<LastSyncDateResponse> {
        return this.get<LastSyncDateResponse>(`/zotero/sync/library/${libraryId}/last-sync-date`);
    }

    /**
     * Deletes items based on their Zotero keys and library
     * @param libraryId The Zotero library ID
     * @param zoteroKeys Array of Zotero keys to delete
     * @returns Promise with the deletion result
     */
    async deleteItems(libraryId: number, zoteroKeys: string[]): Promise<DeleteResult> {
        return this.post<DeleteResult>('/zotero/sync/items/delete', {
            library_id: libraryId,
            zotero_keys: zoteroKeys
        });
    }
}

// Export syncService
export const syncService = new SyncService(API_BASE_URL);