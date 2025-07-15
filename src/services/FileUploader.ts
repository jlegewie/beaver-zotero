/**
 * FileUploader.ts
 *
 * A uploader that processes Zotero file attachments in batches using a backend queue. 
 * It reads pending items from the backend upload queue service,
 * handles retries, and updates progress based on backend queue status. 
 */

import PQueue from 'p-queue';
import { getPDFPageCount } from '../../react/utils/pdfUtils';
import { logger } from '../utils/logger';
import { store } from '../../react/index';
import { isAuthenticatedAtom, userAtom, userIdAtom } from '../../react/atoms/auth';
import { attachmentsService, CompleteUploadRequest } from './attachmentsService';
import { isFileUploaderRunningAtom, isFileUploaderFailedAtom } from '../../react/atoms/sync';
import { hasCompletedOnboardingAtom, planFeaturesAtom } from '../../react/atoms/profile';
import { FileHashReference, ZoteroItemReference } from '../../react/types/zotero';
import { supabase } from "./supabaseClient";
import { addOrUpdateFailedUploadMessageAtom } from '../../react/utils/popupMessageUtils';
import { filesService, UploadQueueItem } from './filesService';
import { showFileStatusDetailsAtom } from '../../react/atoms/ui';

/**
 * Manages file uploads from a backend-managed queue of pending uploads.
 */
export class FileUploader {
    private isRunning: boolean = false;
    private uploadQueue!: PQueue; // Will be initialized on start

    // upload concurrency
    private readonly MAX_CONCURRENT: number = 3;

    // upload batching
    // queue reads
    private readonly BATCH_SIZE: number = 20;
    private readonly VISIBILITY_TIMEOUT_SECONDS: number = 300; // 5 minutes timeout for backend queue reads

    // completion batching
    private completionBatch: Array<{ item: UploadQueueItem, request: CompleteUploadRequest }> = [];
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
     * Main loop that continuously reads items from backend queue and processes them until
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

                // Read items from backend queue with visibility timeout
                const response = await filesService.readUploadQueue(
                    this.VISIBILITY_TIMEOUT_SECONDS,
                    this.BATCH_SIZE
                );
                const items = response.items;

                logger(`File Uploader Queue: Read ${items.length} items from backend queue`, 3);

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

    private async uploadFileToSupabase(storagePath: string, blob: Blob): Promise<void> {
        const { data, error } = await supabase
            .storage
            .from('files')
            .upload(storagePath, blob, {
                cacheControl: '3600',
                upsert: true
            });

        if (error) {
            throw new Error(`Failed to upload file to storage: ${error.message}`);
        }

        return ;
    }

    private async uploadFileToGCS(signedUrl: string, blob: Blob, metadata: Record<string, string>): Promise<void> {
        const headers = {
            'Content-Type': 'application/octet-stream',
        };
        
        // Add metadata as headers
        Object.entries(metadata).forEach(([key, value]) => {
            headers[`x-goog-meta-${key}` as keyof typeof headers] = value;
        });
        
        const response = await fetch(signedUrl, {
            method: 'PUT',
            body: blob,
            headers: headers
        });

        if (!response.ok) {
            throw new Error(`Failed to upload file to storage: ${response.statusText}`);
        }
        
        return ;
    }
    
    /**
     * Uploads a single file item. 
     * On success, the item is added to the completion batch; on failure, we may retry or fail permanently.
     */
    private async uploadFile(item: UploadQueueItem, user_id: string): Promise<void> {
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
            const filePath: string | null = await attachment.getFilePathAsync() || null;

            // Attempt to download if file is not available locally
            // NOTE: Disable for now because it violates user intent. Plugin shouldn't download all files for users who use "as needed" setting.
            /* if (!filePath) {
                const fileSyncEnabled = Zotero.Sync.Storage.Local.getEnabledForLibrary(attachment.libraryID);
                
                // Only try to download if:
                // 1. File sync is enabled
                // 2. This is NOT a linked file (linked files can't be downloaded from server)
                if (fileSyncEnabled && attachment.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_LINKED_FILE) {
                    logger(`File not available locally, attempting to download: ${item.zotero_key}`, 1);
                    
                    try {
                        // Download the file on-demand
                        const results = await Zotero.Sync.Runner.downloadFile(attachment);
                        
                        if (results && results.localChanges) {
                            // File was downloaded successfully, get the path again
                            filePath = await attachment.getFilePathAsync() || null;
                            logger(`File downloaded successfully: ${item.zotero_key}`, 1);
                        } else {
                            logger(`File download failed: ${item.zotero_key}`, 1);
                            await this.handlePermanentFailure(item, user_id, "File path not found");
                            return;
                        }
                    } catch (downloadError: any) {
                        logger(`File download error for ${item.zotero_key}: ${downloadError.message}`, 1);
                        await this.handlePermanentFailure(item, user_id, "File path not found");
                        return;
                    }
                }
            }*/
            
            // File check: if file path is not found, we can't upload it
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

            // First retry loop: Storage upload
            while (!uploadSuccess && uploadAttempt < maxUploadAttempts) {
                uploadAttempt++;
                try {
                    logger(`File Uploader uploadFile ${item.zotero_key}: Uploading file to ${item.storage_path} (attempt ${uploadAttempt}/${maxUploadAttempts})`, 3);
                    // const storagePath = `${userId}/attachments/${item.file_hash}/original`;
                    // await this.uploadFileToSupabase(storagePath, blob);
                    await this.uploadFileToGCS(item.signed_upload_url, blob, {
                        userid: userId,
                        filehash: item.file_hash,
                        libraryid: item.library_id.toString(),
                        zoterokey: item.zotero_key
                    });
                    
                    
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
    private async addCompletionToBatch(item: UploadQueueItem, mimeType: string, fileSize: number, pageCount: number | null, user_id: string): Promise<void> {
        const request: CompleteUploadRequest = {
            storage_path: item.storage_path,
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
                        logger(`File Uploader: Successfully uploaded file for attachment ${batchItem.item.zotero_key} (page count: ${batchItem.request.page_count})`, 3);
                    } else {
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
     * Handles permanent failures by marking items as failed in the backend and removing them from the backend queue
     */
    private async handlePermanentFailure(item: UploadQueueItem, user_id: string, reason: string): Promise<void> {
        logger(`File Uploader: Permanent failure for ${item.zotero_key}: ${reason}`, 1);
        
        try {
            // First, notify backend of failure
            await attachmentsService.updateUploadStatus(item.file_hash, 'failed');
            
            // Error message for manual retry (only show if user has completed onboarding)
            if (store.get(hasCompletedOnboardingAtom) && !store.get(showFileStatusDetailsAtom)) {
                store.set(addOrUpdateFailedUploadMessageAtom, {
                    library_id: item.library_id,
                    zotero_key: item.zotero_key
                } as ZoteroItemReference);
            }
            
            logger(`File Uploader: Successfully marked ${item.zotero_key} as permanently failed`, 3);
            
        } catch (failError: any) {
            logger(`File Uploader: Failed to mark item as failed: ${failError.message}`, 2);
            Zotero.logError(failError);
            // Re-throw the error so callers know the operation failed
            // Item will remain in backend queue for retry
            throw failError;
        }
    }

    /**
     * Handles plan limit failures by marking items as failed in the backend first, 
     * then removing them from the backend queue
     */
    private async handlePlanLimitFailure(item: UploadQueueItem, user_id: string, reason: string): Promise<void> {
        logger(`File Uploader: Plan limit failure for ${item.zotero_key}: ${reason}`, 1);
        try {
            // First, notify backend of failure
            await attachmentsService.updateUploadStatus(item.file_hash, 'plan_limit');
            
        } catch (failError: any) {
            logger(`File Uploader: Failed to mark item as plan limit failure: ${failError.message}`, 2);
        }
    }
}


/**
 * Utility function to retry uploads by calling the backend and restarting the uploader
 */
export const retryUploadsByStatus = async (status: "failed" | "plan_limit" = "failed"): Promise<void> => {
    try {
        // check authentication status
        const isAuthenticated = store.get(isAuthenticatedAtom);
        const user = store.get(userAtom);

        if (!isAuthenticated || !user?.id) {
            logger('File Uploader: Cannot retry uploads, user not authenticated or user ID missing.', 2);
            return;
        }

        // -------- (1) Retry uploads in backend --------
        const results: FileHashReference[] = await attachmentsService.retryUploadsByStatus(status);
        logger(`File Uploader: Backend retried ${results.length} uploads.`, 3);

        // -------- (2) Restart the uploader --------
        await fileUploader.start("manual");

    } catch (error: any) {
        logger(`File Uploader: Failed to retry uploads: ${error.message}`, 1);
        Zotero.logError(error);
    }
};


/**
 * Exports a singleton instance for the file uploader.
 */
export const fileUploader = new FileUploader();
