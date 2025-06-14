import PQueue from 'p-queue';
import { v4 as uuidv4 } from 'uuid';
import { uploadQueueStatusAtom, UploadQueueSession } from '../../react/atoms/sync';
import { attachmentsService } from './attachmentsService';
import { store } from '../../react/index';
import { UploadQueueRecord } from './database';
import { logger } from 'src/utils/logger';
import { isAuthenticatedAtom, userAtom } from '../../react/atoms/auth';
import { planFeaturesAtom } from '../../react/atoms/profile';

const BATCH_SIZE = 100;
const MIN_QUEUE_SIZE = 10;
const MAX_CONCURRENCY = 5;
const BATCH_SIZE_QUEUE_READ = 1000;
const VISIBILITY_TIMEOUT: number = 15;

const QUEUE_STATUS_INITIAL = {
    sessionId: '', // remove
    sessionType: 'initial',   // remove
    startTime: new Date().toISOString(),
    status: 'in_progress',
    pending: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    currentFile: null
} as UploadQueueSession;


export class SimplifiedFileUploader {
    private queue = new PQueue({ concurrency: MAX_CONCURRENCY });
    private isRunning: boolean = false;
    private signedUrlMap = new Map<string, { url: string; expiresAt: Date }>();
    private allItems: UploadQueueRecord[] = [];
    private user_id: string | null = null;

    /**
     * Checks if the user is valid
     * @returns True if the user is valid, false otherwise
     */
    private async isUserValid() {
        const user = store.get(userAtom);
        return user && user.id === this.user_id && store.get(planFeaturesAtom).uploadFiles && store.get(isAuthenticatedAtom);
    }

    private async readQueueItems(limit: number = BATCH_SIZE_QUEUE_READ) {
        const items: UploadQueueRecord[] = await Zotero.Beaver.db.readQueueItems(
            this.user_id || '',
            limit,
            3,
            VISIBILITY_TIMEOUT
        );
        return items;
    }
    
    /**
     * Starts the upload process
     * @param items The items to upload
     */
    async startUpload(items: UploadQueueRecord[] | null) {
        // check if already running
        if (this.isRunning) {
            logger('Beaver File Uploader: Already running. Updating session instead.', 4);
            return;
        }
        // set items
        this.allItems = items ? [...items] : await this.readQueueItems();
        if (this.allItems.length === 0) {
            logger('Beaver File Uploader: No items to upload', 4);
            return;
        }

        // set running and update status
        this.isRunning = true;
        store.set(uploadQueueStatusAtom, {
            ...QUEUE_STATUS_INITIAL,
            pending: this.allItems.length
        });

        // Get user ID from jotai store
        this.user_id = store.get(userAtom)?.id || '';
        if (!this.isUserValid()) {
            throw new Error('User ID not found');
        }
        
        // Prime initial batch of signed URLs
        await this.fetchNextUrlBatch();
        
        // Add all upload tasks to queue
        for (const item of this.allItems) {
            this.queue.add(() => this.uploadItem(item));
        }
        
        // Dynamic preloading of next signed URL batch
        this.queue.on('next', async () => {
            if (this.queue.size < MIN_QUEUE_SIZE && this.signedUrlMap.size < this.allItems.length) {
                await this.fetchNextUrlBatch();
            }
            // Check user authentication status
            if(!this.isUserValid()) {
                logger('SimplifiedFileUploader: User not valid, pausing queue', 1);
                this.queue.pause();
                return;
            }
        });
        
        // Completion and error events
        this.queue.on('completed', async (result: { taskItem: UploadQueueRecord; taskSuccess: boolean }) => {
            if (result.taskSuccess) {
                await this.markUploadCompleted(result.taskItem, 'application/pdf');
            } else {
                this.updateStatus('skipped');
                logger(`Beaver File Uploader: Upload task for ${result.taskItem.zotero_key} reported as not successful by uploadToStorage but did not throw. Marked as skipped.`, 2);
            }
        });

        // this.queue.on('error', async (error, item: UploadQueueRecord) => {
        //     this.updateStatus('failed');
        // });
        
        // when queue is idle, update status
        this.queue.onIdle().then(async () => {
            store.set(uploadQueueStatusAtom, (current) => current && {
                ...current,
                status: 'completed',
                currentFile: null
            });
            // read next batch of items
            const newItems = await this.readQueueItems();
            if(newItems.length > 0) {
                this.allItems.push(...newItems);
                for (const item of newItems) {
                    this.queue.add(() => this.uploadItem(item));
                }
                this.fetchNextUrlBatch();
                store.set(uploadQueueStatusAtom, (current) => current && {
                    ...current,
                    pending: this.allItems.length
                });
                this.queue.start();
            } else {
                this.isRunning = false;
            }
        });
    }
    
    /**
     * Fetches the next batch of upload URLs from the backend for items in allItems
     * that don't have a valid, non-expired URL in signedUrlMap.
     */
    private async fetchNextUrlBatch() {
        const hashesToFetch = new Set<string>();

        // Iterate through allItems to find unique file_hashes that need a new URL
        for (const item of this.allItems) {
            if (!item.file_hash) {
                continue;
            }

            const cachedUrlEntry = this.signedUrlMap.get(item.file_hash);
            let isExpired = true;

            if (cachedUrlEntry) {
                const safetyBuffer = 30 * 60 * 1000; // 30 minutes in milliseconds
                if (new Date().getTime() < cachedUrlEntry.expiresAt.getTime() - safetyBuffer) {
                    isExpired = false;
                } else {
                    // URL is expired or close to expiring, remove it from the map
                    this.signedUrlMap.delete(item.file_hash);
                }
            }

            // If the URL is expired (or was never fetched) and we still need more hashes for the current batch
            if (isExpired && hashesToFetch.size < BATCH_SIZE) {
                hashesToFetch.add(item.file_hash);
            }
        }

        if (hashesToFetch.size === 0) {
            // No new URLs to fetch based on the current state of allItems and signedUrlMap
            return;
        }

        const uniqueFileHashes = Array.from(hashesToFetch);
        
        try {
            const signedUrls = await attachmentsService.getUploadUrls(uniqueFileHashes);
            
            // Cache successfully fetched URLs with a 90-minute expiration
            const expiresAt = new Date(Date.now() + 90 * 60 * 1000);
            for (const [fileHash, url] of Object.entries(signedUrls)) {
                if (url) { // Ensure the URL is valid
                    this.signedUrlMap.set(fileHash, { url: url as string, expiresAt });
                } else {
                    logger(`Beaver File Uploader: Received no URL for hash ${fileHash}`, 2);
                }
            }
        } catch (error) {
            logger(`Beaver File Uploader: Error fetching signed URLs: ${error instanceof Error ? error.message : String(error)}`, 1);
            // Depending on the error, some hashes might not have their URLs fetched.
            // These will be picked up in subsequent calls to fetchNextUrlBatch or fail during uploadItem.
        }
    }
    
    /**
     * Uploads an item to s3
     * @param item The item to upload
     * @returns The uploaded item
     */
    private async uploadItem(item: UploadQueueRecord) {
        try {
            const uploadUrl = await this.getUploadUrl(item);
            return await attachmentsService.uploadToStorage(item, uploadUrl);
        } catch (err) {
            await this.handlePermanentFailure(item, err instanceof Error ? err.message : 'Unknown error');
            throw err;
        }
    }

    /**
     * Gets the s3 upload URL for an item from the cache or backend
     * @param item The item to get the upload URL for
     * @returns The upload URL
     */
    private async getUploadUrl(item: UploadQueueRecord) {
        // Check cache first with 30-minute safety buffer
        const cached = this.signedUrlMap.get(item.file_hash);
        if (cached) {
            const safetyBuffer = 30 * 60 * 1000; // 30 minutes in milliseconds
            if (new Date().getTime() < cached.expiresAt.getTime() - safetyBuffer) {
                return cached.url;
            } else {
                // Remove expired URL from cache
                this.signedUrlMap.delete(item.file_hash);
            }
        }

        // If not in cache or expired, fetch new URL
        const uploadUrls = await attachmentsService.getUploadUrls([item.file_hash]);
        if (!uploadUrls || !uploadUrls[item.file_hash]) {
            throw new Error('Upload item not found');
        }

        // Cache the new URL with 90-minute expiration
        const expiresAt = new Date(Date.now() + 90 * 60 * 1000);
        this.signedUrlMap.set(item.file_hash, { 
            url: uploadUrls[item.file_hash], 
            expiresAt 
        });

        return uploadUrls[item.file_hash];
    }
    
    /**
     * Updates the status of the upload queue
     * @param type The type of status to update ('completed' or 'failed')
     */
    private updateStatus(type: 'completed' | 'failed' | 'skipped') {
        store.set(uploadQueueStatusAtom, (current) => current && {
            ...current,
            [type]: (current[type] || 0) + 1,
            pending: (current.pending || 1) - 1,
        });
    }

    /**
     * Marks upload as completed in backend first, then updates local state only if successful
     */
    private async markUploadCompleted(item: UploadQueueRecord, mimeType: string): Promise<void> {
        try {
            // First, notify backend of completion
            await attachmentsService.markUploadCompleted(item.file_hash, mimeType, item.page_count);

            // Only if backend call succeeds, update local state and cleanup
            await Zotero.Beaver.db.completeQueueItem(this.user_id || '', item.file_hash);

            logger(`Beaver File Uploader: Successfully uploaded file for attachment ${item.zotero_key} (page count: ${item.page_count})`, 3);
            
            // Update local state
            this.updateStatus('completed');
            
        } catch (error: any) {
            logger(`Beaver File Uploader: Error marking upload as completed: ${error.message}`, 1);
            Zotero.logError(error);
            // Re-throw the error so callers know the completion marking failed
            throw error;
        }
    }

    /**
     * Handles permanent failures by marking items as failed in the backend first, 
     * then in the local database only if backend update succeeds
     */
    private async handlePermanentFailure(item: UploadQueueRecord, reason: string): Promise<void> {
        logger(`Beaver File Uploader: Permanent failure for ${item.zotero_key}: ${reason}`, 1);
        
        try {
            // First, notify backend of failure
            await attachmentsService.markUploadFailed(item.file_hash);
            
            // Only if backend call succeeds, update local state
            await Zotero.Beaver.db.failQueueItem(this.user_id || '', item.file_hash);
            
            // Update local state
            this.updateStatus('failed');
            
            logger(`Beaver File Uploader: Successfully marked ${item.zotero_key} as permanently failed`, 3);
            
        } catch (failError: any) {
            logger(`Beaver File Uploader: Failed to mark item as failed (will retry later): ${failError.message}`, 2);
            Zotero.logError(failError);
            // Don't update local state or cleanup - this means the item will be retried later
        }
    }
}
