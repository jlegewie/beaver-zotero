/**
 * FileUploader.ts
 *
 * A uploader that processes Zotero file attachments in batches using a queue. 
 * It pulls pending items from the server, uploads them concurrently (up to MAX_CONCURRENT), 
 * handles retries, and updates progress based on server status. 
 */

import PQueue from 'p-queue';
import { queueService, UploadQueueItem, PopQueueResponse, QueueStatus } from "./queueService";

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
     * Optional callback to report ongoing progress in the format (completedCount, totalCount).
     */
    private onProgressCallback?: (completed: number, total: number) => void;

    /**
     * Sets a callback for upload progress notifications.
     */
    public setProgressCallback(callback: (completed: number, total: number) => void): void {
        this.onProgressCallback = callback;
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

        // Initialize the p-queue with desired concurrency
        this.uploadQueue = new PQueue({ concurrency: this.MAX_CONCURRENT });

        // Begin processing in the background
        this.runQueue()
            .catch(error => {
                console.error('[Beaver File Uploader] Error in runQueue:', error);
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
        } catch (error) {
            console.error('[Beaver File Uploader] Error while waiting for queue to idle:', error);
        }
    }

    /**
     * Main loop that continuously pops items from the server and processes them until
     * no more items remain or the uploader is stopped.
     */
    private async runQueue(): Promise<void> {
        while (this.isRunning) {
            try {
                // Fetch up to MAX_CONCURRENT items from the server, along with the updated status
                const response: PopQueueResponse = await queueService.popQueueItems(this.MAX_CONCURRENT);
                const items = response.items;
                const status = response.status;
                console.log(`[Beaver File Uploader] Popped ${items.length} items from the queue. Status: ${JSON.stringify(status)}`);

                // Update progress immediately after popping items
                this.updateProgress(status);

                // If no items returned or pending is zero, exit the loop
                if (items.length === 0) break;

                // Add each upload task to the concurrency queue
                for (const item of items) {
                    this.uploadQueue.add(() => this.uploadFile(item));
                }

                // Wait for these uploads to finish before popping the next batch
                await this.uploadQueue.onIdle();
            } catch (error) {
                console.error('[Beaver File Uploader] runQueue encountered an error:', error);
                // Break on unexpected error to avoid infinite error loops (alternative is to retry)
                break;
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
            console.log(`[Beaver File Uploaded] Uploading file for attachment ${item.attachment_key}`);

            // Retrieve file path from Zotero
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
            const blob = new Blob([fileArrayBuffer], { type: 'application/pdf' });

            // Perform the file upload
            const response = await fetch(item.upload_url, {
                method: 'PUT',
                body: blob,
                headers: {
                    'Content-Type': 'application/pdf'
                }
            });

            if (!response.ok) {
                throw new Error(`Upload failed with status ${response.status}`);
            }

            // Mark upload as completed on the server
            await queueService.completeUpload(item.id, item.file_id, item.storage_path);
            console.log(`[Beaver File Uploaded] Successfully uploaded file for attachment ${item.attachment_key}`);

        } catch (error) {
            console.error(`[Beaver File Uploaded] Error uploading file for attachment ${item.attachment_key}:`, error);

            // If attempts are too high, treat as permanently failed
            if (item.attempts >= 3) {
                console.error(`[Beaver File Uploaded] Max upload attempts reached. Marking permanently failed for ${item.attachment_key}`);
                // TODO: call a fail endpoint
            } else {
                // Otherwise, reset the item for retry later
                try {
                    await queueService.resetUpload(item.id);
                } catch (resetError) {
                    console.error('[Beaver File Uploaded] Error resetting failed upload:', resetError);
                }
            }
        }
    }

    /**
     * Updates the internal status cache and triggers the optional onProgress callback.
     * This is called once after each pop or at intervals, as needed.
     */
    private updateProgress(status: QueueStatus): void {
        this.lastStatus = status;
        if (this.onProgressCallback) {
            const completedCount = status.completed + status.failed;
            this.onProgressCallback(completedCount, status.total);
        }
    }
}

/**
 * Exports a singleton instance for the file uploader.
 */
export const fileUploader = new FileUploader();
