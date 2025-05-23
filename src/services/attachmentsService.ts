import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { ZoteroItemReference } from '../../react/types/chat/apiTypes';
import { FileStatus } from '../../react/types/fileStatus';

// processing_status from backend
export type ProcessingStatus = "unavailable" | "balance_insufficient" | "queued" | "processing" | "converted" | "chunked" | "embedded" | "failed";
// upload_status_literal from backend
export type UploadStatus = "pending" | "completed" | "failed" | "skipped";

/**
 * Request body for marking an upload as failed
 */
export interface FailUploadRequest {
    file_hash: string;
}

/**
 * Response from marking an upload as failed
 */
export interface UploadFailedResponse {
    success: boolean;
    message: string;
}

/**
 * Request body for marking an upload as completed
 */
export interface CompleteUploadRequest {
    file_hash: string;
    page_count: number | null;
}

/**
 * Response from marking an upload as completed
 */
export interface CompleteUploadResponse {
    success: boolean;
    message: string;
}

/**
 * Represents the processing status of a single attachment.
 * Mirrors the AttachmentStatusResponse Pydantic model in the backend.
 */
export interface AttachmentStatusResponse {
    attachment_id: string;  // UUID
    library_id: number;
    zotero_key: string;

    user_id?: string;
    file_hash?: string;      // Optional UUID
    mime_type?: string;
    page_count?: number;

    // Processing status
    upload_status?: UploadStatus;
    md_status?: ProcessingStatus;
    docling_status?: ProcessingStatus;

    // error codes
    md_error_code?: string
    docling_error_code?: string

    // upload url
    upload_url?: string;
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
    async getMultipleAttachmentsStatus(attachments: ZoteroItemReference[], includeUploadUrl: boolean = false): Promise<AttachmentStatusResponse[]> {
        return this.post<AttachmentStatusResponse[]>('/attachments/status/batch', {
            attachments,
            include_upload_url: includeUploadUrl
        });
    }

    /**
     * Fetches the processing status for a specific attachment.
     * @param libraryId Zotero library ID.
     * @param zoteroKey Zotero key of the attachment.
     * @returns Promise with the attachment status response.
     */
    async getAttachmentStatus(libraryId: number, zoteroKey: string, includeUploadUrl: boolean = false): Promise<AttachmentStatusResponse> {
        const url = `/attachments/status/${libraryId}/${zoteroKey}${includeUploadUrl ? '?include_upload_url=true' : ''}`;
        return this.get<AttachmentStatusResponse>(url);
    }

    /**
     * Fetches the statistics for error codes encountered during processing.
     * @param type The type of processing ('md' or 'docling') to get stats for.
     * @returns Promise resolving to an object mapping error codes to their counts.
     */
    async getErrorCodeStats(type: 'md' | 'docling' = 'md'): Promise<Record<string, number>> {
        return this.get<Record<string, number>>(`/attachments/error-code-stats/${type}`);
    }

    /**
     * Marks an upload as failed for the given file hash.
     * @param fileHash The hash of the file that failed to upload
     * @returns Promise with the upload failed response
     */
    async markUploadFailed(fileHash: string): Promise<UploadFailedResponse> {
        const request: FailUploadRequest = {
            file_hash: fileHash
        };
        return this.post<UploadFailedResponse>('/attachments/fail-upload', request);
    }

    /**
     * Marks an upload as completed for the given file hash.
     * @param fileHash The hash of the file that was completed
     * @param pageCount The number of pages in the file
     * @returns Promise with the upload completed response
     */
    async markUploadCompleted(fileHash: string, pageCount: number | null): Promise<CompleteUploadResponse> {
        const request: CompleteUploadRequest = {
            file_hash: fileHash,
            page_count: pageCount
        };
        return this.post<CompleteUploadResponse>('/attachments/complete-upload', request);
    }

    /**
     * Gets signed upload URLs for a list of file hashes.
     * @param fileHashes Array of file hash strings
     * @returns Promise with a dictionary mapping file hashes to their signed upload URLs
     */
    async getUploadUrls(fileHashes: string[]): Promise<Record<string, string>> {
        return this.post<Record<string, string>>('/attachments/upload-urls', fileHashes);
    }
}

// Export attachmentsService instance
export const attachmentsService = new AttachmentsService(API_BASE_URL); 