import { ApiService } from "./apiService";
import API_BASE_URL from '../utils/getAPIBaseURL';

export interface PopQueueResponse {
    items: UploadQueueItem[];
    status: QueueStatus;
}

export interface QueueStatus {
    pending: number;
    in_progress: number;
    completed: number;
    failed: number;
    total: number;
}

/**
 * Interface for queue item from the server
 */
export interface UploadQueueItem {
    id: string;
    file_id: string;
    library_id: number;
    attachment_key: string;
    upload_url: string;
    storage_path: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    attempts: number;
    created_at: string;
    updated_at: string;
    last_attempt_at?: string;
}

/**
 * Sync-specific API service that extends the base API service
 */
export class QueueService extends ApiService {

    /**
     * Pop items from the upload queue
     * @param limit Maximum number of items to pop
     * @returns Promise with items and total pending count
     */
    async popQueueItems(limit: number = 5): Promise<PopQueueResponse> {
        return this.post<PopQueueResponse>('/queue/pop', { limit });
    }

    /**
     * Mark an upload as complete
     * @param queueId ID of the queue item
     * @param storagePath Path where the file was stored
     * @returns Promise resolving to success indicator
     */
    async completeUpload(queueId: string, fileId: string, storagePath: string): Promise<boolean> {
        return this.post<boolean>('/queue/complete', {
            queue_id: queueId,
            file_id: fileId,
            storage_path: storagePath
        });
    }

    /**
     * Reset a failed upload
     * @param queueId ID of the queue item
     * @returns Promise resolving to success indicator
     */
    async resetUpload(queueId: string): Promise<boolean> {
        return this.post<boolean>('/queue/reset', { queue_id: queueId });
    }

    /**
     * Mark an upload as failed
     * @param queueId ID of the queue item
     * @returns Promise resolving to success indicator
     */
    async markUploadAsFailed(queueId: string): Promise<boolean> {
        return this.post<boolean>('/queue/fail', { queue_id: queueId });
    }

    /**
     * Get the status of the upload queue
     * @returns Promise resolving to queue status
     */
    async getQueueStatus(): Promise<QueueStatus> {
        return this.get<QueueStatus>('/queue/status');
    }

    /**
     * Reset stalled uploads
     * @param minutes Minutes after which to consider in-progress items stalled
     * @returns Promise resolving to number of reset items
     */
    // async resetStalledUploads(minutes: number = 30): Promise<number> {
    //     return this.post<number>('/queue/reset-stalled', { minutes });
    // }
}

// Export queueService
export const queueService = new QueueService(API_BASE_URL);