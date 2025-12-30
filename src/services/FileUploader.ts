/**
 * FileUploader.ts
 *
 * A uploader that processes Zotero file attachments in batches using a backend queue. 
 * It reads pending items from the backend upload queue service,
 * handles retries, and updates progress based on backend queue status. 
 */

import PQueue from 'p-queue';
import { getPDFPageCount, getPDFPageCountFromData } from '../../react/utils/pdfUtils';
import { logger } from '../utils/logger';
import { store } from '../../react/store';
import { isAuthenticatedAtom, userAtom, userIdAtom } from '../../react/atoms/auth';
import { attachmentsService, UploadQueueItem, CompleteUploadRequest, UploadErrorCode, ErrorCode, FailureStatus } from './attachmentsService';
import { isFileUploaderRunningAtom, isFileUploaderFailedAtom, fileUploaderBackoffUntilAtom } from '../../react/atoms/sync';
import { hasCompletedOnboardingAtom, planFeaturesAtom } from '../../react/atoms/profile';
import { FileHashReference, ZoteroItemReference } from '../../react/types/zotero';
import { supabase } from "./supabaseClient";
import { addOrUpdateFailedUploadMessageAtom } from '../../react/utils/popupMessageUtils';
import { showFileStatusDetailsAtom, zoteroServerCredentialsErrorAtom, zoteroServerDownloadErrorAtom } from '../../react/atoms/ui';
import { getMimeType, getMimeTypeFromData } from '../utils/zoteroUtils';
import { isAttachmentOnServer, getAttachmentDataInMemory } from '../utils/webAPI';
import { PlanFeatures } from '../../react/types/profile';

/**
 * Manages file uploads from a backend-managed queue of pending uploads.
 */
export class FileUploader {
    private isRunning: boolean = false;
    private uploadQueue!: PQueue; // Will be initialized on start

    // upload concurrency
    private readonly MAX_CONCURRENT: number = 5;

    // Queue refill buffer: Maintain a small backlog beyond active uploads to ensure
    // continuous throughput. With MAX_CONCURRENT=5 and REFILL_BUFFER=5, we refill when
    // the queue drops below 10 items
    private readonly REFILL_BUFFER: number = 5;

    // queue reads
    private readonly BATCH_SIZE: number = 25;
    private readonly VISIBILITY_TIMEOUT_SECONDS: number = 300; // 5 minutes timeout for backend queue reads
    private readonly EMPTY_QUEUE_POLL_DELAY: number = 1000;    // 1 second delay when backend queue is empty

    // completion batching
    private completionBatch: Array<{ item: UploadQueueItem, request: CompleteUploadRequest }> = [];
    private batchTimer: NodeJS.Timeout | null = null;
    private readonly BATCH_SEND_SIZE: number = 5;       // Send after 5 completions
    private readonly BATCH_SEND_TIMEOUT: number = 1500; // Send after 1.5 seconds

    private getQueueLoad(): number {
        if (!this.uploadQueue) {
            return 0;
        }
        return this.uploadQueue.size + this.uploadQueue.pending;
    }

    private getRefillThreshold(): number {
        return Math.min(this.BATCH_SIZE, this.MAX_CONCURRENT + this.REFILL_BUFFER);
    }

    /**
     * Check if file size exceeds plan limit
     * @returns Error message if exceeded, null if within limit
     */
    private checkFileSizeLimit(fileSize: number, planFeatures: PlanFeatures): string | null {
        const fileSizeInMB = fileSize / 1024 / 1024;
        const sizeLimit = planFeatures.uploadFileSizeLimit;
        logger(`File Uploader: File size of ${fileSizeInMB.toFixed(2)}MB and limit of ${sizeLimit}MB`, 4);
        if (fileSizeInMB > sizeLimit) {
            return `File size of ${fileSizeInMB.toFixed(2)}MB exceeds ${sizeLimit}MB`;
        }
        return null;
    }

    /**
     * Waits for queue capacity to drop below the specified limit
     * @param limit Maximum queue load (size + pending) threshold
     * @param timeoutMs Timeout in milliseconds (default: 120000)
     */
    private async waitForQueueCapacity(limit: number, timeoutMs: number = 120000): Promise<void> {
        if (!this.uploadQueue || !this.isRunning) {
            return;
        }

        const currentLoad = this.getQueueLoad();
        if (currentLoad < limit) {
            return;
        }

        logger(`File Uploader Queue: Waiting for capacity (current: ${currentLoad}, limit: ${limit})`, 4);
        const startTime = Date.now();

        await new Promise<void>((resolve) => {
            let timeoutHandle: NodeJS.Timeout | null = null;

            const checkCapacity = () => {
                const load = this.getQueueLoad();
                // Only log capacity checks if verbose logging is desired
                // logger(`File Uploader Queue: checking capacity (load: ${load}, limit: ${limit})`, 4);
                
                if (!this.isRunning || load < limit) {
                    logger(`File Uploader Queue: Capacity available after ${Date.now() - startTime}ms`, 4);
                    cleanup();
                    resolve();
                }
            };

            const cleanup = () => {
                if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                    timeoutHandle = null;
                }
                if (!this.uploadQueue) {
                    return;
                }
                this.uploadQueue.off('next', checkCapacity);
                this.uploadQueue.off('idle', checkCapacity);
                this.uploadQueue.off('error', checkCapacity);
            };

            // Set timeout as a safety net
            timeoutHandle = setTimeout(() => {
                cleanup();
                logger(`File Uploader: Queue capacity wait timed out after ${timeoutMs}ms`, 2);
                resolve();
            }, timeoutMs);

            this.uploadQueue.on('next', checkCapacity);
            this.uploadQueue.on('idle', checkCapacity);
            this.uploadQueue.on('error', checkCapacity);

            checkCapacity();
        });
    }

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
        store.set(fileUploaderBackoffUntilAtom, null);
        
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

        // Empty read tracking to avoid unnecessary backend calls
        const MAX_EMPTY_READS = 0; // Don't retry after getting 0 items
        let consecutiveEmptyReads = 0;

        // Track whether last fetch was partial (indicates no more items in backend queue)
        let lastFetchWasPartial = false;

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
                    const nextRetryAt = Date.now() + errorBackoffTime;
                    store.set(fileUploaderBackoffUntilAtom, nextRetryAt);
                    await new Promise(resolve => setTimeout(resolve, errorBackoffTime));
                    // Exponential backoff with max of 1 minute
                    errorBackoffTime = Math.min(errorBackoffTime * 2, 60000);
                }

                // Ensure we do not exceed the maximum queue load before reading more items
                const queueLoad = this.getQueueLoad();
                const refillThreshold = this.getRefillThreshold();

                // If last fetch was partial (got fewer items than requested), we know there are
                // no more items in the backend queue. Only fetch again when queue is completely empty.
                const effectiveThreshold = lastFetchWasPartial ? 0 : refillThreshold;

                if (queueLoad > effectiveThreshold) {
                    await this.waitForQueueCapacity(effectiveThreshold + 1);
                    continue;
                }

                const remainingCapacity = this.BATCH_SIZE - queueLoad;

                // Log queue metrics for observability
                const thresholdInfo = lastFetchWasPartial ? `${effectiveThreshold} (partial fetch)` : `${refillThreshold}`;
                logger(`File Uploader Queue: Queue load: ${queueLoad}/${thresholdInfo}, fetching: ${remainingCapacity}`, 4);

                // Read items from backend queue with visibility timeout
                const response = await attachmentsService.readUploadQueue(
                    this.VISIBILITY_TIMEOUT_SECONDS,
                    remainingCapacity
                );
                const items = response.items;

                logger(`File Uploader Queue: Read ${items.length} items from backend queue`, 3);

                // Track if this was a partial fetch (got fewer items than requested)
                // This indicates there are no more items in the backend queue
                lastFetchWasPartial = items.length < remainingCapacity;
                if (lastFetchWasPartial && items.length > 0) {
                    logger(`File Uploader Queue: Partial fetch detected (${items.length}/${remainingCapacity}), will only refill when queue is empty`, 4);
                }

                // If no items, handle based on queue state and retry count
                if (items.length === 0) {
                    consecutiveEmptyReads++;
                    
                    const currentQueueLoad = this.getQueueLoad();
                    
                    // If queue is empty and we've already tried once, stop
                    if (currentQueueLoad === 0 && consecutiveEmptyReads > MAX_EMPTY_READS) {
                        logger('File Uploader Queue: No items found after retry, stopping', 3);
                        break;
                    }
                    
                    // If queue has items, wait for them to finish before retrying
                    if (currentQueueLoad > 0) {
                        logger(`File Uploader Queue: No new items, waiting for ${currentQueueLoad} in-flight uploads to finish`, 3);
                        await this.uploadQueue.onIdle();
                    }
                    
                    // Small delay before next check
                    await new Promise(resolve => setTimeout(resolve, this.EMPTY_QUEUE_POLL_DELAY));
                    continue;
                }

                // Reset counters on successful queue read with items
                consecutiveEmptyReads = 0;
                consecutiveErrors = 0;
                errorBackoffTime = ERROR_BACKOFF_TIME;
                store.set(fileUploaderBackoffUntilAtom, null);

                // Add each upload task to the concurrency queue
                for (const item of items) {
                    this.uploadQueue.add(() => this.uploadFile(item, user.id));
                }

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

        try {
            await this.uploadQueue.onIdle();
        } catch (error: any) {
            logger('File Uploader Queue: Error while waiting for queue to idle: ' + error.message, 1);
            Zotero.logError(error);
        }

        // Mark all items in the queue as failed
        await this.flushCompletionBatch();

        // No more items or we've stopped. Mark as not running.
        this.isRunning = false;
        logger('File Uploader Queue: Finished processing queue.', 3);
        store.set(isFileUploaderRunningAtom, false);
        store.set(fileUploaderBackoffUntilAtom, null);
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

    private async uploadFileToGCS(signedUrl: string, blob: Blob, mimeType: string, metadata: Record<string, string>): Promise<void> {
        const headers = {
            'Content-Type': mimeType,
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
        const context: { [key: string]: any } = {};
        context.library_id = item.library_id;
        context.zotero_key = item.zotero_key;
        context.file_hash = item.file_hash;
        const uploadStartTime = Date.now();

        try {
            logger(`File Uploader uploadFile ${item.zotero_key}: Starting upload process`, 4);
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
                logger(`File Uploader uploadFile ${item.library_id}-${item.zotero_key}: Attachment not found`, 1);
                await this.handleUploadFailure(
                    item,
                    'failed_user', // permanent failure
                    'attachment_not_found',
                    `Attachment not found (library_id: ${item.library_id}, zotero_key: ${item.zotero_key})`
                );
                return;
            }

            // Check if file exists locally
            const useLocalFile = await attachment.fileExists();
            context.useLocalFile = useLocalFile;
            
            // Check if file exists on server
            const validZoteroCredentials = Boolean(Zotero.Users.getCurrentUserID()) && Boolean(await Zotero.Sync.Data.Local.getAPIKey())
            context.validZoteroCredentials = validZoteroCredentials;
            const isServerFile = isAttachmentOnServer(attachment);
            const useServerFile = !useLocalFile && isServerFile && validZoteroCredentials;
            context.useServerFile = useServerFile;

            if (!useLocalFile && !useServerFile) {
                const message = `File not available locally or on server (useLocalFile: ${useLocalFile}, useServerFile: ${useServerFile}, validZoteroCredentials: ${validZoteroCredentials})`;
                logger(`File Uploader uploadFile ${item.zotero_key}: ${message}`, 1);

                // Check if authorization error
                const isAuthorizationError = !useLocalFile && isServerFile && !validZoteroCredentials;
                
                // Determine specific error code based on authorization error
                const errorCode: UploadErrorCode = isAuthorizationError ? 'zotero_credentials_invalid' : 'file_unavailable';
                
                // Handle upload failure
                await this.handleUploadFailure(
                    item,
                    isAuthorizationError ? 'failed_upload' : 'failed_user', // handle as temporary failure if authorization error
                    errorCode,
                    message
                );

                // Set authorization error flag to show user message if authorization error
                if(isAuthorizationError) store.set(zoteroServerCredentialsErrorAtom, true);
                return;
            }

            // File data
            let fileArrayBuffer: Uint8Array | null = null;
            let mimeType: string = '';
            let pageCount: number | null = null;
            let fileSize: number | null = null;
            const planFeatures = store.get(planFeaturesAtom);

            // File exists locally
            if (useLocalFile) {
                logger(`File Uploader uploadFile ${item.zotero_key}: Using local file`, 3);

                // Get the file path for the attachment
                const filePath: string | null = await attachment.getFilePathAsync() || null;
                context.hasFilePath = Boolean(filePath)
                
                // File check: if file path is not found, we can't upload it
                if (!filePath) {
                    logger(`File Uploader uploadFile ${item.library_id}-${item.zotero_key}: File path not found`, 1);
                    await this.handleUploadFailure(
                        item,
                        'failed_user', // permanent failure
                        'file_unavailable',
                        `File path not found for local upload (library_id: ${item.library_id}, zotero_key: ${item.zotero_key})`
                    );
                    return;
                }

                // Early size check before expensive reads/parsing
                fileSize = await Zotero.Attachments.getTotalFileSize(attachment);
                context.fileSize = fileSize;
                if (fileSize) {
                    const sizeError = this.checkFileSizeLimit(fileSize, planFeatures);
                    if (sizeError) {
                        logger(`File Uploader: ${sizeError}`, 1);
                        await this.handleUploadFailure(item, 'plan_limit', 'plan_limit_file_size', sizeError);
                        return;
                    }
                }

                // File metadata (after size guard)
                mimeType = await getMimeType(attachment, filePath);
                context.mimeType = mimeType;
                pageCount = mimeType === 'application/pdf' ? await getPDFPageCount(attachment) : null;
                context.pageCount = pageCount;

                // Read file content
                try {
                    const readStart = Date.now();
                    fileArrayBuffer = await IOUtils.read(filePath);
                    logger(`File Uploader uploadFile ${item.zotero_key}: File read completed in ${Date.now() - readStart}ms`, 4);
                } catch (readError: any) {
                    logger(`File Uploader uploadFile ${item.library_id}-${item.zotero_key}: Error reading file`, 1);
                    Zotero.logError(readError);
                    await this.handleUploadFailure(
                        item,
                        'failed_user', // permanent failure
                        'unable_to_read_file',
                        `Error reading file for local upload (library_id: ${item.library_id}, zotero_key: ${item.zotero_key})`
                    );
                    return;
                }

                // If page count is still null for PDFs, try naive method with file data
                // if (mimeType === 'application/pdf' && !pageCount && fileArrayBuffer) {
                //     try {
                //         pageCount = naivePdfPageCount(fileArrayBuffer);
                //     } catch (e) {
                //         logger(`File Uploader uploadFile ${item.zotero_key}: Error getting page count using naive method`, 1);
                //     }
                //     if (pageCount) {
                //         logger(`File Uploader uploadFile ${item.zotero_key}: Got page count ${pageCount} using naive method`, 3);
                //     }
                // }

            // File exists on server
            } else if (useServerFile) {
                logger(`File Uploader uploadFile ${item.zotero_key}: Using server file`, 3);

                // Download the file data to memory
                try {
                    const downloadStart = Date.now();
                    fileArrayBuffer = await getAttachmentDataInMemory(attachment);
                    logger(`File Uploader uploadFile ${item.zotero_key}: Server download completed in ${Date.now() - downloadStart}ms`, 4);
                } catch (downloadError: any) {
                    const errorMessage = `Failed to download from Zotero server: ${downloadError.message || String(downloadError)}`;
                    logger(`File Uploader uploadFile ${item.zotero_key}: ${errorMessage}`, 1);
                    
                    // Determine if this is a permanent failure
                    const isPermanent = 
                        downloadError.message?.includes('File not found on server (404)') || 
                        downloadError.message?.includes('Downloaded file is empty');
                    
                    await this.handleUploadFailure(
                        item,
                        isPermanent ? 'failed_user' : 'failed_upload', // permanent if 404 (not found) or empty file
                        'server_download_failed',
                        errorMessage
                    );
                    if(!isPermanent) store.set(zoteroServerDownloadErrorAtom, true);
                    return;
                }
                
                // File size (early exit before PDF parsing)
                fileSize = fileArrayBuffer.length;
                context.fileSize = fileSize;
                if (fileSize) {
                    const sizeError = this.checkFileSizeLimit(fileSize, planFeatures);
                    if (sizeError) {
                        logger(`File Uploader: ${sizeError}`, 1);
                        await this.handleUploadFailure(item, 'plan_limit', 'plan_limit_file_size', sizeError);
                        return;
                    }
                }

                // File metadata
                mimeType = getMimeTypeFromData(attachment, fileArrayBuffer);
                context.mimeType = mimeType;
                pageCount = mimeType === 'application/pdf' ? await getPDFPageCountFromData(fileArrayBuffer) : null;
                context.pageCount = pageCount;

            }

            logger(`File Uploader uploadFile ${item.zotero_key}: File metadata: mimeType: ${mimeType}, fileSize: ${fileSize}, pageCount: ${pageCount}`, 3);

            // File array buffer check
            if (!fileArrayBuffer || !mimeType || !fileSize || (!pageCount && mimeType === 'application/pdf')) {
                const fileStatus = useLocalFile ? 'local' : 'server';
                const message = `Unable to get file data for ${fileStatus} upload: mimeType: ${mimeType}, fileSize: ${fileSize}, pageCount: ${pageCount}`;
                logger(`File Uploader uploadFile ${item.library_id}-${item.zotero_key}: ${message}`, 1);
                await this.handleUploadFailure(
                    item,
                    'failed_user', // permanent failure
                    'invalid_file_metadata',
                    message
                );
                if (useServerFile) store.set(zoteroServerDownloadErrorAtom, true);
                return;
            }

            // Create a blob from the file array buffer with the mime type
            const blob = new Blob([new Uint8Array(fileArrayBuffer)], { type: mimeType });

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
                    
                    const gcsUploadStart = Date.now();
                    await this.uploadFileToGCS(item.signed_upload_url, blob, item.mime_type, {
                        userid: userId,
                        filehash: item.file_hash,
                        libraryid: item.library_id.toString(),
                        zoterokey: item.zotero_key
                    });
                    logger(`File Uploader uploadFile ${item.zotero_key}: GCS upload completed in ${Date.now() - gcsUploadStart}ms`, 4);
                    
                    
                    uploadSuccess = true;
                    logger(`File Uploader uploadFile ${item.zotero_key}: Storage upload successful on attempt ${uploadAttempt}. Total time: ${Date.now() - uploadStartTime}ms`, 3);

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
            const reason = error instanceof Error ? error.message : String(error) || "Unknown error";
            const contextString = JSON.stringify(context);
            logger(`File Uploader uploadFile ${item.zotero_key}: Error uploading file: ${reason} | context=${contextString}`, 1);
            Zotero.logError(error);

            // Treat as temporary failed with message for manual retry
            await this.handleUploadFailure(
                item,
                'failed_upload', // temporary failure
                'storage_upload_failed',
                `${reason} | context=${contextString}`
            );
        }
    }

    /**
     * Uploads a temporary file to a provided URL and marks it as completed via the temporary upload endpoint.
     * This is separate from the queue-based upload system and is designed for temporary file uploads.
     * 
     * @param filePath Absolute path to the file to upload
     * @param uploadUrl Signed upload URL to upload the file to
     * @param storagePath Storage path where the file will be stored
     * @param fileHash Hash of the file being uploaded
     * @param mimeType MIME type of the file
     * @param uploadMetadata Optional metadata to include in the upload headers
     * @returns Promise that resolves when upload and completion are finished
     */
    public async uploadTemporaryFile(
        filePath: string,
        uploadUrl: string,
        storagePath: string,
        fileHash: string,
        mimeType: string,
        uploadMetadata?: Record<string, string>
    ): Promise<void> {
        logger(`File Uploader Temporary: Starting temporary upload for ${filePath}`, 3);

        // Check authentication
        const userId = store.get(userIdAtom);
        if (!userId) {
            throw new Error('No user ID found');
        }

        // Read file content
        let fileArrayBuffer: Uint8Array;
        let fileSize: number;
        try {
            fileArrayBuffer = await IOUtils.read(filePath);
            fileSize = fileArrayBuffer.length;
        } catch (readError: any) {
            logger(`File Uploader Temporary: Error reading file ${filePath}`, 1);
            throw new Error(`Error reading file: ${readError.message}`);
        }

        // Get page count for PDFs
        let pageCount: number | null = null;
        if (mimeType === 'application/pdf') {
            try {
                // We need a Zotero item to get page count, so this is optional for temporary uploads
                pageCount = null; // Could be enhanced later if needed
            } catch (error) {
                logger(`File Uploader Temporary: Could not get page count for PDF`, 3);
            }
        }

        // Create blob from file content
        const blob = new Blob([new Uint8Array(fileArrayBuffer)], { type: mimeType });

        // Upload with retry logic
        let uploadSuccess = false;
        let uploadAttempt = 0;
        const maxUploadAttempts = 3;

        while (!uploadSuccess && uploadAttempt < maxUploadAttempts) {
            uploadAttempt++;
            try {
                logger(`File Uploader Temporary: Uploading file (attempt ${uploadAttempt}/${maxUploadAttempts})`, 3);
                
                await this.uploadFileToGCS(uploadUrl, blob, mimeType, uploadMetadata || {});
                
                uploadSuccess = true;
                logger(`File Uploader Temporary: Upload successful on attempt ${uploadAttempt}`, 3);

            } catch (uploadError: any) {
                logger(`File Uploader Temporary: Upload error on attempt ${uploadAttempt}: ${uploadError.message}`, 2);
                
                if (uploadAttempt < maxUploadAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 2000 * uploadAttempt));
                }
            }
        }

        if (!uploadSuccess) {
            throw new Error(`Failed to upload file after ${maxUploadAttempts} attempts`);
        }

        // Mark as completed via temporary upload endpoint
        try {
            const result = await attachmentsService.markTemporaryUploadCompleted(
                storagePath,
                fileHash,
                mimeType,
                fileSize,
                pageCount
            );
            
            if (!result.upload_completed) {
                throw new Error(`Backend failed to mark temporary upload as completed: ${result.error}`);
            }
            
            logger(`File Uploader Temporary: Successfully marked temporary upload as completed`, 3);
        } catch (completionError: any) {
            logger(`File Uploader Temporary: Failed to mark temporary upload as completed: ${completionError.message}`, 1);
            throw new Error(`Upload succeeded but completion failed: ${completionError.message}`);
        }

        logger(`File Uploader Temporary: Temporary upload completed successfully`, 3);
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

        // If batch flush failed after all retries, mark all items as temporary failed
        if (!batchSuccess) {
            logger(`File Uploader: Failed to flush batch after ${maxBatchAttempts} attempts, marking all items as temporary failed`, 1);
            
            // Mark each item in the batch as temporary failed
            for (const batchItem of batchToSend) {
                try {
                    await this.handleUploadFailure(
                        batchItem.item,
                        'failed_upload', // temporary failure
                        'completion_failed',
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
     * Handles upload failures by marking items as failed or failed_user in the backend and removing them from the backend queue
     * 
     * User can retry temporary failures manually.
     */
    private async handleUploadFailure(
        item: UploadQueueItem,
        status: FailureStatus,
        errorCode: ErrorCode,
        reason?: string
    ): Promise<void> {
        logger(`File Uploader: Failed upload. Updating status to ${status} for ${item.zotero_key} with error code ${errorCode}: ${reason}`, 1);
        
        try {
            // Report failure to backend with appropriate status
            await attachmentsService.reportFileUploadFailed(
                item.file_hash,
                status,
                errorCode,
                reason
            );
            
            // Error message for manual retry (only show if user has completed onboarding)
            if (status === 'failed_upload' && store.get(hasCompletedOnboardingAtom) && !store.get(showFileStatusDetailsAtom)) {
                store.set(addOrUpdateFailedUploadMessageAtom, {
                    library_id: item.library_id,
                    zotero_key: item.zotero_key
                } as ZoteroItemReference);
            }
            
            logger(`File Uploader: Successfully marked ${item.zotero_key} as ${status} upload failed (status: ${status})`, 3);
            
        } catch (failError: any) {
            logger(`File Uploader: Failed to mark item as ${status} upload failed (status: ${status}): ${failError.message}`, 2);
            Zotero.logError(failError);
            // Re-throw the error so callers know the operation failed
            // Item will remain in backend queue for retry
            throw failError;
        }
    }
}


/**
 * Utility function to retry uploads by calling the backend and restarting the uploader
 * @param resetAll If true, retry all failed uploads for the user, including 'failed_user' status
 */
export const retryUploads = async (resetAll: boolean = false): Promise<void> => {
    try {
        // check authentication status
        const isAuthenticated = store.get(isAuthenticatedAtom);
        const user = store.get(userAtom);

        if (!isAuthenticated || !user?.id) {
            logger('File Uploader: Cannot retry uploads, user not authenticated or user ID missing.', 2);
            return;
        }

        // -------- (1) Retry uploads in backend --------
        const results: FileHashReference[] = await attachmentsService.retryUploads(resetAll);
        logger(`File Uploader: Backend retried ${results.length} uploads.`, 3);
        store.set(zoteroServerDownloadErrorAtom, false);
        store.set(zoteroServerCredentialsErrorAtom, false);

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
