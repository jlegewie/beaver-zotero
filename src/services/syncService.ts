import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';

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


export interface BatchResult {
    sync_id: string;
    sync_status: "in_progress" | "completed" | "failed";
    processed: number;
    success: number;
    failed: number;
    failed_keys: string[];
}

export interface SyncCompleteResponse {
    status: string;
}

// --- Item Types ---

/** Fields included in the Item metadata file_hash calculation. */
export interface ItemDataHashedFields {
    zotero_key: string;
    item_type: string;
    library_id: number;
    title?: string;
    authors?: any;
    year?: number;
    publication?: string;
    abstract?: string;
    reference?: string;
    identifiers?: any;
    tags?: any[];
    deleted: boolean;
}

/** Full Item data */
export interface ItemData extends ItemDataHashedFields {
    date_added?: string;
    date_modified?: string;
    // Hash of the fields defined in ItemDataHashedFields
    item_metadata_hash: string;
}

// --- Attachment & File Types ---

export interface FileData {
    filename: string;
    file_hash: string;
    size: number;
    mime_type: string;
    // content?: string;
    storage_path?: string;
}

/** Fields included in the Attachment metadata file_hash calculation. */
export interface AttachmentDataHashedFields {
    library_id: number;
    zotero_key: string;
    parent_key: string | null;
    is_primary: boolean | null;
    deleted: boolean;
    title: string;
}

export interface AttachmentData {
    // attachments table fields
    library_id: number;
    zotero_key: string;
    parent_key: string | null;
    is_primary: boolean | null;
    deleted: boolean;
    title: string;
    date_added: string;
    date_modified: string;
    // file table data
    file_hash?: string;
    size?: number;
    mime_type?: string;
    filename?: string;
    // Hash of the fields defined in AttachmentDataHashedFields
    attachment_metadata_hash: string;
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

// Add these interfaces after the existing interfaces
export interface AttachmentFileUpdateRequest {
    library_id: number;
    zotero_key: string;
    file_hash: string;
}

export interface AttachmentUpdateResponse {
    enqueued: boolean;
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
    ): Promise<BatchResult> {
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

    /**
     * Forces update of an attachment's file hash
     * @param libraryId The Zotero library ID
     * @param zoteroKey The Zotero key of the attachment
     * @param fileHash The new file hash
     * @returns Promise with the update response indicating if the hash was enqueued
     */
    async forceAttachmentFileUpdate(libraryId: number, zoteroKey: string, fileHash: string): Promise<AttachmentUpdateResponse> {
        return this.post<AttachmentUpdateResponse>('/zotero/sync/items/attachment-update', {
            library_id: libraryId,
            zotero_key: zoteroKey,
            file_hash: fileHash
        });
    }
}

// Export syncService
export const syncService = new SyncService(API_BASE_URL);