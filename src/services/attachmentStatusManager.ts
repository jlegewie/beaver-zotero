import { attachmentsService, AttachmentStatusResponse } from "../services/attachmentsService";
import { ZoteroItemReference } from "../../react/types/zotero";

class AttachmentStatusManager {
    private cache = new Map<string, AttachmentStatusResponse>();
    private pendingRequests = new Map<string, Promise<AttachmentStatusResponse>>();

    /**
     * Generate cache key from library ID and zotero key
     */
    private getCacheKey(libraryId: number, zoteroKey: string): string {
        return `${libraryId}-${zoteroKey}`;
    }

    /**
     * Get attachment status with caching and deduplication
     * @param libraryId Zotero library ID
     * @param zoteroKey Zotero key of the attachment
     * @returns Promise with the attachment status response
     */
    async getAttachmentStatus(libraryId: number, zoteroKey: string): Promise<AttachmentStatusResponse> {
        const cacheKey = this.getCacheKey(libraryId, zoteroKey);

        // Check memory cache first
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey)!;
        }

        // Deduplicate concurrent requests
        if (this.pendingRequests.has(cacheKey)) {
            return this.pendingRequests.get(cacheKey)!;
        }

        // Fetch from backend
        const request = attachmentsService.getAttachmentStatus(libraryId, zoteroKey);
        this.pendingRequests.set(cacheKey, request);
        
        try {
            const status = await request;
            this.cache.set(cacheKey, status);
            return status;
        } finally {
            this.pendingRequests.delete(cacheKey);
        }
    }

    /**
     * Batch fetch attachment statuses for UI lists
     * @param attachments Array of ZoteroItemReference objects
     * @returns Promise with a map of cache keys to attachment status responses
     */
    async getAttachmentStatusBatch(attachments: ZoteroItemReference[]): Promise<Map<string, AttachmentStatusResponse>> {
        const cacheKeys = attachments.map(attachment => this.getCacheKey(attachment.library_id, attachment.zotero_key));
        const uncached = attachments.filter((attachment, index) => !this.cache.has(cacheKeys[index]));
        
        if (uncached.length > 0) {
            const statuses = await attachmentsService.getMultipleAttachmentsStatus(uncached);
            statuses.forEach(status => {
                const cacheKey = this.getCacheKey(status.library_id, status.zotero_key);
                this.cache.set(cacheKey, status);
            });
        }
        
        return new Map(cacheKeys.map((key, index) => [key, this.cache.get(key)!]));
    }

    /**
     * Clear cache for specific attachment
     * @param libraryId Zotero library ID
     * @param zoteroKey Zotero key of the attachment
     */
    clearAttachmentCache(libraryId: number, zoteroKey: string): void {
        const cacheKey = this.getCacheKey(libraryId, zoteroKey);
        this.cache.delete(cacheKey);
    }

    /**
     * Clear all cached attachment statuses
     */
    clearAllCache(): void {
        this.cache.clear();
    }
}

const attachmentStatusManager = new AttachmentStatusManager();

export default  attachmentStatusManager;