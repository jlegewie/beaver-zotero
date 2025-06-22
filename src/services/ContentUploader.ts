/**
 * ContentUploader.ts
 *
 * A uploader that processes Zotero attachment content (extracted text) in batches. 
 * It reads pending content uploads from the local SQLite database,
 * handles retries, and updates progress based on local status tracking. 
 */

import PQueue from 'p-queue';
import { logger } from '../utils/logger';
import { store } from '../../react/index';
import { isAuthenticatedAtom, userAtom } from '../../react/atoms/auth';
import { attachmentsService } from './attachmentsService';
import { AttachmentRecord } from './database';
import { planFeaturesAtom } from '../../react/atoms/profile';

export type ContentUploadSessionType = 'initial' | 'background' | 'manual';

/**
 * Manages content uploads from a frontend-managed queue of pending uploads.
 */
export class ContentUploader {
    private isRunning: boolean = false;
    private contentQueue!: PQueue; // Will be initialized on start

    // upload concurrency
    private readonly MAX_CONCURRENT: number = 2;

    // upload batching
    private readonly BATCH_SIZE: number = 10;

    /**
     * Starts the content uploader if it's not already running.
     * Initializes a concurrency queue and continuously processes content uploads
     * until no more items or until stopped.
     * @param sessionType Type of upload session (default: 'background')
     */
    public async start(sessionType: ContentUploadSessionType = 'background'): Promise<void> {
        // check authentication status and plan features
        const user = store.get(userAtom);
        if (!user?.id) {
            logger('Content Uploader: No user ID found. Stopping.', 3);
            return;
        }
        if (!store.get(planFeaturesAtom).uploadContent) {
            logger('Content Uploader: Uploading content is not supported for this plan. Stopping.', 3);
            return;
        }

        // check if already running
        if (this.isRunning) {
            logger('Content Uploader: Already running. Skipping start.', 4);
            return;
        }
        this.isRunning = true;

        logger(`Content Uploader: Starting content uploader (session type: ${sessionType})`, 3);

        // Initialize the p-queue with desired concurrency
        this.contentQueue = new PQueue({ concurrency: this.MAX_CONCURRENT });

        // Begin processing in the background
        this.runQueue(user.id)
            .catch(error => {
                logger('Content Uploader: Error in runQueue: ' + error.message, 1);
                Zotero.logError(error);
                this.isRunning = false;
            });
    }

    /**
     * Stops the content uploader gracefully. 
     * No new items will be fetched, but in-flight uploads will be allowed to finish.
     */
    public async stop(): Promise<void> {
        if (!this.isRunning) {
            return;
        }

        this.isRunning = false;
        logger('Content Uploader: Stopping content uploader', 3);

        // Wait for all queued tasks to finish, if any
        try {
            await this.contentQueue.onIdle();            
        } catch (error: any) {
            logger('Content Uploader: Error while waiting for queue to idle: ' + error.message, 1);
            Zotero.logError(error);
        }
    }

    /**
     * Main loop that continuously reads items needing content upload and processes them until
     * no more items remain or the uploader is stopped.
     */
    private async runQueue(userId: string): Promise<void> {
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
                    logger('Content Uploader: Not authenticated or no user ID. Stopping.', 3);
                    this.isRunning = false;
                    break;
                }

                // If we've had too many consecutive errors, add a longer backoff
                if (consecutiveErrors > 0) {
                    logger(`Content Uploader: Backing off for ${errorBackoffTime}ms after ${consecutiveErrors} consecutive errors`, 3);
                    await new Promise(resolve => setTimeout(resolve, errorBackoffTime));
                    // Exponential backoff with max of 1 minute
                    errorBackoffTime = Math.min(errorBackoffTime * 2, 60000);
                }

                // Read attachments that need content upload
                const attachments = await this.getAttachmentsForContentUpload(userId);

                logger(`Content Uploader: Found ${attachments.length} attachments needing content upload`, 3);

                // If no items, we're done
                if (attachments.length === 0) {
                    break;
                }

                // Reset idle and error counters on successful queue read
                consecutiveErrors = 0;
                errorBackoffTime = ERROR_BACKOFF_TIME;

                // Add each upload task to the concurrency queue
                for (const attachment of attachments) {
                    this.contentQueue.add(() => this.uploadContent(attachment, userId));
                }

                // Wait for these uploads to finish before reading the next batch
                await this.contentQueue.onIdle();
            } catch (error: any) {
                logger('Content Uploader: runQueue encountered an error: ' + error.message, 1);
                Zotero.logError(error);
                
                consecutiveErrors++;
                
                // If we've hit max consecutive errors, stop the session
                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    logger(`Content Uploader: Hit ${MAX_CONSECUTIVE_ERRORS} consecutive errors, stopping session`, 2);
                    throw new Error('Max consecutive errors reached');
                }

                // Continue with backoff...
                await new Promise(resolve => setTimeout(resolve, 30000));
            }
        }

        // No more items or we've stopped. Mark as not running.
        this.isRunning = false;
        logger('Content Uploader: Finished processing content queue.', 3);
    }

    /**
     * Gets attachments that need content upload:
     * - content_upload_status = 'pending'
     * - file_hash is not null (attachment must be synced first)
     * - is a PDF attachment
     */
    private async getAttachmentsForContentUpload(userId: string): Promise<AttachmentRecord[]> {
        try {
            // Get attachments with pending content upload status
            const attachments = await Zotero.Beaver.db.getAttachmentsByContentUploadStatus(userId, 'pending');
            
            // Filter to only those with file_hash (must be synced first) and limit batch size
            const attachmentsWithFileHash = attachments
                .filter(att => att.file_hash !== null)
                .slice(0, this.BATCH_SIZE);

            // Filter to only PDF attachments that exist in Zotero
            const validAttachments: AttachmentRecord[] = [];
            for (const attachment of attachmentsWithFileHash) {
                try {
                    const item = await Zotero.Items.getByLibraryAndKeyAsync(
                        attachment.library_id, 
                        attachment.zotero_key
                    );
                    if (item && item.isPDFAttachment()) {
                        validAttachments.push(attachment);
                    }
                } catch (error) {
                    logger(`Content Uploader: Error checking item ${attachment.zotero_key}: ${error}`, 2);
                }
            }

            return validAttachments;
        } catch (error: any) {
            logger(`Content Uploader: Error getting attachments for content upload: ${error.message}`, 1);
            return [];
        }
    }

    /**
     * Uploads content for a single attachment
     */
    private async uploadContent(attachment: AttachmentRecord, userId: string): Promise<void> {
        try {
            logger(`Content Uploader: Processing content for ${attachment.zotero_key}`, 3);

            // Get the Zotero item
            const item = await Zotero.Items.getByLibraryAndKeyAsync(
                attachment.library_id, 
                attachment.zotero_key
            );
            
            if (!item || !item.isPDFAttachment()) {
                logger(`Content Uploader: Attachment not found or not a PDF attachment: ${attachment.zotero_key}`, 1);
                await this.markContentSkipped(attachment, userId);
                return;
            }

            // Extract content using attachmentText
            let textContent: string;
            try {
                textContent = await item.attachmentText;
            } catch (error: any) {
                logger(`Content Uploader: Error extracting content for ${attachment.zotero_key}: ${error.message}`, 2);
                await this.markContentSkipped(attachment, userId);
                return;
            }
            
            if (!textContent || textContent.trim() === '') {
                logger(`Content Uploader: No content available for ${attachment.zotero_key}`, 2);
                await this.markContentSkipped(attachment, userId);
                return;
            }

            // Get file modification date
            const lastModified = await this.getFileModificationDate(item);
            
            // Upload content using the existing service
            await attachmentsService.uploadFileContent(
                textContent, 
                attachment.file_hash!,
                lastModified
            );
            
            // Mark as completed
            await this.markContentCompleted(attachment, userId);
            logger(`Content Uploader: Successfully uploaded content for ${attachment.zotero_key}`, 3);
            
        } catch (error: any) {
            logger(`Content Uploader: Error uploading content for attachment ${attachment.zotero_key}: ${error.message}`, 1);
            Zotero.logError(error);
            await this.handleContentFailure(attachment, userId, error.message);
        }
    }

    /**
     * Gets the file modification date from Zotero's fulltext cache
     */
    private async getFileModificationDate(item: any): Promise<Date | null> {
        try {
            // @ts-ignore not typed
            const cacheFile = Zotero.FullText.getItemCacheFile(item);
            if (!cacheFile || !cacheFile.path) {
                return null;
            }
            
            const fileInfo = await IOUtils.stat(cacheFile.path);
            return fileInfo.lastModified ? new Date(fileInfo.lastModified) : null;


        } catch (error: any) {
            logger(`Content Uploader: Error getting file modification date: ${error.message}`, 2);
            return null;
        }
    }

    /**
     * Mark content upload as completed
     */
    private async markContentCompleted(attachment: AttachmentRecord, userId: string): Promise<void> {
        try {
            await Zotero.Beaver.db.updateAttachment(
                userId,
                attachment.library_id,
                attachment.zotero_key,
                { content_upload_status: 'completed' }
            );
        } catch (error: any) {
            logger(`Content Uploader: Error marking content as completed: ${error.message}`, 1);
            throw error;
        }
    }

    /**
     * Mark content upload as skipped (e.g., not a PDF)
     */
    private async markContentSkipped(attachment: AttachmentRecord, userId: string): Promise<void> {
        try {
            await Zotero.Beaver.db.updateAttachment(
                userId,
                attachment.library_id,
                attachment.zotero_key,
                { content_upload_status: 'skipped' }
            );
            await attachmentsService.updateFileContentStatus(attachment.file_hash!, 'skipped');
        } catch (error: any) {
            logger(`Content Uploader: Error marking content as skipped: ${error.message}`, 1);
            throw error;
        }
    }

    /**
     * Handle content upload failure
     */
    private async handleContentFailure(attachment: AttachmentRecord, userId: string, reason: string): Promise<void> {
        try {
            await Zotero.Beaver.db.updateAttachment(
                userId,
                attachment.library_id,
                attachment.zotero_key,
                { content_upload_status: 'failed' }
            );
            await attachmentsService.updateFileContentStatus(attachment.file_hash!, 'failed');
            logger(`Content Uploader: Marked content upload as failed for ${attachment.zotero_key}: ${reason}`, 2);
        } catch (error: any) {
            logger(`Content Uploader: Error marking content upload as failed: ${error.message}`, 1);
            throw error;
        }
    }
}

/**
 * Exports a singleton instance for the content uploader.
 */
export const contentUploader = new ContentUploader();