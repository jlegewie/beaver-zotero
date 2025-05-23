/**
 * FileUploader.ts
 *
 * A uploader that processes Zotero file attachments in batches using a queue. 
 * It reads pending items from the local SQLite database, requests upload URLs on-demand,
 * handles retries, and updates progress based on local queue status. 
 */

import PQueue from 'p-queue';
import { SyncStatus } from '../../react/atoms/ui';
import { getPDFPageCount } from '../../react/utils/pdfUtils';
import { logger } from '../utils/logger';
import { store } from '../../react/index';
import { isAuthenticatedAtom, userAtom } from '../../react/atoms/auth';
import { attachmentsService } from './attachmentsService';
import { UploadQueueRecord } from './database';

export interface UploadProgressInfo {
  status: SyncStatus;
  current: number;
  total: number;
}

/**
 * Queue status interface for local tracking
 */
export interface QueueStatus {
    pending: number;
    in_progress: number;
    completed: number;
    failed: number;
    total: number;
}

/**
 * Manages file uploads from a frontend-managed queue of pending uploads.
 */
export class FileUploader {
    private isRunning: boolean = false;
    private uploadQueue!: PQueue; // Will be initialized on start

    // upload concurrency
    private readonly MAX_CONCURRENT: number = 3;

    // upload batching
    // queue reads
    private readonly BATCH_SIZE: number = 10;
    private readonly MAX_ATTEMPTS: number = 3;
    private readonly VISIBILITY_TIMEOUT: number = 15;

    /**
     * URL cache to store upload URLs with expiration times
     */
    private urlCache: Map<string, { url: string; expiresAt: Date }> = new Map();

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
        
        // Calculate completed count from local status
        const localCompleted = status.completed + status.failed;
        
        // Only increase the completed count, never decrease it
        // This prevents progress from going backward
        if (localCompleted > this.localProgress.completed) {
            this.localProgress.completed = localCompleted;
        }
        
        // Report progress using our stable local tracking
        this.reportStatus(
            'in_progress', 
            this.localProgress.completed, 
            this.localProgress.total
        );
    }

    /**
     * Gets upload URL for a single file hash with caching
     * @param fileHash The file hash to get URL for
     * @returns Upload URL or null if failed
     */
    private async getUploadUrl(fileHash: string): Promise<string | null> {
        // Check cache first with 30-minute safety buffer
        const cached = this.urlCache.get(fileHash);
        if (cached) {
            const safetyBuffer = 30 * 60 * 1000; // 30 minutes in milliseconds
            if (new Date().getTime() < cached.expiresAt.getTime() - safetyBuffer) {
                return cached.url;
            } else {
                // Remove expired URL from cache
                this.urlCache.delete(fileHash);
            }
        }

        try {
            // Request new URL from backend
            const urlResponse = await attachmentsService.getUploadUrls([fileHash]);
            const uploadUrl = urlResponse[fileHash];
            
            if (uploadUrl) {
                // Cache the URL for 90 minutes (30 minutes before the 2-hour expiration)
                const expiresAt = new Date(Date.now() + 90 * 60 * 1000);
                this.urlCache.set(fileHash, { url: uploadUrl, expiresAt });
                return uploadUrl;
            }
            
            return null;
        } catch (error: any) {
            logger(`Beaver File Uploader: Error getting upload URL for ${fileHash}: ${error.message}`, 1);
            return null;
        }
    }

    /**
     * Gets upload URLs for multiple items with caching
     * @param items Array of queue items to get URLs for
     * @returns Map of fileHash to URL for all items
     */
    private async getUploadUrls(items: UploadQueueRecord[]): Promise<Map<string, string>> {
        const urlMap = new Map<string, string>();
        const itemsNeedingUrls: UploadQueueRecord[] = [];
        
        // Check cache for existing valid URLs
        const safetyBuffer = 30 * 60 * 1000; // 30 minutes in milliseconds
        for (const item of items) {
            const cached = this.urlCache.get(item.file_hash);
            if (cached && new Date().getTime() < cached.expiresAt.getTime() - safetyBuffer) {
                urlMap.set(item.file_hash, cached.url);
            } else {
                // Remove expired URL from cache
                if (cached) {
                    this.urlCache.delete(item.file_hash);
                }
                itemsNeedingUrls.push(item);
            }
        }

        // Request new URLs in batch if needed
        if (itemsNeedingUrls.length > 0) {
            try {
                const fileHashes = itemsNeedingUrls.map(item => item.file_hash);
                const urlResponse = await attachmentsService.getUploadUrls(fileHashes);
                
                // Cache new URLs and add to result map
                const expiresAt = new Date(Date.now() + 90 * 60 * 1000); // 90 minutes
                for (const item of itemsNeedingUrls) {
                    const uploadUrl = urlResponse[item.file_hash];
                    if (uploadUrl) {
                        this.urlCache.set(item.file_hash, { url: uploadUrl, expiresAt });
                        urlMap.set(item.file_hash, uploadUrl);
                    }
                }
            } catch (error: any) {
                logger(`Beaver File Uploader: Error getting batch upload URLs: ${error.message}`, 1);
            }
        }

        return urlMap;
    }

    /**
     * Gets queue statistics from local database
     * @param user_id User ID
     * @returns Local queue status
     */
    private async getQueueStatistics(user_id: string): Promise<QueueStatus> {
        try {
            // @ts-ignore Beaver is defined
            const stats = await Zotero.Beaver.db.getUploadStatistics(user_id);
            
            return {
                pending: stats.pending,
                in_progress: stats.inProgress,
                completed: stats.completed,
                failed: stats.failed,
                total: stats.total
            };
        } catch (error: any) {
            logger(`Beaver File Uploader: Error getting queue statistics: ${error.message}`, 1);
            return this.lastStatus;
        }
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
     * Main loop that continuously reads items from local queue and processes them until
     * no more items remain or the uploader is stopped.
     */
    private async runQueue(): Promise<void> {
        // Reset progress tracking at the start of a queue run
        this.localProgress = {
            completed: 0,
            total: 0
        };
        
        // Error backoff handling
        const MAX_CONSECUTIVE_ERRORS = 5;
        const ERROR_BACKOFF_TIME = 1000;
        let consecutiveErrors = 0;
        let errorBackoffTime = ERROR_BACKOFF_TIME;

        while (this.isRunning) {
            try {
                // check authentication status
                const isAuthenticated = store.get(isAuthenticatedAtom);
                const user = store.get(userAtom);
                if (!isAuthenticated || !user?.id) {
                    logger('Beaver File Uploader: Not authenticated or no user ID. Stopping.', 3);
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

                // Read items from local queue with visibility timeout
                // @ts-ignore Beaver is defined
                const items: UploadQueueRecord[] = await Zotero.Beaver.db.readQueueItems(
                    user.id, 
                    this.BATCH_SIZE, 
                    this.MAX_ATTEMPTS,
                    this.VISIBILITY_TIMEOUT
                );

                logger(`Beaver File Uploader: Read ${items.length} items from local queue`, 3);

                // If no items, we're done
                if (items.length === 0) {
                    this.reportStatus('completed', this.localProgress.total, this.localProgress.total);
                    break;
                }

                // Report progress
                const status = await this.getQueueStatistics(user.id);
                this.lastStatus = status;
                this.reportProgress(status);

                // Get upload URLs for all items
                const urlMap = await this.getUploadUrls(items);

                // Filter items that have valid URLs
                const itemsWithUrls = items.filter(item => urlMap.has(item.file_hash));
                logger(`Beaver File Uploader: Got upload URLs for ${itemsWithUrls.length} out of ${items.length} items`, 3);

                // Reset idle and error counters on successful queue read
                consecutiveErrors = 0;
                errorBackoffTime = ERROR_BACKOFF_TIME;

                // Add each upload task to the concurrency queue
                for (const item of itemsWithUrls) {
                    const uploadUrl = urlMap.get(item.file_hash)!;
                    this.uploadQueue.add(() => this.uploadFile(item, uploadUrl, user.id));
                }

                // Wait for these uploads to finish before reading the next batch
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
     * On success, the item is marked completed; on failure, we may retry or fail permanently.
     */
    private async uploadFile(item: UploadQueueRecord, uploadUrl: string, user_id: string): Promise<void> {
        try {
            logger(`Beaver File Uploader: Uploading file for ${item.zotero_key}`, 3);

            // Retrieve file path from Zotero
            const attachment = await Zotero.Items.getByLibraryAndKeyAsync(item.library_id, item.zotero_key);
            if (!attachment) {
                logger(`Beaver File Uploader: Attachment not found: ${item.zotero_key}`, 1);
                await this.handlePermanentFailure(item, user_id, "Attachment not found in Zotero");
                return;
            }

            // Get the page count for PDF attachments
            const pageCount = await getPDFPageCount(attachment);

            // Get the file path for the attachment
            let filePath: string | null = null;
            filePath = await attachment.getFilePathAsync() || null;
            if (!filePath) {
                logger(`Beaver File Uploader: File path not found for attachment: ${item.zotero_key}`, 1);
                await this.handlePermanentFailure(item, user_id, "File path not found");
                return;
            }

            // Read file content
            let fileArrayBuffer;
            try {
                fileArrayBuffer = await IOUtils.read(filePath);
            } catch (readError: any) {
                logger(`Beaver File Uploader: Error reading file: ${item.zotero_key}`, 1);
                Zotero.logError(readError);
                await this.handlePermanentFailure(item, user_id, "Error reading file");
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
                    const response = await fetch(uploadUrl, {
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
                    
                    // Mark upload as completed
                    await this.markUploadCompleted(item, pageCount, user_id);
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
            logger(`Beaver File Uploader: Error uploading file for attachment ${item.zotero_key}: ${error.message}`, 1);
            Zotero.logError(error);

            // If attempts are too high, treat as permanently failed
            if (item.attempt_count >= 3) {
                await this.handlePermanentFailure(item, user_id, error instanceof Error ? error.message : "Max attempts reached");
            } else {
                // The visibility timeout will handle retries automatically
                // No action needed here - the item will become visible again after timeout
                logger(`Beaver File Uploader: Upload failed for ${item.zotero_key}, will retry after visibility timeout`, 2);
                setTimeout(() => this.start(), this.VISIBILITY_TIMEOUT * 60 * 1000);
            }
        }
    }
    
    /**
     * Handles permanent failures by marking items as failed in the backend first, 
     * then in the local database only if backend update succeeds
     */
    private async handlePermanentFailure(item: UploadQueueRecord, user_id: string, reason: string): Promise<void> {
        logger(`Beaver File Uploader: Permanent failure for ${item.zotero_key}: ${reason}`, 1);
        
        try {
            // First, notify backend of failure
            await attachmentsService.markUploadFailed(item.file_hash);
            
            // Only if backend call succeeds, update local state
            // @ts-ignore Beaver is defined
            await Zotero.Beaver.db.failQueueItem(user_id, item.file_hash);
            
            // Remove URL from cache
            this.urlCache.delete(item.file_hash);
            
            logger(`Beaver File Uploader: Successfully marked ${item.zotero_key} as permanently failed`, 3);
            
        } catch (failError: any) {
            logger(`Beaver File Uploader: Failed to mark item as failed (will retry later): ${failError.message}`, 2);
            Zotero.logError(failError);
            // Don't update local state or cleanup - this means the item will be retried later
            // Re-throw the error so callers know the operation failed
            throw failError;
        }
    }

    /**
     * Marks upload as completed in backend first, then updates local state only if successful
     */
    private async markUploadCompleted(item: UploadQueueRecord, pageCount: number | null, user_id: string): Promise<void> {
        try {
            // First, notify backend of completion
            await attachmentsService.markUploadCompleted(item.file_hash, pageCount);

            // Only if backend call succeeds, update local state and cleanup
            // @ts-ignore Beaver is defined
            await Zotero.Beaver.db.completeQueueItem(user_id, item.file_hash);

            // Remove URL from cache only after successful backend update
            this.urlCache.delete(item.file_hash);

            logger(`Beaver File Uploader: Successfully uploaded file for attachment ${item.zotero_key} (page count: ${pageCount})`, 3);
            
            // Increment our local completed count only after successful backend update
            this.localProgress.completed++;
            this.reportStatus(
                'in_progress', 
                this.localProgress.completed, 
                this.localProgress.total
            );
            
        } catch (error: any) {
            logger(`Beaver File Uploader: Error marking upload as completed: ${error.message}`, 1);
            Zotero.logError(error);
            // Re-throw the error so callers know the completion marking failed
            throw error;
        }
    }
}

/**
 * Exports a singleton instance for the file uploader.
 */
export const fileUploader = new FileUploader();
