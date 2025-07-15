import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';

// Types that match the backend models
export interface UploadQueueItem {
    file_hash: string;
    library_id: number;
    zotero_key: string;
    read_count: number;
    enqueued_at: string; // ISO date string
    storage_path: string;
    signed_upload_url: string;
}

export interface ReadUploadQueueResponse {
    items: UploadQueueItem[];
    count: number;
}

/**
 * Files API service for managing upload queues and file operations
 */
export class FilesService extends ApiService {
    /**
     * Creates a new FilesService instance
     * @param backendUrl The base URL of the backend API
     */
    constructor(backendUrl: string) {
        super(backendUrl);
    }

    /**
     * Read items from the upload queue and return with signed upload URLs for processing
     * Items returned will be marked as "in progress" and hidden from other consumers
     * for the specified sleep_seconds duration
     * @param sleepSeconds How long to hide items from other consumers (1-3600 seconds, default: 30)
     * @param limit Number of items to return (1-100, default: 1)
     * @returns Promise with upload queue items and count
     */
    async readUploadQueue(
        sleepSeconds: number = 30,
        limit: number = 1
    ): Promise<ReadUploadQueueResponse> {
        const params = new URLSearchParams({
            sleep_seconds: String(sleepSeconds),
            limit: String(limit),
        });
        return this.get<ReadUploadQueueResponse>(`/api/v1/files/upload-queue?${params.toString()}`);
    }

    /**
     * Delete a queue item after processing (successful or failed)
     * @param fileHash The file hash of the item to delete
     * @returns Promise with operation result
     */
    async deleteQueueItem(fileHash: string): Promise<void> {
        this.delete(`/api/v1/files/upload-queue/${fileHash}`);
    }
}

// Export filesService instance
export const filesService = new FilesService(API_BASE_URL); 