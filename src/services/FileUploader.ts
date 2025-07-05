/**
 * FileUploader.ts
 *
 * A uploader that processes Zotero file attachments in batches using a queue. 
 * It reads pending items from the local SQLite database,
 * handles retries, and updates progress based on local queue status. 
 */

import PQueue from 'p-queue';
import { getPDFPageCount } from '../../react/utils/pdfUtils';
import { logger } from '../utils/logger';
import { store } from '../../react/index';
import { isAuthenticatedAtom, userAtom, userIdAtom } from '../../react/atoms/auth';
import { attachmentsService, ResetFailedResult, CompleteUploadRequest } from './attachmentsService';
import { UploadQueueInput, UploadQueueRecord } from './database';
import { isFileUploaderRunningAtom, isFileUploaderFailedAtom } from '../../react/atoms/sync';
import { hasCompletedOnboardingAtom, planFeaturesAtom } from '../../react/atoms/profile';
import { ZoteroItemReference } from '../../react/types/zotero';
import { supabase } from "./supabaseClient";
import { addOrUpdateFailedUploadMessageAtom } from '../../react/utils/popupMessageUtils';

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
    private readonly VISIBILITY_TIMEOUT: number = 0.5; // 30 seconds timeout for reads
    private readonly VISIBILITY_TIMEOUT_REMOTE_DB_FAILURE: number = 5;  // 5 minutes timeout for retries

    // completion batching
    private completionBatch: Array<{ item: UploadQueueRecord, request: CompleteUploadRequest }> = [];
    private batchTimer: NodeJS.Timeout | null = null;
    private readonly BATCH_SEND_SIZE: number = 5; // Send after 5 completions
    private readonly BATCH_SEND_TIMEOUT: number = 1500; // Send after 1.5 seconds

    /**
     * Starts the file uploader if it's not already running.
     * Initializes a concurrency queue and continuously processes queue items 
     * until no more items or until stopped.
     * @param sessionType Type of upload session (default: 'background')
     */
    public async start(sessionType: 'initial' | 'background' | 'manual' = 'background'): Promise<void> {
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
        
        // Set running state
        store.set(isFileUploaderRunningAtom, true);
        store.set(isFileUploaderFailedAtom, false);
        
        logger(`File Uploader: Starting file uploader (session type: ${sessionType})`, 3);

        // Initialize the p-queue with desired concurrency
        this.uploadQueue = new PQueue({ concurrency: this.MAX_CONCURRENT });

        // Begin processing in the background
        this.runQueue()
            .catch(error => {
                logger('File Uploader: Error in runQueue: ' + error.message, 1);
                Zotero.logError(error);
                this.isRunning = false;
                store.set(isFileUploaderRunningAtom, false);
                store.set(isFileUploaderFailedAtom, true);
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
            
            // Flush any remaining completion batches
            await this.flushCompletionBatch();
            
            // Clear session
            store.set(isFileUploaderRunningAtom, false);
        } catch (error: any) {
            logger('File Uploader: Error while waiting for queue to idle: ' + error.message, 1);
            Zotero.logError(error);
            store.set(isFileUploaderRunningAtom, false);
            store.set(isFileUploaderFailedAtom, true);
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

        while (this.isRunning) {
            try {
                // check authentication status
                const isAuthenticated = store.get(isAuthenticatedAtom);
                const user = store.get(userAtom);
                if (!isAuthenticated || !user?.id) {
                    logger('File Uploader Queue: Not authenticated or no user ID. Stopping.', 3);
                    this.isRunning = false;
                    break;
                }

                // If we've had too many consecutive errors, add a longer backoff
                if (consecutiveErrors > 0) {
                    logger(`File Uploader Queue: Backing off for ${errorBackoffTime}ms after ${consecutiveErrors} consecutive errors`, 3);
                    await new Promise(resolve => setTimeout(resolve, errorBackoffTime));
                    // Exponential backoff with max of 1 minute
                    errorBackoffTime = Math.min(errorBackoffTime * 2, 60000);
                }

                // Read items from local queue with visibility timeout
                const items: UploadQueueRecord[] = await Zotero.Beaver.db.readQueueItems(
                    user.id, 
                    this.BATCH_SIZE, 
                    this.MAX_ATTEMPTS,
                    this.VISIBILITY_TIMEOUT
                );

                logger(`File Uploader Queue: Read ${items.length} items from local queue`, 3);

                // If no items, we're done
                if (items.length === 0) {
                    break;
                }

                // Reset idle and error counters on successful queue read
                consecutiveErrors = 0;
                errorBackoffTime = ERROR_BACKOFF_TIME;

                // Add each upload task to the concurrency queue
                for (const item of items) {
                    this.uploadQueue.add(() => this.uploadFile(item, user.id));
                }

                // Wait for these uploads to finish before reading the next batch
                await this.uploadQueue.onIdle();
            } catch (error: any) {
                logger('File Uploader Queue: runQueue encountered an error: ' + error.message, 1);
                Zotero.logError(error);
                
                consecutiveErrors++;
                
                // If we've hit max consecutive errors, stop the session
                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    logger(`File Uploader Queue: Hit ${MAX_CONSECUTIVE_ERRORS} consecutive errors, stopping session`, 2);
                    throw new Error('Max consecutive errors reached');
                }

                // Continue with backoff...
                await new Promise(resolve => setTimeout(resolve, 30000));
            }
        }

        // Mark all items in the queue as failed
        await this.flushCompletionBatch();

        // No more items or we've stopped. Mark as not running.
        this.isRunning = false;
        logger('File Uploader Queue: Finished processing queue.', 3);
        store.set(isFileUploaderRunningAtom, false);
    }

    /**
     * Uploads a single file item. 
     * On success, the item is added to the completion batch; on failure, we may retry or fail permanently.
     */
    private async uploadFile(item: UploadQueueRecord, user_id: string): Promise<void> {
        try {
            logger(`File Uploader uploadFile ${item.zotero_key}: Uploading file`, 3);

            // Get the user ID from the store
            const userId = store.get(userIdAtom);
            if (!userId) {
                logger(`File Uploader uploadFile ${item.zotero_key}: No user ID found. Stopping.`, 3);
                throw new Error('No user ID found');
            }

            // Retrieve file path from Zotero
            const attachment = await Zotero.Items.getByLibraryAndKeyAsync(item.library_id, item.zotero_key);
            if (!attachment) {
                logger(`File Uploader uploadFile ${item.zotero_key}: Attachment not found`, 1);
                await this.handlePermanentFailure(item, user_id, "Attachment not found in Zotero");
                return;
            }

            // File metadata
            let mimeType = attachment.attachmentContentType;
            const pageCount = mimeType === 'application/pdf' ? await getPDFPageCount(attachment) : null;
            const fileSize = await Zotero.Attachments.getTotalFileSize(attachment);

            // Get the file path for the attachment
            let filePath: string | null = null;
            filePath = await attachment.getFilePathAsync() || null;
            if (!filePath) {
                logger(`File Uploader uploadFile ${item.zotero_key}: File path not found`, 1);
                await this.handlePermanentFailure(item, user_id, "File path not found");
                return;
            }

            // File size limit
            const fileSizeInMB = fileSize / 1024 / 1024; // convert to MB
            const sizeLimit = store.get(planFeaturesAtom).uploadFileSizeLimit;
            logger(`File Uploader: File size of ${fileSizeInMB}MB and limit of ${sizeLimit}MB`, 1);
            if (fileSizeInMB > sizeLimit) {
                logger(`File Uploader: File size of ${fileSizeInMB}MB exceeds ${sizeLimit}MB, skipping upload: ${item.zotero_key}`, 1);
                await this.handlePlanLimitFailure(item, user_id, `File size exceeds ${sizeLimit}MB`);
                return;
            }

            // Validate/correct MIME type by checking actual file if needed
            if (!mimeType || mimeType === 'application/octet-stream' || mimeType === '') {
                try {
                    const detectedMimeType = await Zotero.MIME.getMIMETypeFromFile(filePath);
                    if (detectedMimeType) {
                        mimeType = detectedMimeType;
                        logger(`File Uploader uploadFile ${item.zotero_key}: Corrected MIME type from '${attachment.attachmentContentType}' to '${mimeType}'`, 2);
                    }
                } catch (error) {
                    logger(`File Uploader uploadFile ${item.zotero_key}: Failed to detect MIME type, using stored type`, 2);
                    // Fall back to stored type or default
                    mimeType = attachment.attachmentContentType || 'application/octet-stream';
                }
            }

            // Read file content
            let fileArrayBuffer;
            try {
                fileArrayBuffer = await IOUtils.read(filePath);
            } catch (readError: any) {
                logger(`File Uploader uploadFile ${item.zotero_key}: Error reading file`, 1);
                Zotero.logError(readError);
                await this.handlePermanentFailure(item, user_id, "Error reading file");
                return;
            }
            
            // Create a blob from the file array buffer with the mime type
            const blob = new Blob([fileArrayBuffer], { type: mimeType });

            // Perform the file upload with retry for network issues
            let uploadSuccess = false;
            let uploadAttempt = 0;
            const maxUploadAttempts = 3;
            const storagePath = `${userId}/attachments/${item.file_hash}/original`;

            // First retry loop: Storage upload
            while (!uploadSuccess && uploadAttempt < maxUploadAttempts) {
                uploadAttempt++;
                try {
                    logger(`File Uploader uploadFile ${item.zotero_key}: Uploading file to ${storagePath} (attempt ${uploadAttempt}/${maxUploadAttempts})`, 3);
                    const { data, error } = await supabase
                        .storage
                        .from('files')
                        .upload(storagePath, blob, {
                            cacheControl: '3600',
                            upsert: true
                        });

                    if (error) {
                        // Retry with backoff
                        logger(`File Uploader uploadFile ${item.zotero_key}: Storage upload error ${JSON.stringify(error)} on attempt ${uploadAttempt}, will retry`, 2);
                        await new Promise(resolve => setTimeout(resolve, 2000 * uploadAttempt)); // Increasing backoff
                        continue;
                    }
                    
                    uploadSuccess = true;
                    logger(`File Uploader uploadFile ${item.zotero_key}: Storage upload successful on attempt ${uploadAttempt}`, 3);

                } catch (uploadError: any) {
                    if (uploadError instanceof TypeError) {
                        // Network error, retry with backoff
                        logger(`File Uploader uploadFile ${item.zotero_key}: Storage upload network error on attempt ${uploadAttempt}, will retry: ${uploadError.message}`, 2);
                    } else {
                        // Other errors, retry with backoff
                        logger(`File Uploader uploadFile ${item.zotero_key}: Storage upload error on attempt ${uploadAttempt}, will retry: ${uploadError.message}`, 2);
                    }
                    await new Promise(resolve => setTimeout(resolve, 2000 * uploadAttempt)); // Increasing backoff
                }
            }
            
            // If storage upload failed after all retries
            if (!uploadSuccess) {
                throw new Error(`Failed to upload file to storage after ${maxUploadAttempts} attempts`);
            }

            // Add to completion batch instead of marking completed directly
            await this.addCompletionToBatch(item, mimeType, fileSize, pageCount, user_id);

        } catch (error: any) {
            logger(`File Uploader uploadFile ${item.zotero_key}: Error uploading file: ${error.message}`, 1);
            Zotero.logError(error);

            // Treat as permanently failed with message for manual retry
            await this.handlePermanentFailure(item, user_id, error instanceof Error ? error.message : "Max attempts reached");
        }
    }

    /**
     * Adds a completion to the batch and manages batch sending
     */
    private async addCompletionToBatch(item: UploadQueueRecord, mimeType: string, fileSize: number, pageCount: number | null, user_id: string): Promise<void> {
        const request: CompleteUploadRequest = {
            file_hash: item.file_hash,
            mime_type: mimeType,
            file_size: fileSize,
            page_count: pageCount
        };

        this.completionBatch.push({ item, request });

        // If batch is full, flush it immediately
        if (this.completionBatch.length >= this.BATCH_SEND_SIZE) {
            await this.flushCompletionBatch();
        } else {
            // Otherwise, set/reset a timer to flush it after a short delay
            if (this.batchTimer) {
                clearTimeout(this.batchTimer);
            }
            this.batchTimer = setTimeout(() => this.flushCompletionBatch(), this.BATCH_SEND_TIMEOUT);
        }
    }

    /**
     * Flushes the completion batch to the backend
     */
    private async flushCompletionBatch(): Promise<void> {
        // Clear any pending timer
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }

        if (this.completionBatch.length === 0) {
            return;
        }

        // Make a copy of the current batch and clear the original immediately
        // This prevents race conditions if more items are added while the request is in-flight
        const batchToSend = [...this.completionBatch];
        this.completionBatch = [];

        const userId = store.get(userIdAtom);
        if (!userId) {
            logger('File Uploader: Cannot flush batch, no user ID.', 2);
            // Re-add items to batch to be retried later
            this.completionBatch.push(...batchToSend);
            return;
        }

        logger(`File Uploader: Flushing completion batch of ${batchToSend.length} items.`, 3);

        // Retry mechanism for batch completion
        let batchSuccess = false;
        let batchAttempt = 0;
        const maxBatchAttempts = 3;

        while (!batchSuccess && batchAttempt < maxBatchAttempts) {
            batchAttempt++;
            try {
                logger(`File Uploader: Attempting to flush batch (attempt ${batchAttempt}/${maxBatchAttempts})`, 3);
                const requests = batchToSend.map(b => b.request);
                const results = await attachmentsService.markUploadCompletedBatch(requests);

                // Process the response for each item
                for (const result of results) {
                    const batchItem = batchToSend.find(b => b.item.file_hash === result.hash);
                    if (!batchItem) {
                        logger(`File Uploader: Batch item not found for hash ${result.hash}`, 1);
                        continue;
                    }

                    if (result.upload_completed) {
                        // On success, update local DB
                        await Zotero.Beaver.db.completeQueueItem(userId, batchItem.item.file_hash);
                        logger(`File Uploader: Successfully uploaded file for attachment ${batchItem.item.zotero_key} (page count: ${batchItem.request.page_count})`, 3);
                    } else {
                        // On failure, log it. The item remains in the queue (since completeQueueItem wasn't called)
                        // and will be retried automatically on a future run.
                        logger(`File Uploader: Backend failed to complete ${batchItem.item.zotero_key}: ${result.error}`, 1);
                    }
                }
                
                batchSuccess = true;
                logger(`File Uploader: Batch flush successful on attempt ${batchAttempt}`, 3);
                
            } catch (batchError: any) {
                logger(`File Uploader: Batch flush error on attempt ${batchAttempt}, will retry: ${batchError.message}`, 2);
                if (batchAttempt < maxBatchAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 2000 * batchAttempt)); // Increasing backoff
                }
            }
        }

        // If batch flush failed after all retries, mark all items as permanently failed
        if (!batchSuccess) {
            logger(`File Uploader: Failed to flush batch after ${maxBatchAttempts} attempts, marking all items as permanently failed`, 1);
            
            // Mark each item in the batch as permanently failed
            for (const batchItem of batchToSend) {
                try {
                    await this.handlePermanentFailure(
                        batchItem.item, 
                        userId, 
                        `Failed to mark upload as completed in backend after ${maxBatchAttempts} attempts`
                    );
                } catch (failError: any) {
                    logger(`File Uploader: Failed to mark batch item ${batchItem.item.zotero_key} as permanently failed: ${failError.message}`, 1);
                    // If we can't mark it as failed, it will be retried on next run due to visibility timeout
                }
            }
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
            await attachmentsService.updateUploadStatus(item.file_hash, 'failed');
            
            // Only if backend call succeeds, update local state
            await Zotero.Beaver.db.failQueueItem(user_id, item.file_hash);

            // Error message for manual retry (only show if user has completed onboarding)
            if (store.get(hasCompletedOnboardingAtom)) {
                store.set(addOrUpdateFailedUploadMessageAtom, {
                    library_id: item.library_id,
                    zotero_key: item.zotero_key
                } as ZoteroItemReference);
            }
            
            logger(`File Uploader: Successfully marked ${item.zotero_key} as permanently failed`, 3);
            
        } catch (failError: any) {
            logger(`File Uploader: Failed to mark item as failed (will retry later): ${failError.message}`, 2);
            Zotero.logError(failError);
            // Don't update local state or cleanup - item will be retried after visibility timeout
            await Zotero.Beaver.db.setQueueItemTimeout(
                user_id,
                item.file_hash,
                this.VISIBILITY_TIMEOUT_REMOTE_DB_FAILURE
            );
            logger(`File Uploader: Upload failed for ${item.zotero_key}, will retry after ${this.VISIBILITY_TIMEOUT_REMOTE_DB_FAILURE} minutes`, 2);
            // Re-throw the error so callers know the operation failed
            throw failError;
        }
    }

    /**
     * Handles plan limit failures by marking items as failed in the backend first, 
     * then in the local database only if backend update succeeds
     */
    private async handlePlanLimitFailure(item: UploadQueueRecord, user_id: string, reason: string): Promise<void> {
        logger(`File Uploader: Plan limit failure for ${item.zotero_key}: ${reason}`, 1);
        try {
            // First, notify backend of failure
            await attachmentsService.updateUploadStatus(item.file_hash, 'plan_limit');

            // Only if backend call succeeds, update local state
            await Zotero.Beaver.db.failQueueItem(user_id, item.file_hash, 'plan_limit');
            
        } catch (failError: any) {
            logger(`File Uploader: Failed to mark item as plan limit failure (will retry later): ${failError.message}`, 2);
        }
    }
}


/**
 * Utility function to reset failed uploads by calling the backend and restarting the uploader
 */
export const resetFailedUploads = async (): Promise<void> => {
    try {
        // check authentication status
        const isAuthenticated = store.get(isAuthenticatedAtom);
        const user = store.get(userAtom);

        if (!isAuthenticated || !user?.id) {
            logger('File Uploader: Cannot reset failed uploads, user not authenticated or user ID missing.', 2);
            return;
        }
        const userId = user.id;

        // -------- (1) Reset failed uploads in backend --------
        const results: ResetFailedResult[] = await attachmentsService.resetFailedUploads();
        logger(`File Uploader: Backend reset ${results.length} failed uploads.`, 3);

        // Use results to reset failed uploads in local database
        if (results.length > 0) {
            const itemsToResetInDB: UploadQueueInput[] = results.map(result => ({
                file_hash: result.file_hash,
                library_id: result.library_id,
                zotero_key: result.zotero_key
                // Other fields like page_count, attempt_count will be set to default reset values
                // by the Zotero.Beaver.db.resetUploads method.
            }));

            await Zotero.Beaver.db.resetUploads(userId, itemsToResetInDB);
            logger(`File Uploader: Local DB updated for ${itemsToResetInDB.length} reset uploads.`, 3);
        }

        // -------- (2) Ensure integrity of local database --------
        // Integrity check: there should be no failed attachments in the local database after reset
        const failedAttachments = await Zotero.Beaver.db.getFailedAttachments(userId);
        if (failedAttachments.length > 0) {
            logger(`File Uploader: DB Integrity check found ${failedAttachments.length} failed attachments in local database, none expected.`, 3);

            // (a) Get the status of the failed attachments from the backend
            const results = await attachmentsService.getMultipleAttachmentsStatus(
                failedAttachments.map(a => ({zotero_key: a.zotero_key, library_id: a.library_id} as ZoteroItemReference))
            );

            // (b) Update local database
            for (const result of results) {
                await Zotero.Beaver.db.updateAttachment(userId, result.library_id, result.zotero_key, {
                    upload_status: result.upload_status ?? null,
                });
            }
            
            // (c) Enqueue pending attachments for upload if they are not already in the queue
            const pendingAttachments = results.filter(r => r.upload_status === 'pending');
            const queueItems: UploadQueueInput[] = pendingAttachments
                .filter(a => a.file_hash)
                .map(a => ({
                    file_hash: a.file_hash!,
                    library_id: a.library_id,
                    zotero_key: a.zotero_key,
                }));
            await Zotero.Beaver.db.upsertQueueItemsBatch(userId, queueItems);
            logger(`File Uploader: Enqueued ${pendingAttachments.length} pending attachments for upload.`, 3);
        }
        
        // -------- (3) Restart the uploader --------
        await fileUploader.start("manual");

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
 * Utility function to retry skipped uploads.
 */
export const retrySkippedUploads = async (): Promise<void> => {
    try {
        const userId = store.get(userIdAtom);
        if (!userId) {
            logger('File Uploader: Cannot retry skipped uploads, user not authenticated.', 2);
            return;
        }

        const skippedAttachments = await Zotero.Beaver.db.getAttachmentsByUploadStatus(userId, 'plan_limit');

        if (skippedAttachments.length === 0) {
            logger('File Uploader: No skipped attachments to retry.', 3);
            return;
        }

        logger(`File Uploader: Found ${skippedAttachments.length} skipped attachments to retry.`, 3);

        const itemsToReset: UploadQueueInput[] = skippedAttachments
            .filter(a => a.file_hash)
            .map(attachment => ({
                file_hash: attachment.file_hash,
                library_id: attachment.library_id,
                zotero_key: attachment.zotero_key,
            }));
        
        if (itemsToReset.length > 0) {
            await Zotero.Beaver.db.resetUploads(userId, itemsToReset);
            logger(`File Uploader: Re-queued ${itemsToReset.length} skipped attachments.`, 3);
        }

        await fileUploader.start("manual");

    } catch (error: any) {
        logger(`File Uploader: Failed to retry skipped uploads: ${error.message}`, 1);
        if (typeof Zotero !== 'undefined' && Zotero.logError) {
            Zotero.logError(error);
        } else {
            console.error('Failed to retry skipped uploads:', error);
        }
    }
};


/**
 * Exports a singleton instance for the file uploader.
 */
export const fileUploader = new FileUploader();
