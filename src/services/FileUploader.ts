/**
 * FileUploader.ts
 *
 * A uploader that processes Zotero file attachments in batches using a queue. 
 * It pulls pending items from the server, uploads them concurrently (up to MAX_CONCURRENT), 
 * handles retries, and updates progress based on server status. 
 */

import PQueue from 'p-queue';
import { queueService, UploadQueueItem, PopQueueResponse, QueueStatus } from "./queueService";
import { SyncStatus } from '../../react/atoms/ui';
import { getPDFPageCount } from '../../react/utils/pdfUtils';
import { logger } from '../utils/logger';
import { store } from '../../react/index';
import { isAuthenticatedAtom } from '../../react/atoms/auth';

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

    // Track progress locally to avoid flashing zeroes
    private localProgress = {
        completed: 0,
        total: 0
    };
    
    /**
     * Updates status with stable progress tracking that won't reset to zero
     */
    private reportProgress(status: QueueStatus): void {
        // Update our high water mark for total items
        if (status.total > this.localProgress.total) {
            this.localProgress.total = status.total;
        }
        
        // Calculate completed count from server status
        const serverCompleted = status.completed + status.failed;
        
        // Only increase the completed count, never decrease it
        // This prevents progress from going backward
        if (serverCompleted > this.localProgress.completed) {
            this.localProgress.completed = serverCompleted;
        }
        
        // Report progress using our stable local tracking
        this.reportStatus(
            'in_progress', 
            this.localProgress.completed, 
            this.localProgress.total
        );
    }

    /**
     * Starts the file uploader if it's not already running.
     * Initializes a concurrency queue and continuously processes queue items 
     * until no more items or until stopped.
     */
    public start(): void {
        if (this.isRunning) {
            logger('Beaver File Uploader: Already running. Start call ignored.', 4);
            return;
        }
        this.isRunning = true;
        logger('Beaver File Uploader: Starting file uploader', 3);

        // Report starting status
        this.reportStatus('in_progress', 0, 0);

        // Initialize the p-queue with desired concurrency
        this.uploadQueue = new PQueue({ concurrency: this.MAX_CONCURRENT });

        // Begin processing in the background
        this.runQueue()
            .catch(error => {
                logger('Beaver File Uploader: Error in runQueue: ' + error.message, 1);
                Zotero.logError(error);
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
        logger('Beaver File Uploader: Stopping file uploader', 3);

        // Wait for all queued tasks to finish, if any
        try {
            await this.uploadQueue.onIdle();
            // Update status to completed if we stopped cleanly
            this.reportStatus('completed', this.localProgress.total, this.localProgress.total);
        } catch (error: any) {
            logger('Beaver File Uploader: Error while waiting for queue to idle: ' + error.message, 1);
            Zotero.logError(error);
            this.reportStatus('failed');
        }
    }

    /**
     * Main loop that continuously pops items from the server and processes them until
     * no more items remain or the uploader is stopped.
     */
    private async runQueue(): Promise<void> {
        // Reset progress tracking at the start of a queue run
        this.localProgress = {
            completed: 0,
            total: 0
        };
        
        // Idle backoff handling
        const MAX_CONSECUTIVE_IDLE = 10;
        const IDLE_BACKOFF_TIME = 2500;
        let consecutiveIdle = 0;
        let idleBackoffTime = IDLE_BACKOFF_TIME;

        // Error backoff handling
        const MAX_CONSECUTIVE_ERRORS = 5;
        const ERROR_BACKOFF_TIME = 1000;
        let consecutiveErrors = 0;
        let errorBackoffTime = ERROR_BACKOFF_TIME;

        while (this.isRunning) {
            try {
                // check authentication status
                const isAuthenticated = store.get(isAuthenticatedAtom);
                if (!isAuthenticated) {
                    logger('Beaver File Uploader: Not authenticated. Stopping.', 3);
                    this.isRunning = false;
                    break;
                }
                // If we've had too many consecutive errors, add a longer backoff
                if (consecutiveErrors > 0) {
                    logger(`Beaver File Uploader: Backing off for ${errorBackoffTime}ms after ${consecutiveErrors} consecutive errors`, 3);
                    await new Promise(resolve => setTimeout(resolve, errorBackoffTime));
                    // Exponential backoff with max of 1 minute
                    errorBackoffTime = Math.min(errorBackoffTime * 2, 60000);
                }

                // Fetch up to MAX_CONCURRENT items from the server, along with the updated status
                const response: PopQueueResponse = await queueService.popQueueItems(this.MAX_CONCURRENT);
                const items = response.items;
                const status = response.status;
                logger(`Beaver File Uploader: Popped ${items.length} items from the queue. Status: ${JSON.stringify(status)}`, 3);

                // Update progress with the received status
                this.reportProgress(status);

                // Add a short delay when no items are available but processing is ongoing
                if (items.length === 0 && (status.pending > 0 || status.in_progress > 0)) {
                    logger(`Beaver File Uploader: No items to process, but there are pending or in-progress items. Waiting 1 second before checking again.`, 3);
                    // Wait a bit before checking again to avoid hammering the server
                    await new Promise(resolve => setTimeout(resolve, idleBackoffTime));
                    // Exponential backoff with max of 1 minute
                    idleBackoffTime = Math.min(idleBackoffTime * 2, 60000);
                    consecutiveIdle++;
                    if (consecutiveIdle >= MAX_CONSECUTIVE_IDLE) {
                        logger(`Beaver File Uploader: Hit ${MAX_CONSECUTIVE_IDLE} consecutive idle`, 2);
                        this.isRunning = false;
                        break;
                    }
                    continue;
                }

                // If no items and no pending/in-progress items, we're done
                if (items.length === 0 && status.pending === 0 && status.in_progress === 0) {
                    // Set final completed status with our tracked total
                    this.reportStatus('completed', this.localProgress.total, this.localProgress.total);
                    break;
                }

                // Reset idle and error counters on successful queue pop
                consecutiveErrors = 0;
                errorBackoffTime = ERROR_BACKOFF_TIME;
                consecutiveIdle = 0;
                idleBackoffTime = IDLE_BACKOFF_TIME;

                // Add each upload task to the concurrency queue
                for (const item of items) {
                    this.uploadQueue.add(() => this.uploadFile(item));
                }

                // Wait for these uploads to finish before popping the next batch
                await this.uploadQueue.onIdle();
            } catch (error: any) {
                logger('Beaver File Uploader: runQueue encountered an error: ' + error.message, 1);
                Zotero.logError(error);
                
                // Report error status
                this.reportStatus('failed');
                
                // Increment consecutive error counter
                consecutiveErrors++;
                
                // If we've hit max consecutive errors, take a break
                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    logger(`Beaver File Uploader: Hit ${MAX_CONSECUTIVE_ERRORS} consecutive errors, pausing for recovery`, 2);
                    await new Promise(resolve => setTimeout(resolve, 60000)); // 1 minute timeout
                    consecutiveErrors = 0; // Reset counter after pause
                }
                
                // Continue the loop instead of breaking - we'll try again with backoff
                continue;
            }
        }

        // No more items or we've stopped. Mark as not running.
        this.isRunning = false;
        logger('Beaver File Uploader: Finished processing queue.', 3);
    }

    /**
     * Uploads a single file item. 
     * On success, the item is marked completed; on failure, we may reset or fail permanently.
     */
    private async uploadFile(item: UploadQueueItem): Promise<void> {
        try {
            logger(`Beaver File Uploader: Uploading file for ${item.attachment_key}`, 3);

            // Retrieve file path from Zotero
            const attachment = await Zotero.Items.getByLibraryAndKeyAsync(item.library_id, item.attachment_key);
            if (!attachment) {
                logger(`Beaver File Uploader: Attachment not found: ${item.attachment_key}`, 1);
                await this.handlePermanentFailure(item, "Attachment not found in Zotero");
                return;
            }

            // Get the page count for PDF attachments
            const pageCount = await getPDFPageCount(attachment);

            // Get the file path for the attachment
            let filePath: string | null = null;
            filePath = await attachment.getFilePathAsync() || null;
            if (!filePath) {
                logger(`Beaver File Uploader: File path not found for attachment: ${item.attachment_key}`, 1);
                await this.handlePermanentFailure(item, "File path not found");
                return;
            }

            // Read file content
            let fileArrayBuffer;
            try {
                fileArrayBuffer = await IOUtils.read(filePath);
            } catch (readError: any) {
                logger(`Beaver File Uploader: Error reading file: ${item.attachment_key}`, 1);
                Zotero.logError(readError);
                await this.handlePermanentFailure(item, "Error reading file");
                return;
            }
            
            // const mimeType = Zotero.MIME.getMIMETypeFromFile(filePath);
            const mimeType = attachment.attachmentContentType;
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
                            logger(`Beaver File Uploader: Server error ${response.status} on attempt ${attempt}, will retry`, 2);
                            await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Increasing backoff
                            continue;
                        } else {
                            // Client error - likely permanent
                            throw new Error(`Upload failed with status ${response.status}`);
                        }
                    }
                    
                    // Use our new completion method
                    await this.markUploadCompleted(item, pageCount);
                    uploadSuccess = true;
                } catch (uploadError: any) {
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
                        logger(`Beaver File Uploader: Network error on attempt ${attempt}, will retry: ${uploadError.message}`, 2);
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

        } catch (error: any) {
            logger(`Beaver File Uploader: Error uploading file for attachment ${item.attachment_key}: ${error.message}`, 1);
            Zotero.logError(error);

            // If attempts are too high, treat as permanently failed
            if (item.attempts >= 3) {
                await this.handlePermanentFailure(item, error instanceof Error ? error.message : "Max attempts reached");
            } else {
                // Otherwise, reset the item for retry later
                try {
                    await queueService.resetUpload(item.id);
                } catch (resetError: any) {
                    logger('Beaver File Uploader: Error resetting failed upload: ' + resetError.message, 1);
                    Zotero.logError(resetError);
                }
            }
        }
    }
    
    /**
     * Handles permanent failures by marking items as failed in the queue
     */
    private async handlePermanentFailure(item: UploadQueueItem, reason: string): Promise<void> {
        logger(`Beaver File Uploader: Permanent failure for ${item.attachment_key}: ${reason}`, 1);
        try {
            // Mark the item as failed
            await queueService.markUploadAsFailed(item.id, item.file_hash);
        } catch (failError: any) {
            logger('Beaver File Uploader: Error marking item as failed: ' + failError.message, 1);
            Zotero.logError(failError);
        }
    }

    // When marking an upload as completed, also update our progress
    private async markUploadCompleted(item: UploadQueueItem, pageCount: number | null): Promise<void> {
        try {
            await queueService.completeUpload(item, pageCount);
            logger(`Beaver File Uploader: Successfully uploaded file for attachment ${item.attachment_key} (page count: ${pageCount})`, 3);
            
            // Increment our local completed count immediately
            // This provides immediate feedback without waiting for the next server poll
            this.localProgress.completed++;
            this.reportStatus(
                'in_progress', 
                this.localProgress.completed, 
                this.localProgress.total
            );
            
        } catch (error: any) {
            logger(`Beaver File Uploader: Error marking upload as completed: ${error.message}`, 1);
            Zotero.logError(error);
        }
    }
}

/**
 * Exports a singleton instance for the file uploader.
 */
export const fileUploader = new FileUploader();
