import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { UploadStatus } from './attachmentsService';
import { ItemData, DeleteData, AttachmentDataWithMimeType } from '../../react/types/zotero';
import { ZoteroItemReference } from '../../react/types/zotero';
import { getZoteroUserIdentifier } from '../utils/zoteroUtils';
import { SyncMethod, SyncType } from '../../react/atoms/sync';

// Types that match the backend models
export interface ItemBatchRequest {
    session_id: string; // UUID
    sync_type: SyncType;
    sync_method: SyncMethod;
    zotero_local_id: string;
    zotero_user_id: string | undefined;
    library_id: number;
    items: ItemData[];
    attachments: AttachmentDataWithMimeType[];
    deletions: DeleteData[];
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
    session_id: string;
    total_upserts: number;
    total_deletions: number;
    pending_uploads: number;
    library_version: number;
    library_date_modified: string;
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
    date_modified: string;
}

export interface AttachmentSyncState extends ItemSyncState {
    file_hash: string;
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
    last_sync_method: SyncMethod;
    last_sync_version: number;
    last_sync_date_modified: string;
    last_sync_timestamp: string;
    last_sync_zotero_local_id: string;
}

export interface SyncDataResponse {
    library_id: number;
    items_state: ItemSyncState[];
    attachments_state: AttachmentSyncState[];
    has_more: boolean;
}

export interface ScheduleLibraryDeletionRequest {
    library_ids: number[];
}

export interface DeleteLibraryMessage {
    msg_id: number;
    id: string; // UUID as a string
    user_id: string;
    library_id: number;
    requested_at: string; // datetime will be a string
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
     * Processes a batch of items for syncing
     * @param syncId The sync operation ID
     * @param syncType The type of sync operation
     * @param libraryId The Zotero library ID
     * @param items Array of items to process
     * @param attachments Array of attachments to process
     * @param keysToDelete Array of keys to delete
     * @returns Promise with the batch processing result
     */
    async processItemsBatch(
        sessionId: string,
        zoteroUserId: string | undefined,
        localUserKey: string,
        syncType: SyncType,
        syncMethod: SyncMethod,
        libraryId: number,
        items: ItemData[],
        attachments: AttachmentDataWithMimeType[],
        deletions: DeleteData[],
    ): Promise<SyncItemsResponse> {
        const payload: ItemBatchRequest = {
            session_id: sessionId,
            sync_type: syncType,
            sync_method: syncMethod,
            zotero_local_id: localUserKey,
            zotero_user_id: zoteroUserId,
            library_id: libraryId,
            items: items,
            attachments: attachments,
            deletions: deletions,
        };
        return this.post<SyncItemsResponse>('/api/v1/sync/items', payload);
    }

    /**
     * Gets the sync state for a library
     * @param libraryId The Zotero library ID
     * @param lastSyncZoteroVersion The last synced Zotero version (null for initial sync)
     * @returns Promise with the sync state response
     */
    async getSyncState(libraryId: number, syncMethod: SyncMethod): Promise<SyncStateResponse | null> {
        const params = new URLSearchParams({
            library_id: String(libraryId),
            sync_method: syncMethod,
        });        
        return this.get<SyncStateResponse | null>(`/api/v1/sync/state?${params.toString()}`);
    }

    /**
     * Deletes items based on their Zotero keys and library
     * @param libraryId The Zotero library ID
     * @param zoteroKeys Array of Zotero keys to delete
     * @returns Promise with the deletion result
     */
    async deleteItems(libraryId: number, zoteroKeys: string[]): Promise<DeleteZoteroDataResponse> {
        return this.post<DeleteZoteroDataResponse>('/api/v1/sync/items/delete', {
            library_id: libraryId,
            zotero_keys: zoteroKeys
        });
    }

    /**
     * Schedules the deletion of one or more libraries.
     * @param libraryIds An array of Zotero library IDs to delete.
     * @returns A promise that resolves with an array of deletion messages.
     */
    async scheduleLibraryDeletion(libraryIds: number[]): Promise<DeleteLibraryMessage[]> {
        const payload: ScheduleLibraryDeletionRequest = {
            library_ids: libraryIds,
        };
        return this.post<DeleteLibraryMessage[]>('/api/v1/sync/libraries/schedule-deletion', payload);
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
        sinceLibraryVersion: number | null = null,
        toLibraryVersion: number | null = null,
        page: number = 0,
        pageSize: number = 500
    ): Promise<SyncDataResponse> {
        const params = new URLSearchParams({
            library_id: String(libraryId),
            page: String(page),
            page_size: String(pageSize),
        });
        if (sinceLibraryVersion !== null) {
            params.append('since_version', String(sinceLibraryVersion));
        }
        if (toLibraryVersion !== null) {
            params.append('to_version', String(toLibraryVersion));
        }
        return this.get<SyncDataResponse>(`/api/v1/sync/data?${params.toString()}`);
    }

}

// Export syncService
export const syncService = new SyncService(API_BASE_URL);