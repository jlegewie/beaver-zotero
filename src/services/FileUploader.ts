/**
 * FileUploader.ts
 *
 * A uploader that processes Zotero file attachments in batches using a queue. 
 * It reads pending items from the local SQLite database, requests upload URLs on-demand,
 * handles retries, and updates progress based on local queue status. 
 */

import PQueue from 'p-queue';
import { getPDFPageCount } from '../../react/utils/pdfUtils';
import { logger } from '../utils/logger';
import { store } from '../../react/index';
import { isAuthenticatedAtom, userAtom } from '../../react/atoms/auth';
import { attachmentsService, ResetFailedResult } from './attachmentsService';
import { UploadQueueInput, UploadQueueRecord } from './database';
import { uploadQueueStatusAtom, UploadQueueSession, UploadSessionType } from '../../react/atoms/sync';
import { planFeaturesAtom } from '../../react/atoms/profile';

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
    private readonly BATCH_SIZE: number = 15;
    private readonly MAX_ATTEMPTS: number = 3;
    private readonly INITIAL_VISIBILITY_TIMEOUT: number = 1; // 1 minute timeout for reads
    private readonly RETRY_VISIBILITY_TIMEOUT: number = 15;  // 15 minutes timeout for retries

    /**
     * Minimum interval between currentFile updates (in milliseconds)
     */
    private readonly MIN_FILE_UPDATE_INTERVAL: number = 200;
    private lastFileUpdateTime: number = 0;

    /**
     * URL cache to store upload URLs with expiration times
     */
    private urlCache: Map<string, { url: string; expiresAt: Date }> = new Map();

    /**
     * Updates the upload queue status atom
     */
    private updateQueueStatus(updates: Partial<UploadQueueSession>): void {
        store.set(uploadQueueStatusAtom, (current) => {
            return { ...current, ...updates } as UploadQueueSession;
        });
    }

    /**
     * Increments the queue status by the given values
     * @param updates The values to increment by
     * @param persist Whether to persist the session to prefs
     */
    private incrementQueueStatus(
        updates: Partial<Pick<UploadQueueSession, 'pending' | 'completed' | 'failed' | 'skipped'>>,
        persist: boolean = true
    ): void {

        store.set(uploadQueueStatusAtom, (current: UploadQueueSession | null) => {
            const newStatus = {
                ...current,
                pending: (current?.pending || 0) + (updates.pending || 0),
                completed: (current?.completed || 0) + (updates.completed || 0),
                failed: (current?.failed || 0) + (updates.failed || 0),
                skipped: (current?.skipped || 0) + (updates.skipped || 0),
            } as UploadQueueSession;
            
            return newStatus;
        });
    }

    /**
     * Updates the current file being uploaded with rate limiting
     */
    private updateCurrentAttachment(libraryId: number, zoteroKey: string): void {
        const now = Date.now();
        if (libraryId && zoteroKey && now - this.lastFileUpdateTime < this.MIN_FILE_UPDATE_INTERVAL) {
            return; // Skip update if too soon
        }
        
        this.lastFileUpdateTime = now;
        this.updateQueueStatus({ currentFile: libraryId + "-" + zoteroKey });
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
            logger(`File Uploader: Error getting upload URL for ${fileHash}: ${error.message}`, 1);
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
                logger(`File Uploader: Error getting batch upload URLs: ${error.message}`, 1);
            }
        }

        return urlMap;
    }

    /**
     * Calculate the total number of unique files that need uploading for this session
     */
    private async calculatePendingItems(user_id: string): Promise<number> {
        try {
            return await Zotero.Beaver.db.getTotalQueueItems(user_id);
        } catch (error: any) {
            logger(`File Uploader: Error calculating session total: ${error.message}`, 1);
            return 0;
        }
    }

    /**
     * Starts the file uploader if it's not already running.
     * Initializes a concurrency queue and continuously processes queue items 
     * until no more items or until stopped.
     * @param sessionType Type of upload session (default: 'background')
     */
    public async start(sessionType: UploadSessionType = 'background'): Promise<void> {
        // check authentication status and plan features
        const user = store.get(userAtom);
        if (!user?.id) {
            logger('File Uploader: No user ID found. Stopping.', 3);
            return;
        }
        if (!store.get(planFeaturesAtom).uploadFiles) {
            logger('File Uploader: Uploading files is not supported for this plan. Stopping.', 3);
            return;
        }

        // check if already running
        if (this.isRunning) {
            logger('File Uploader: Already running. Updating session instead.', 4);
            return;
        }
        this.isRunning = true;
        
        const pending = await this.calculatePendingItems(user.id);
        this.updateQueueStatus({
            sessionType: sessionType,
            status: 'in_progress',
            pending: pending,
            completed: 0,
            failed: 0,
            skipped: 0,
            currentFile: null
        });
        
        logger(`File Uploader: Starting file uploader (session type: ${sessionType})`, 3);

        // Initialize the p-queue with desired concurrency
        this.uploadQueue = new PQueue({ concurrency: this.MAX_CONCURRENT });

        // Begin processing in the background
        this.runQueue()
            .catch(error => {
                logger('File Uploader: Error in runQueue: ' + error.message, 1);
                Zotero.logError(error);
                this.isRunning = false;
                this.updateQueueStatus({ status: 'failed' });
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
        logger('File Uploader: Stopping file uploader', 3);

        // Wait for all queued tasks to finish, if any
        try {
            await this.uploadQueue.onIdle();            
            // Clear session
            this.updateQueueStatus({ status: 'completed', currentFile: null });
        } catch (error: any) {
            logger('File Uploader: Error while waiting for queue to idle: ' + error.message, 1);
            Zotero.logError(error);
            this.updateQueueStatus({ status: 'failed', currentFile: null });
        }
    }

    /**
     * Main loop that continuously reads items from local queue and processes them until
     * no more items remain or the uploader is stopped.
     */
    private async runQueue(): Promise<void> {
        // Error backoff handling
        const MAX_CONSECUTIVE_ERRORS = 5;
        const ERROR_BACKOFF_TIME = 1000;
        let consecutiveErrors = 0;
        let errorBackoffTime = ERROR_BACKOFF_TIME;

        // Only recalculate pending periodically or when needed
        let lastPendingUpdate = 0;

        while (this.isRunning) {
            try {
                // check authentication status
                const isAuthenticated = store.get(isAuthenticatedAtom);
                const user = store.get(userAtom);
                if (!isAuthenticated || !user?.id) {
                    logger('File Uploader: Not authenticated or no user ID. Stopping.', 3);
                    this.isRunning = false;
                    break;
                }

                // If we've had too many consecutive errors, add a longer backoff
                if (consecutiveErrors > 0) {
                    logger(`File Uploader: Backing off for ${errorBackoffTime}ms after ${consecutiveErrors} consecutive errors`, 3);
                    await new Promise(resolve => setTimeout(resolve, errorBackoffTime));
                    // Exponential backoff with max of 1 minute
                    errorBackoffTime = Math.min(errorBackoffTime * 2, 60000);
                }

                // Read items from local queue with visibility timeout
                const items: UploadQueueRecord[] = await Zotero.Beaver.db.readQueueItems(
                    user.id, 
                    this.BATCH_SIZE, 
                    this.MAX_ATTEMPTS,
                    this.INITIAL_VISIBILITY_TIMEOUT
                );

                logger(`File Uploader: Read ${items.length} items from local queue`, 3);

                // If no items, we're done
                if (items.length === 0) {
                    break;
                }

                // Get upload URLs for all items
                const urlMap = await this.getUploadUrls(items);

                // Separate items with and without URLs
                const itemsWithUrls = items.filter(item => urlMap.has(item.file_hash));
                const itemsWithoutUrls = items.filter(item => !urlMap.has(item.file_hash));

                // Mark items without URLs as failed (they can't be processed)
                for (const item of itemsWithoutUrls) {
                    try {
                        await this.handlePermanentFailure(item, user.id, "Unable to get upload URL");
                    } catch (error: any) {
                        logger(`Failed to mark item ${item.zotero_key} as failed: ${error.message}`, 2);
                    }
                }

                // Only recalculate pending periodically or when needed
                if (Date.now() - lastPendingUpdate > 30000) { // Every 30 seconds
                    const pending = await this.calculatePendingItems(user.id);
                    this.updateQueueStatus({ pending });
                    lastPendingUpdate = Date.now();
                }

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
                logger('File Uploader: runQueue encountered an error: ' + error.message, 1);
                Zotero.logError(error);
                
                consecutiveErrors++;
                
                // If we've hit max consecutive errors, stop the session
                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    logger(`File Uploader: Hit ${MAX_CONSECUTIVE_ERRORS} consecutive errors, stopping session`, 2);
                    throw new Error('Max consecutive errors reached');
                }

                // Continue with backoff...
                await new Promise(resolve => setTimeout(resolve, 30000));
            }
        }

        // No more items or we've stopped. Mark as not running.
        this.isRunning = false;
        logger('File Uploader: Finished processing queue.', 3);
        this.updateQueueStatus({ status: 'completed', currentFile: null });
    }

    /**
     * Uploads a single file item. 
     * On success, the item is marked completed; on failure, we may retry or fail permanently.
     */
    private async uploadFile(item: UploadQueueRecord, uploadUrl: string, user_id: string): Promise<void> {
        try {
            // Update current file being processed
            this.updateCurrentAttachment(item.library_id, item.zotero_key);
            
            logger(`File Uploader: Uploading file for ${item.zotero_key}`, 3);

            // Retrieve file path from Zotero
            const attachment = await Zotero.Items.getByLibraryAndKeyAsync(item.library_id, item.zotero_key);
            if (!attachment) {
                logger(`File Uploader: Attachment not found: ${item.zotero_key}`, 1);
                await this.handlePermanentFailure(item, user_id, "Attachment not found in Zotero");
                return;
            }

            // Get the page count for PDF attachments
            const pageCount = await getPDFPageCount(attachment);

            // Get the file path for the attachment
            let filePath: string | null = null;
            filePath = await attachment.getFilePathAsync() || null;
            if (!filePath) {
                logger(`File Uploader: File path not found for attachment: ${item.zotero_key}`, 1);
                await this.handlePermanentFailure(item, user_id, "File path not found");
                return;
            }

            // Read file content
            let fileArrayBuffer;
            try {
                fileArrayBuffer = await IOUtils.read(filePath);
            } catch (readError: any) {
                logger(`File Uploader: Error reading file: ${item.zotero_key}`, 1);
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
                            logger(`File Uploader: Server error ${response.status} on attempt ${attempt}, will retry`, 2);
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
                        logger(`File Uploader: Network error on attempt ${attempt}, will retry: ${uploadError.message}`, 2);
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
            logger(`File Uploader: Error uploading file for attachment ${item.zotero_key}: ${error.message}`, 1);
            Zotero.logError(error);

            // If attempts are too high, treat as permanently failed
            if (item.attempt_count >= 3) {
                await this.handlePermanentFailure(item, user_id, error instanceof Error ? error.message : "Max attempts reached");
            } else {
                // Set longer timeout for application-handled retry
                await Zotero.Beaver.db.setQueueItemTimeout(
                    user_id,
                    item.file_hash,
                    this.RETRY_VISIBILITY_TIMEOUT
                );
                logger(`File Uploader: Upload failed for ${item.zotero_key}, will retry after ${this.RETRY_VISIBILITY_TIMEOUT} minutes`, 2);
            }
        } finally {
            // Clear current file when done (success or failure)
            this.updateQueueStatus({ currentFile: null });
        }
    }
    
    /**
     * Handles permanent failures by marking items as failed in the backend first, 
     * then in the local database only if backend update succeeds
     */
    private async handlePermanentFailure(item: UploadQueueRecord, user_id: string, reason: string): Promise<void> {
        logger(`File Uploader: Permanent failure for ${item.zotero_key}: ${reason}`, 1);
        
        try {
            // First, notify backend of failure
            await attachmentsService.markUploadFailed(item.file_hash);
            
            // Only if backend call succeeds, update local state
            await Zotero.Beaver.db.failQueueItem(user_id, item.file_hash);
            
            // Remove URL from cache
            this.urlCache.delete(item.file_hash);

            this.incrementQueueStatus({ failed: 1, pending: -1 }, true);
            
            logger(`File Uploader: Successfully marked ${item.zotero_key} as permanently failed`, 3);
            
        } catch (failError: any) {
            logger(`File Uploader: Failed to mark item as failed (will retry later): ${failError.message}`, 2);
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
            await Zotero.Beaver.db.completeQueueItem(user_id, item.file_hash);

            // Remove URL from cache only after successful backend update
            this.urlCache.delete(item.file_hash);

            logger(`File Uploader: Successfully uploaded file for attachment ${item.zotero_key} (page count: ${pageCount})`, 3);
            
            // Increment our local completed count only after successful backend update
            this.incrementQueueStatus({ completed: 1, pending: -1 }, true);
            
        } catch (error: any) {
            logger(`File Uploader: Error marking upload as completed: ${error.message}`, 1);
            Zotero.logError(error);
            // Re-throw the error so callers know the completion marking failed
            throw error;
        }
    }

}


/**
 * Utility function to reset failed uploads by calling the backend and restarting the uploader
 */
export const resetFailedUploads = async (): Promise<void> => {
    try {
        const isAuthenticated = store.get(isAuthenticatedAtom);
        const user = store.get(userAtom);

        if (!isAuthenticated || !user?.id) {
            logger('File Uploader: Cannot reset failed uploads, user not authenticated or user ID missing.', 2);
            return;
        }
        const userId = user.id;

        const results: ResetFailedResult[] = await attachmentsService.resetFailedUploads();
        logger(`File Uploader: Backend reset ${results.length} failed uploads.`, 3);

        if (results.length === 0) {
            logger(`File Uploader: No failed uploads reported by backend to reset locally.`, 3);
            return;
        }

        const itemsToResetInDB: UploadQueueInput[] = results.map(result => ({
            file_hash: result.file_hash,
            library_id: result.library_id,
            zotero_key: result.zotero_key
            // Other fields like page_count, attempt_count will be set to default reset values
            // by the Zotero.Beaver.db.resetUploads method.
        }));

        await Zotero.Beaver.db.resetUploads(userId, itemsToResetInDB);
        logger(`File Uploader: Local DB updated for ${itemsToResetInDB.length} reset uploads.`, 3);

        // Restart the uploader
        await fileUploader.start("manual");
        logger(`File Uploader: Uploader restarted after resetting failed uploads.`, 3);

    } catch (error: any) {
        logger(`File Uploader: Failed to reset failed uploads: ${error.message}`, 1);
        // Zotero.logError is good for logging to Zotero's native error console
        if (typeof Zotero !== 'undefined' && Zotero.logError) {
            Zotero.logError(error);
        } else {
            console.error('Failed to reset failed uploads:', error); // Fallback if Zotero.logError is not available
        }
    }
};


/**
 * Exports a singleton instance for the file uploader.
 */
export const fileUploader = new FileUploader();
