import { queueService, UploadQueueItem } from "./queueService";

/**
 * Interface for queue status
 */
export interface QueueStatus {
    pending: number;
    in_progress: number;
    completed: number;
    failed: number;
    total: number;
}

/**
 * Class that manages file uploads from the upload queue
 */
export class FileUploader {
    private isRunning: boolean = false;
    private pollInterval: NodeJS.Timeout | null = null;
    private readonly MAX_CONCURRENT: number = 3;
    private activeUploads: number = 0;
    private onProgressCallback?: (completed: number, total: number) => void;
    private lastStatus: QueueStatus = { pending: 0, in_progress: 0, completed: 0, failed: 0, total: 0 };
    
    /**
     * Set a callback for upload progress updates
     * @param callback Function to call with progress updates
     */
    public setProgressCallback(callback: (completed: number, total: number) => void): void {
        this.onProgressCallback = callback;
    }
    
    /**
     * Start the file uploader
     * @param pollIntervalMs Poll interval in milliseconds (default: 0 for no polling)
     */
    public start(pollIntervalMs: number = 0): void {
        if (this.isRunning) {
            console.log('[Beaver File Uploader] File uploader already running');
            return;
        }
        
        this.isRunning = true;
        console.log('[Beaver File Uploader] Starting file uploader');
        
        // Start immediately
        this.processQueue();
        
        // Poll at interval if specified
        if (pollIntervalMs > 0) {
            this.pollInterval = setInterval(() => {
                this.processQueue();
            }, pollIntervalMs);
        }
    }
    
    /**
     * Stop the file uploader
     */
    public stop(): void {
        if (!this.isRunning) return;
        
        this.isRunning = false;
        console.log('[Beaver File Uploader] Stopping file uploader');
        
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }
    
    /**
     * Get the current upload queue status
     * @returns Promise resolving to queue status
     */
    public async getStatus(): Promise<QueueStatus> {
        try {
            const status = await queueService.getQueueStatus();
            this.lastStatus = status;
            return status;
        } catch (error) {
            console.error('[Beaver] Error getting queue status:', error);
            return this.lastStatus;
        }
    }
    
    /**
     * Reset stalled uploads
     * @param minutesThreshold Minutes threshold after which to consider uploads stalled
     * @returns Promise resolving to number of reset items
     */
    // public async resetStalledUploads(minutesThreshold: number = 30): Promise<number> {
    //     try {
    //         return await queueService.resetStalledUploads(minutesThreshold);
    //     } catch (error) {
    //         console.error('[Beaver] Error resetting stalled uploads:', error);
    //         return 0;
    //     }
    // }
    
    /**
     * Process the upload queue
     */
    private async processQueue(recursive: boolean = false): Promise<void> {
        if (!this.isRunning || this.activeUploads >= this.MAX_CONCURRENT) {
            console.log('[Beaver File Uploader] File uploader not running or at max concurrent uploads');
            return;
        }
        
        try {
            // Only update progress when not called recursively to avoid excessive API calls
            if (!recursive) {
                const status = await this.getStatus();
                this.updateProgress(status);
                
                // If no pending items, exit early
                if (status.pending === 0) {
                    return;
                }
            }
            
            // Calculate how many uploads we can process
            const available = this.MAX_CONCURRENT - this.activeUploads;
            if (available <= 0) {
                console.log('[Beaver File Uploader] No uploads available');
                return;
            }
            
            // Get items to process
            const response = await queueService.popQueueItems(available);
            const items = response.items;
            
            if (items.length === 0) {
                return; // No more items to process
            }
            
            console.log(`[Beaver] Starting upload for ${items.length} files`);
            
            // Track when all current batch uploads complete
            const uploadPromises = items.map(item => this.uploadFile(item));
            
            // When all uploads from this batch complete, check for more items
            Promise.all(uploadPromises).then(() => {
                // If there are still pending items, continue processing
                if (response.total_pending > 0) {
                    this.processQueue(true); // Call recursively with flag to avoid extra status check
                }
            });
            
        } catch (error) {
            console.error('[Beaver] Error processing queue:', error);
        }
    }
    
    /**
     * Upload a file from the queue
     * @param item Queue item to process
     */
    private async uploadFile(item: UploadQueueItem): Promise<void> {
        if (!this.isRunning) return;
        
        this.activeUploads++;
        
        try {
            console.log(`[Beaver] Uploading file for attachment ${item.attachment_key}`);
            
            // Get file path from Zotero
            const attachment = await Zotero.Items.getByLibraryAndKeyAsync(item.library_id, item.attachment_key);
            if (!attachment) {
                throw new Error(`Attachment not found: ${item.attachment_key}`);
            }
            
            const filePath = await attachment.getFilePathAsync();
            if (!filePath) {
                throw new Error(`File path not found for attachment: ${item.attachment_key}`);
            }
            
            // Read file content
            const fileArrayBuffer = await IOUtils.read(filePath);
                        
            // Create a blob from the ArrayBuffer
            const blob = new Blob([fileArrayBuffer], { type: 'application/pdf' }); // Set correct MIME type for PDFs
                        
            // Upload using the pre-signed URL
            const response = await fetch(item.upload_url, {
                method: 'PUT',
                body: blob,
                headers: {
                    'Content-Type': 'application/pdf' // Match the Blob type
                }
            });
            
            if (!response.ok) {
                throw new Error(`Upload failed with status ${response.status}`);
            }
                        
            // Mark as completed
            await queueService.completeUpload(item.id, item.file_id, item.storage_path);
            
            console.log(`[Beaver] Successfully uploaded file for attachment ${item.attachment_key}`);
            
        } catch (error) {
            console.error(`[Beaver] Error uploading file for attachment ${item.attachment_key}:`, error);
            
            // Mark as failed if too many attempts
            if (item.attempts >= 3) {
                console.error(`[Beaver] Max upload attempts reached for ${item.attachment_key}`);
                // We don't need to update status as the backend will handle it
            } else {
                // Reset to pending for retry
                try {
                    await queueService.resetUpload(item.id);
                } catch (resetError) {
                    console.error('[Beaver] Error resetting failed upload:', resetError);
                }
            }
        } finally {
            this.activeUploads--;
            this.processQueue(); // Continue processing queue
        }
    }
    
    /**
     * Update progress callback
     * @param status Current queue status
     */
    private updateProgress(status: QueueStatus): void {
        if (this.onProgressCallback) {
            const completed = status.completed + status.failed;
            const total = status.total;
            this.onProgressCallback(completed, total);
        }
    }
}

// Create singleton instance
export const fileUploader = new FileUploader();