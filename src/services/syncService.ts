import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { UploadStatus } from './attachmentsService';
import { ItemData, AttachmentData } from '../../react/types/zotero';
import { ZoteroItemReference } from '../../react/types/zotero';
import { getZoteroUserIdentifier } from '../utils/zoteroIdentifier';

// Types that match the backend models
export interface SyncResponse {
    sync_id: string;
    library_id: number;
    total_items: number;
    sync_type: string;
}

export interface ItemBatchRequest {
    zotero_local_id: string;
    zotero_user_id: string | undefined;
    library_id: number;
    items: ItemData[];
    attachments: AttachmentData[];
    sync_type: string;
    zotero_sync_date: string;
    // sync options
    sync_id?: string;
    create_log?: boolean;
    update_log?: boolean;
    close_log?: boolean;
}

export interface ItemResult {
    item_id: string;
    library_id: number;
    zotero_key: string;
    metadata_hash: string;
    zotero_version: number;
    zotero_synced: boolean;
}

export interface AttachmentResult {
    attachment_id: string;
    library_id: number;
    zotero_key: string;
    file_hash: string;
    upload_status: UploadStatus;
    metadata_hash: string;
    zotero_version: number;
    zotero_synced: boolean;
}

export interface SyncItemsResponse {
    sync_id: string;
    sync_status: "in_progress" | "completed" | "failed";
    items: ItemResult[];
    attachments: AttachmentResult[];
}

export interface SyncCompleteResponse {
    status: string;
}

export interface LastSyncDateResponse {
    library_id: number;
    last_sync_date: string | null;
}

export interface LibrarySyncStateResponse {
    library_id: number;
    last_global_sync_date: string | null;
    last_local_sync_date: string | null;
}

export interface ItemDeleteRequest {
    library_id: number;
    zotero_keys: string[];
}

export interface DeleteZoteroDataResponse {
    items: ZoteroItemReference[];
    attachments: ZoteroItemReference[];
}

// Add these interfaces after the existing interfaces
export interface AttachmentFileUpdateRequest {
    library_id: number;
    zotero_key: string;
    file_hash: string;
}

export interface AttachmentUpdateResponse {
    enqueued: boolean;
}

export interface SyncStatusComparisonRequest {
    library_id: number;
    items: ItemSyncState[];
    attachments: ItemSyncState[];
    populate_local_db?: boolean;
}

// Add new minimal result interfaces for the consistency sync
export interface ItemSyncState {
    zotero_key: string;
    metadata_hash: string;
    zotero_version: number;
    zotero_synced: boolean;
}

export interface AttachmentSyncState extends ItemSyncState {
    file_hash: string;
    upload_status: UploadStatus;
}

export interface SyncStatusComparisonResponse {
    library_id: number;
    items_needing_sync: string[];      // Array of zotero_keys that need syncing
    attachments_needing_sync: string[]; // Array of zotero_keys that need syncing
    items_to_delete: string[];         // Array of zotero_keys that exist in backend but not in Zotero
    attachments_to_delete: string[];   // Array of zotero_keys that exist in backend but not in Zotero
    // Use minimal result objects to reduce response size
    items_up_to_date?: ItemSyncState[];
    attachments_up_to_date?: AttachmentSyncState[];
}

export interface SyncStateResponse {
    pull_required: "none" | "delta" | "full";
    backend_library_version: number;
}

export interface SyncDataResponse {
    library_id: number;
    items_state: ItemSyncState[];
    attachments_state: AttachmentSyncState[];
    has_more: boolean;
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
        const { userID, localUserKey } = getZoteroUserIdentifier();
        return this.post<SyncResponse>('/zotero/sync/start', {
            zotero_local_id: localUserKey,
            zotero_user_id: userID,
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
    async processItemsBatch(
        libraryId: number,
        items: ItemData[],
        attachments: AttachmentData[],
        syncType: 'initial' | 'incremental' | 'consistency' | 'verification',
        createLog: boolean,
        closeLog: boolean,
        syncId?: string,
    ): Promise<SyncItemsResponse> {
        const { userID, localUserKey } = getZoteroUserIdentifier();
        const payload: ItemBatchRequest = {
            zotero_local_id: localUserKey,
            zotero_user_id: userID,
            library_id: libraryId,
            items: items,
            attachments: attachments,
            sync_type: syncType,
            zotero_sync_date: Zotero.Date.dateToSQL(new Date(), true),
            create_log: createLog,
            close_log: closeLog
        };
        if (syncId) payload.sync_id = syncId;
        return this.post<SyncItemsResponse>('/zotero/sync/items', payload);
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
     * Gets the last sync state for a library from both global and local perspectives.
     * @param libraryId The Zotero library ID
     * @returns Promise with the library sync state response
     */
    async getLibrarySyncState(libraryId: number): Promise<LibrarySyncStateResponse> {
        const { localUserKey } = getZoteroUserIdentifier();
        const params = new URLSearchParams({
            library_id: String(libraryId),
            zotero_local_id: localUserKey,
        });
        return this.get<LibrarySyncStateResponse>(`/zotero/sync/library-state?${params.toString()}`);
    }

    /**
     * Gets the sync state for a library
     * @param libraryId The Zotero library ID
     * @param lastSyncZoteroVersion The last synced Zotero version (null for initial sync)
     * @returns Promise with the sync state response
     */
    async getSyncState(libraryId: number, lastSyncZoteroVersion: number | null = null): Promise<SyncStateResponse> {
        const params = new URLSearchParams({
            library_id: String(libraryId),
        });
        
        // Only add last_synced_version parameter if it's not null
        if (lastSyncZoteroVersion !== null) {
            params.append('last_synced_version', String(lastSyncZoteroVersion));
        }
        
        return this.get<SyncStateResponse>(`/zotero/sync/state?${params.toString()}`);
    }

    /**
     * Deletes items based on their Zotero keys and library
     * @param libraryId The Zotero library ID
     * @param zoteroKeys Array of Zotero keys to delete
     * @returns Promise with the deletion result
     */
    async deleteItems(libraryId: number, zoteroKeys: string[]): Promise<DeleteZoteroDataResponse> {
        return this.post<DeleteZoteroDataResponse>('/zotero/sync/items/delete', {
            library_id: libraryId,
            zotero_keys: zoteroKeys
        });
    }

    /**
     * Gets paginated sync data for a library
     * @param libraryId The Zotero library ID
     * @param updateSinceLibraryVersion Version to sync from (null for full sync)
     * @param page Page number (0-indexed)
     * @param pageSize Items per page (max 1000)
     * @returns Promise with paginated sync data response
     */
    async getSyncData(
        libraryId: number,
        updateSinceLibraryVersion: number | null = null,
        page: number = 0,
        pageSize: number = 500
    ): Promise<SyncDataResponse> {
        const params = new URLSearchParams({
            library_id: String(libraryId),
            page: String(page),
            page_size: String(pageSize),
        });
        if (updateSinceLibraryVersion !== null) {
            params.append('update_since_library_version', String(updateSinceLibraryVersion));
        }
        return this.get<SyncDataResponse>(`/zotero/sync/data?${params.toString()}`);
    }

    /**
     * Compares local metadata hashes with backend to identify items needing sync
     * @param libraryId The Zotero library ID
     * @param hashes Object containing arrays of items and attachments with their hashes
     * @returns Promise with comparison results indicating which items need syncing
     */
    async compareSyncState(
        libraryId: number, 
        items: ItemSyncState[],
        attachments: ItemSyncState[],
        populateLocalDB: boolean = false
    ): Promise<SyncStatusComparisonResponse> {
        const payload: SyncStatusComparisonRequest = {
            library_id: libraryId,
            items: items,
            attachments: attachments,
        };
        if (populateLocalDB) {
            payload.populate_local_db = true;
        }
        return this.post<SyncStatusComparisonResponse>('/zotero/sync/compare-sync-state', payload);
    }
}

// Export syncService
export const syncService = new SyncService(API_BASE_URL);