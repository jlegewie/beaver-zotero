import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { FileHashReference } from '../../react/types/zotero';
import { UploadQueueInput } from './database';
import { userAtom } from '../../react/atoms/auth';
import { store } from '../../react';
import { fileUploader } from './FileUploader';
import { UploadStatus } from './attachmentsService';
import { ItemData, AttachmentData } from '../../react/types/zotero';
import { logger } from '../utils/logger';
import { ZoteroItemReference } from '../../react/types/zotero';

// Types that match the backend models
export interface SyncResponse {
    sync_id: string;
    library_id: number;
    total_items: number;
    sync_type: string;
}

export interface ItemBatchRequest {
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
}

export interface AttachmentResult {
    attachment_id: string;
    library_id: number;
    zotero_key: string;
    file_hash: string;
    upload_status: UploadStatus;
    metadata_hash: string;
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

export interface HashComparisonRequest {
    library_id: number;
    items: Array<{
        zotero_key: string;
        metadata_hash: string;
    }>;
    attachments: Array<{
        zotero_key: string;
        metadata_hash: string;
    }>;
}

export interface HashComparisonResponse {
    library_id: number;
    items_needing_sync: string[];      // Array of zotero_keys that need syncing
    attachments_needing_sync: string[]; // Array of zotero_keys that need syncing
    items_to_delete: string[];         // Array of zotero_keys that exist in backend but not in Zotero
    attachments_to_delete: string[];   // Array of zotero_keys that exist in backend but not in Zotero
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
    async processItemsBatch(
        libraryId: number,
        items: ItemData[],
        attachments: AttachmentData[],
        syncType: string,
        createLog: boolean,
        closeLog: boolean,
        syncId?: string,
    ): Promise<SyncItemsResponse> {
        const payload: ItemBatchRequest = {
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
     * Compares local metadata hashes with backend to identify items needing sync
     * @param libraryId The Zotero library ID
     * @param hashes Object containing arrays of items and attachments with their hashes
     * @returns Promise with comparison results indicating which items need syncing
     */
    async compareHashes(
        libraryId: number, 
        hashes: {
            items: Array<{zotero_key: string, metadata_hash: string}>,
            attachments: Array<{zotero_key: string, metadata_hash: string}>
        }
    ): Promise<HashComparisonResponse> {
        return this.post<HashComparisonResponse>('/zotero/sync/compare-hashes', {
            library_id: libraryId,
            ...hashes
        });
    }
}

// Export syncService
export const syncService = new SyncService(API_BASE_URL);