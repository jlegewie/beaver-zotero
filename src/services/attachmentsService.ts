import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { FileHashReference, ZoteroItemReference } from '../../react/types/zotero';
import { FileStatus } from '../../react/types/fileStatus';
import { logger } from '../utils/logger';
import { fileUploader } from './FileUploader';

// processing_status from backend
export type ProcessingStatus = "queued" | "processing" | "completed" | "failed_system" | "failed_user" | "plan_limit" | "unsupported_file";
// upload_status_literal from backend
export type UploadStatus = "pending" | "completed" | "failed" | "plan_limit";

/**
 * Request body for marking an upload as failed
 */
export interface UpdateUploadStatusRequest {
    file_hash: string | string[];
    status: UploadStatus;
}

/**
 * Request body for retrying uploads by status
 */
export interface RetryUploadsRequest {
    status: "failed" | "plan_limit";
}

/**
 * Response from marking an upload as failed
 */
export interface UpdateUploadStatusResponse {
    success: boolean;
    message: string;
}

/**
 * Request body for marking an upload as completed
 */
export interface CompleteUploadRequest {
    storage_path: string;
    file_hash: string;
    mime_type: string;
    file_size: number;
    page_count: number | null;
}

/**
 * ErrorCodeStats represents the statistics for error codes encountered during processing.
 */
export interface ErrorCodeStats {
    error_code: string;
    status: ProcessingStatus;
    count: number;
}

/**
 * Response from marking an upload as completed
 */
export interface CompleteUploadResponse {
    success: boolean;
    message: string;
}

export interface CompleteUploadResult {
    upload_completed: boolean;
    hash: string;
    error: string;
}

/**
 * Represents the processing status of a single attachment.
 * Mirrors the AttachmentStatusResponse Pydantic model in the backend.
 */
export interface AttachmentStatusResponse {
    attachment_id: string;  // UUID
    library_id: number;
    zotero_key: string;
    file_hash?: string;

    // Processing status
    upload_status?: UploadStatus;
    text_status?: ProcessingStatus;
    md_status?: ProcessingStatus;
    docling_status?: ProcessingStatus;

    // error codes
    text_error_code?: string
    md_error_code?: string
    docling_error_code?: string
}

/**
 * Response from resetting failed uploads
 */
export interface ResetFailedResult {
    file_hash: string;
    library_id: number;
    zotero_key: string;
}

/**
 * Paginated response for attachments status
 */
export interface AttachmentStatusPagedResponse {
    items: AttachmentStatusResponse[];
    page: number;
    page_size: number;
    has_more: boolean;
}

/**
 * Response from uploading file content
 */
export interface UploadResponse {
    success: boolean;
    message: string;
}

/**
 * Attachments-specific API service that extends the base API service
 */
export class AttachmentsService extends ApiService {
    /**
     * Creates a new AttachmentsService instance
     * @param backendUrl The base URL of the backend API
     */
    constructor(backendUrl: string) {
        super(backendUrl);
    }

    /**
     * Gets the base URL of this service
     * @returns The base URL
     */
    getBaseUrl(): string {
        return this.baseUrl;
    }

    /**
     * Fetches the file processing status summary for the current user.
     * @returns Promise with the file status summary data.
     */
    async getUserFilesStatus(): Promise<FileStatus> {
        return this.get<FileStatus>('/attachments/status');
    }

    /**
     * Fetches the processing status for multiple attachments.
     * @param attachments An array of ZoteroItemReference objects.
     * @returns Promise with an array of attachment status responses.
     */
    async getMultipleAttachmentsStatus(attachments: ZoteroItemReference[]): Promise<AttachmentStatusResponse[]> {
        const url = `/attachments/status/batch`;
        return this.post<AttachmentStatusResponse[]>(url, attachments);
    }

    /**
     * Fetches the processing status for a specific attachment.
     * @param libraryId Zotero library ID.
     * @param zoteroKey Zotero key of the attachment.
     * @returns Promise with the attachment status response.
     */
    async getAttachmentStatus(libraryId: number, zoteroKey: string): Promise<AttachmentStatusResponse> {
        const url = `/attachments/status/${libraryId}/${zoteroKey}`;
        return this.get<AttachmentStatusResponse>(url);
    }

    /**
     * Fetches the statistics for error codes encountered during processing.
     * @param type The type of processing ('md' or 'docling') to get stats for.
     * @returns Promise resolving to an object mapping error codes to their counts.
     */
    async getErrorCodeStats(type: 'text' | 'md' | 'docling'): Promise<ErrorCodeStats[]> {
        return this.get<ErrorCodeStats[]>(`/attachments/error-code-stats/${type}`);
    }

    /**
     * Updates the status of an upload for the given file hash.
     * @param fileHash The hash of the file that failed to upload
     * @param status The status to update the upload to
     * @returns Promise with the upload failed response
     */
    async updateUploadStatus(fileHash: string | string[], status: UploadStatus): Promise<UpdateUploadStatusResponse> {
        const request: UpdateUploadStatusRequest = {
            file_hash: fileHash,
            status: status
        };
        return this.post<UpdateUploadStatusResponse>('/attachments/upload-status', request);
    }

    /**
     * Marks an upload as completed for the given file hash.
     * @param fileHash The hash of the file that was completed
     * @param pageCount The number of pages in the file
     * @returns Promise with the upload completed response
     */
    async markUploadCompleted(storagePath: string, fileHash: string, mimeType: string, fileSize: number, pageCount: number | null): Promise<CompleteUploadResult> {
        const request: CompleteUploadRequest = {
            storage_path: storagePath,
            file_hash: fileHash,
            mime_type: mimeType,
            file_size: fileSize,
            page_count: pageCount
        };
        return this.post<CompleteUploadResult>('/attachments/complete-upload', request);
    }

    /**
     * Marks multiple uploads as completed in a batch operation.
     * @param requests Array of complete upload requests
     * @returns Promise with an array of upload completed responses
     */
    async markUploadCompletedBatch(requests: CompleteUploadRequest[]): Promise<CompleteUploadResult[]> {
        return this.post<CompleteUploadResult[]>('/attachments/complete-upload-batch', requests);
    }

    /**
     * Retries uploads for the current user by resetting their status back to 'pending'.
     * @param status The status to retry ('failed' or 'plan_limit'). Defaults to 'failed'.
     * @returns Promise with an array of FileHashReference objects for uploads that were reset.
     */
    async retryUploadsByStatus(status: "failed" | "plan_limit" = "failed"): Promise<FileHashReference[]> {
        const request: RetryUploadsRequest = { status };
        return this.post<FileHashReference[]>('/attachments/retry-uploads-by-status', request);
    }

    /**
     * Fetches attachments by processing status.
     * @param status The processing status to filter by
     * @param pipeline The pipeline type ("basic", "standard" or "advanced", default: "basic")
     * @param page Page number (1-based, default: 1)
     * @param pageSize Number of items per page (default: 50, max: 100)
     * @returns Promise with paginated list of attachments with the specified status
     */
    async getAttachmentsByStatus(
        status: ProcessingStatus[],
        pipeline: "basic" | "standard" | "advanced" = "basic",
        page: number = 1,
        pageSize: number = 50
    ): Promise<AttachmentStatusPagedResponse> {
        const params = new URLSearchParams();
        
        // Add all parameters
        status.forEach(s => params.append('status', s));
        params.append('pipeline', pipeline);
        params.append('page', page.toString());
        params.append('page_size', pageSize.toString());
        
        const url = `/attachments/by-status?${params.toString()}`;
        return this.get<AttachmentStatusPagedResponse>(url);
    }

    /**
     * Fetches attachments by upload status.
     * @param status The upload status to filter by
     * @param page Page number (1-based, default: 1)
     * @param pageSize Number of items per page (default: 50, max: 100)
     * @returns Promise with paginated list of attachments with the specified status
     */
    async getAttachmentsByUploadStatus(
        status: UploadStatus[],
        page: number = 1,
        pageSize: number = 50
    ): Promise<AttachmentStatusPagedResponse> {
        const params = new URLSearchParams();
        
        // Add all parameters
        status.forEach(s => params.append('status', s));
        params.append('page', page.toString());
        params.append('page_size', pageSize.toString());
        
        const url = `/attachments/by-upload-status?${params.toString()}`;
        return this.get<AttachmentStatusPagedResponse>(url);
    }

    /**
     * Forces update of an attachment's file hash
     * @param libraryId The Zotero library ID
     * @param zoteroKey The Zotero key of the attachment
     * @param fileHash The new file hash
     * @returns Promise with the update response indicating if the hash was enqueued
     */
    async updateFile(libraryId: number, zoteroKey: string, fileHash: string): Promise<FileHashReference | null> {
        logger(`updateFile: Updating file hash for ${zoteroKey} in library ${libraryId}`);
        // Update file hash in backend
        const result = await this.post<FileHashReference>('/attachments/update-file', {
            library_id: libraryId,
            zotero_key: zoteroKey,
            file_hash: fileHash
        } as FileHashReference);
        logger(`updateFile: Result: ${JSON.stringify(result)}`);
        if (!result) {
            logger(`updateFile: No file update required for ${zoteroKey} in library ${libraryId}`);
            return null;
        }
        
        // Start upload
        await fileUploader.start("manual");

        // Return the result
        return result;
    }
}

// Export attachmentsService instance
export const attachmentsService = new AttachmentsService(API_BASE_URL); 