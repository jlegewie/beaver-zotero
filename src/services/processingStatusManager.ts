import { attachmentsService, ProcessingStatus, UploadStatus } from "../services/attachmentsService";

export interface FileHashStatus {
    file_hash: string
    upload_status: UploadStatus
    text_status: ProcessingStatus
    md_status: ProcessingStatus
    docling_status: ProcessingStatus
    text_error_code?: string
    md_error_code?: string
    docling_error_code?: string
}

export class ProcessingStatusManager {
    private cache = new Map<string, FileHashStatus>();
    private pendingRequests = new Map<string, Promise<FileHashStatus>>();

    async getProcessingStatus(file_hash: string): Promise<FileHashStatus> {
        // Check memory cache first
        if (this.cache.has(file_hash)) {
            return this.cache.get(file_hash)!;
        }

        // Deduplicate concurrent requests
        if (this.pendingRequests.has(file_hash)) {
            return this.pendingRequests.get(file_hash)!;
        }

        // Fetch from backend
        const request = attachmentsService.getFileProcessingStatus(file_hash);
        this.pendingRequests.set(file_hash, request);
        
        try {
            const status = await request;
            this.cache.set(file_hash, status);
            return status;
        } finally {
            this.pendingRequests.delete(file_hash);
        }
    }

    // Batch fetch for UI lists
    async getProcessingStatusBatch(file_hashes: string[]): Promise<Map<string, FileHashStatus>> {
        const uncached = file_hashes.filter(hash => !this.cache.has(hash));
        if (uncached.length > 0) {
            const statuses = await attachmentsService.getFileProcessingStatusBatch(uncached);
            statuses.forEach((status, hash) => this.cache.set(hash, status));
        }
        
        return new Map(file_hashes.map(hash => [hash, this.cache.get(hash)!]));
    }
}