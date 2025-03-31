/**
 * FileUploader.ts
 *
 * A uploader that processes Zotero file attachments in batches using a queue. 
 * It pulls pending items from the server, uploads them concurrently (up to MAX_CONCURRENT), 
 * handles retries, and updates progress based on server status. 
 */

import PQueue from 'p-queue';
import { queueService, UploadQueueItem, PopQueueResponse, QueueStatus } from "./queueService";
import { SyncStatus } from 'react/atoms/ui';


export interface UploadProgressInfo {
  status: SyncStatus;
  current: number;
  total: number;
}

/**
 * Manages file uploads from a server-side queue of pending uploads.
 */
export class FileUploader {
    private isRunning: boolean = false;
    private uploadQueue!: PQueue; // Will be initialized on start
    private readonly MAX_CONCURRENT: number = 3;

    /**
     * Holds the last known queue status. 
     * This may be used to display progress if the queue fails to update later.
     */
    private lastStatus: QueueStatus = {
        pending: 0,
        in_progress: 0,
        completed: 0,
        failed: 0,
        total: 0
    };

    /**
     * Callback for upload status and progress updates
     */
    private statusCallback?: (info: UploadProgressInfo) => void;

    /**
     * Legacy progress callback for backward compatibility
     */
    private progressCallback?: (completed: number, total: number) => void;

    /**
     * Sets a comprehensive callback for status and progress updates
     */
    public setStatusCallback(callback: (info: UploadProgressInfo) => void): void {
        this.statusCallback = callback;
    }

    /**
     * Sets a callback for upload progress notifications (legacy method)
     */
    public setProgressCallback(callback: (completed: number, total: number) => void): void {
        this.progressCallback = callback;
    }

    /**
     * Updates status and progress through callbacks
     */
    private reportStatus(status: SyncStatus, current: number = 0, total: number = 0): void {
        if (this.statusCallback) {
            this.statusCallback({ status, current, total });
        }
        
        // For backward compatibility
        if (this.progressCallback && status === 'in_progress') {
            this.progressCallback(current, total);
        }
    }

    /**
     * Starts the file uploader if it's not already running.
     * Initializes a concurrency queue and continuously processes queue items 
     * until no more items or until stopped.
     */
    public start(): void {
        if (this.isRunning) {
            console.log('[Beaver File Uploader] Already running. Start call ignored.');
            return;
        }
        this.isRunning = true;
        console.log('[Beaver File Uploader] Starting file uploader');

        // Report starting status
        this.reportStatus('in_progress', 0, 0);

        // Initialize the p-queue with desired concurrency
        this.uploadQueue = new PQueue({ concurrency: this.MAX_CONCURRENT });

        // Begin processing in the background
        this.runQueue()
            .catch(error => {
                console.error('[Beaver File Uploader] Error in runQueue:', error);
                this.reportStatus('failed');
            });
    }

    /**
     * Stops the file uploader gracefully. 
     * No new items will be fetched, but in-flight uploads will be allowed to finish.
     */
    public async stop(): Promise<void> {
        if (!this.isRunning) {
            return;
        }

        this.isRunning = false;
        console.log('[Beaver File Uploader] Stopping file uploader');

        // Wait for all queued tasks to finish, if any
        try {
            await this.uploadQueue.onIdle();
            // Update status to completed if we stopped cleanly
            this.reportStatus('completed');
        } catch (error) {
            console.error('[Beaver File Uploader] Error while waiting for queue to idle:', error);
            this.reportStatus('failed');
        }
    }

    /**
     * Main loop that continuously pops items from the server and processes them until
     * no more items remain or the uploader is stopped.
     */
    private async runQueue(): Promise<void> {
        let consecutiveErrors = 0;
        const MAX_CONSECUTIVE_ERRORS = 5;
        let backoffTime = 1000; // Start with 1 second backoff

        while (this.isRunning) {
            try {
                // If we've had too many consecutive errors, add a longer backoff
                if (consecutiveErrors > 0) {
                    console.log(`[Beaver File Uploader] Backing off for ${backoffTime}ms after ${consecutiveErrors} consecutive errors`);
                    await new Promise(resolve => setTimeout(resolve, backoffTime));
                    // Exponential backoff with max of 1 minute
                    backoffTime = Math.min(backoffTime * 2, 60000);
                }

                // Fetch up to MAX_CONCURRENT items from the server, along with the updated status
                const response: PopQueueResponse = await queueService.popQueueItems(this.MAX_CONCURRENT);
                const items = response.items;
                const status = response.status;
                console.log(`[Beaver File Uploader] Popped ${items.length} items from the queue. Status: ${JSON.stringify(status)}`);

                // Update progress immediately after popping items
                this.updateProgress(status);

                // If no items returned or pending is zero, exit the loop
                if (items.length === 0 && status.pending === 0 && status.in_progress === 0) {
                    this.reportStatus('completed', status.completed + status.failed, status.total);
                    break;
                }

                // Reset error counter on successful queue pop
                consecutiveErrors = 0;
                backoffTime = 1000;

                // Add each upload task to the concurrency queue
                for (const item of items) {
                    this.uploadQueue.add(() => this.uploadFile(item));
                }

                // Wait for these uploads to finish before popping the next batch
                await this.uploadQueue.onIdle();
            } catch (error) {
                console.error('[Beaver File Uploader] runQueue encountered an error:', error);
                
                // Report error status
                this.reportStatus('failed');
                
                // Increment consecutive error counter
                consecutiveErrors++;
                
                // If we've hit max consecutive errors, take a break
                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    console.warn(`[Beaver File Uploader] Hit ${MAX_CONSECUTIVE_ERRORS} consecutive errors, pausing for recovery`);
                    await new Promise(resolve => setTimeout(resolve, 60000)); // 1 minute timeout
                    consecutiveErrors = 0; // Reset counter after pause
                }
                
                // Continue the loop instead of breaking - we'll try again with backoff
                continue;
            }
        }

        // No more items or we've stopped. Mark as not running.
        this.isRunning = false;
        console.log('[Beaver File Uploader] Finished processing queue.');
    }

    /**
     * Uploads a single file item. 
     * On success, the item is marked completed; on failure, we may reset or fail permanently.
     */
    private async uploadFile(item: UploadQueueItem): Promise<void> {
        try {
            console.log(`[Beaver File Uploader] Uploading ${item.type} file for ${item.attachment_key}`);

            // Retrieve file path from Zotero
            const attachment = await Zotero.Items.getByLibraryAndKeyAsync(item.library_id, item.attachment_key);
            if (!attachment) {
                console.error(`[Beaver File Uploader] Attachment not found: ${item.attachment_key}`);
                await this.handlePermanentFailure(item, "Attachment not found in Zotero");
                return;
            }

            let filePath: string | null = null;
            if (item.type === 'attachment') {
                filePath = await attachment.getFilePathAsync() || null;
            } else if (item.type === 'fulltext') {
                // @ts-ignore FullText exists
                const cacheFile = Zotero.FullText.getItemCacheFile(attachment);
                filePath = cacheFile.path;
            }
            if (!filePath) {
                console.error(`[Beaver File Uploader] File path for ${item.type} not found for attachment: ${item.attachment_key}`);
                await this.handlePermanentFailure(item, "File path not found");
                return;
            }

            // Read file content
            let fileArrayBuffer;
            try {
                fileArrayBuffer = await IOUtils.read(filePath);
            } catch (readError) {
                console.error(`[Beaver File Uploader] Error reading file: ${item.attachment_key}`, readError);
                await this.handlePermanentFailure(item, "Error reading file");
                return;
            }
            
            // const mimeType = Zotero.MIME.getMIMETypeFromFile(filePath);
            const mimeType = item.type === 'attachment' ? attachment.attachmentContentType : 'text/plain';
            const blob = new Blob([fileArrayBuffer], { type: mimeType });

            // Perform the file upload with retry for network issues
            let uploadSuccess = false;
            let attempt = 0;
            const maxUploadAttempts = 3;
            
            while (!uploadSuccess && attempt < maxUploadAttempts) {
                attempt++;
                try {
                    const response = await fetch(item.upload_url, {
                        method: 'PUT',
                        body: blob,
                        headers: { 'Content-Type': mimeType }
                    });

                    if (!response.ok) {
                        if (response.status >= 500) {
                            // Server error - may be temporary
                            console.warn(`[Beaver File Uploader] Server error ${response.status} on attempt ${attempt}, will retry`);
                            await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Increasing backoff
                            continue;
                        } else {
                            // Client error - likely permanent
                            throw new Error(`Upload failed with status ${response.status}`);
                        }
                    }
                    
                    // Mark upload as completed on the server
                    await queueService.completeUpload(item);
                    console.log(`[Beaver File Uploader] Successfully uploaded file for attachment ${item.attachment_key}`);
                    uploadSuccess = true;
                } catch (uploadError: unknown) {
                    if (
                        uploadError instanceof TypeError || 
                        (
                            typeof uploadError === 'object' &&
                            uploadError !== null &&
                            'message' in uploadError &&
                            typeof uploadError.message === 'string' &&
                            (
                                uploadError.message.includes('network') ||
                                uploadError.message.includes('connection')
                            )
                        )
                    ) {
                        // Network error, retry with backoff
                        console.warn(`[Beaver File Uploader] Network error on attempt ${attempt}, will retry`, uploadError);
                        await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Increasing backoff
                    } else {
                        // Other errors, rethrow to be handled by outer catch
                        throw uploadError;
                    }
                }
            }
            
            // If we exhausted retries without success
            if (!uploadSuccess) {
                throw new Error(`Failed to upload after ${maxUploadAttempts} attempts`);
            }

        } catch (error: unknown) {
            console.error(`[Beaver File Uploader] Error uploading file for attachment ${item.attachment_key}:`, error);

            // If attempts are too high, treat as permanently failed
            if (item.attempts >= 3) {
                await this.handlePermanentFailure(item, error instanceof Error ? error.message : "Max attempts reached");
            } else {
                // Otherwise, reset the item for retry later
                try {
                    await queueService.resetUpload(item.id);
                } catch (resetError) {
                    console.error('[Beaver File Uploader] Error resetting failed upload:', resetError);
                }
            }
        }
    }
    
    /**
     * Handles permanent failures by marking items as failed in the queue
     */
    private async handlePermanentFailure(item: UploadQueueItem, reason: string): Promise<void> {
        console.error(`[Beaver File Uploader] Permanent failure for ${item.attachment_key}: ${reason}`);
        try {
            // Mark the item as failed
            await queueService.markUploadAsFailed(item.id, item.file_id);
        } catch (failError) {
            console.error('[Beaver File Uploader] Error marking item as failed:', failError);
        }
    }

    /**
     * Updates the internal status cache and triggers the optional callbacks
     */
    private updateProgress(status: QueueStatus): void {
        this.lastStatus = status;
        
        // Calculate completion stats
        const completedCount = status.completed + status.failed;
        const total = status.total;
        
        // Report progress
        this.reportStatus('in_progress', completedCount, total);
    }
}

/**
 * Exports a singleton instance for the file uploader.
 */
export const fileUploader = new FileUploader();
