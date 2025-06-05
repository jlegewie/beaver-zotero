import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { ZoteroItemReference } from '../../react/types/zotero';
import { FileStatus } from '../../react/types/fileStatus';
import { UploadQueueRecord } from './database';
import { logger } from '../utils/logger';
import { getPDFPageCount } from '../../react/utils/pdfUtils';

// processing_status from backend
export type ProcessingStatus = "unavailable" | "balance_insufficient" | "queued" | "processing" | "embedded" | "failed" | "skipped";
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
    mime_type: string;
    page_count: number | null;
}

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
    queued: boolean;
    error: string;
    required_pages: number | null;
    remaining_pages: number | null;
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
        const url = `/attachments/status/batch${includeUploadUrl ? '?include_upload_url=true' : ''}`;
        return this.post<AttachmentStatusResponse[]>(url, attachments);
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
    async getErrorCodeStats(type: 'md' | 'docling' = 'md'): Promise<ErrorCodeStats[]> {
        return this.get<ErrorCodeStats[]>(`/attachments/error-code-stats/${type}`);
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
    async markUploadCompleted(fileHash: string, mimeType: string, pageCount: number | null): Promise<CompleteUploadResult> {
        const request: CompleteUploadRequest = {
            file_hash: fileHash,
            mime_type: mimeType,
            page_count: pageCount
        };
        return this.post<CompleteUploadResult>('/attachments/complete-upload', request);
    }

    /**
     * Gets signed upload URLs for a list of file hashes.
     * @param fileHashes Array of file hash strings
     * @returns Promise with a dictionary mapping file hashes to their signed upload URLs
     */
    async getUploadUrls(fileHashes: string[]): Promise<Record<string, string>> {
        return this.post<Record<string, string>>('/attachments/upload-urls', fileHashes);
    }

    /**
     * Resets all failed uploads by changing their status back to pending.
     * @returns Promise with an array of reset failed upload results
     */
    async resetFailedUploads(): Promise<ResetFailedResult[]> {
        return this.post<ResetFailedResult[]>('/attachments/reset-failed-uploads', {});
    }

    /**
     * Uploads a file to storage
     * 
     * Throws an errors for permanent failures. Returns the item on success on transient failures.
     * 
     * @param item The item to upload
     * @param uploadUrl The upload URL
     * @returns Promise with the uploaded item and success status
     */
    async uploadToStorage(item: UploadQueueRecord, uploadUrl: string): Promise<{item: UploadQueueRecord, success: boolean}> {
        try {            
            logger(`Beaver File Uploader: Uploading file for ${item.zotero_key}`, 3);

            // Retrieve file path from Zotero
            const attachment = await Zotero.Items.getByLibraryAndKeyAsync(item.library_id, item.zotero_key);
            if (!attachment) {
                throw new Error(`Attachment not found: ${item.zotero_key}`);
            }

            // Get the file path for the attachment
            let filePath: string | null = null;
            filePath = await attachment.getFilePathAsync() || null;
            if (!filePath) {
                throw new Error(`File path not found for attachment: ${item.zotero_key}`);
            }

            // Get the page count for PDF attachments
            item.page_count = await getPDFPageCount(attachment);

            // Read file content
            let fileArrayBuffer;
            try {
                fileArrayBuffer = await IOUtils.read(filePath);
            } catch (readError: any) {
                throw new Error(`Error reading file: ${item.zotero_key}`);
            }
            
            const mimeType = attachment.attachmentContentType;
            const blob = new Blob([fileArrayBuffer], { type: mimeType });

            // Perform the file upload with retry for network issues
            let attempt = 0;
            const maxUploadAttempts = 3;
            
            while (attempt < maxUploadAttempts) {
                attempt++;
                try {
                    const response = await fetch(uploadUrl, {
                        method: 'PUT',
                        body: blob,
                        headers: { 'Content-Type': mimeType }
                    });

                    if (!response.ok) {
                        // TODO: handle expired url (status code??)
                        // if (response.status == 403)
                        if (response.status >= 500) {
                            // Server error - may be temporary
                            logger(`Beaver File Uploader: Server error ${response.status} on attempt ${attempt}, will retry`, 2);
                            await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Increasing backoff
                            continue;
                        } else {
                            // Client error - likely permanent
                            throw new Error(`Upload failed with status ${response.status}`);
                        }
                    }
                    
                    // Mark upload as completed
                    return {item, success: true};
                } catch (uploadError: any) {
                    // Network errors
                    if (uploadError instanceof TypeError) {
                        logger(`Network error on attempt ${attempt}, will retry: ${uploadError.message}`, 2);
                        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
                    } else {
                        // Other errors, rethrow
                        throw uploadError;
                    }
                }
            }

            throw new Error(`Failed to upload after ${maxUploadAttempts} attempts`);

        } catch (error: any) {
            logger(`Beaver File Uploader: Error uploading file for attachment ${item.zotero_key}: ${error.message}`, 1);

            // If attempts are too high, treat as permanently failed
            if (item.attempt_count >= 3) {
                throw new Error("Max attempts reached");
            } else {
                // The visibility timeout will handle retries automatically
                logger(`Beaver File Uploader: Upload failed for ${item.zotero_key}, will retry after visibility timeout`, 2);
                return {item, success: false};
            }
        }
    }

    /**
     * Fetches attachments with failed processing status.
     * @param useAdvancedPipeline If true, check docling_status for failures; if false, check md_status for failures
     * @param page Page number (1-based, default: 1)
     * @param pageSize Number of items per page (default: 50, max: 100)
     * @returns Promise with paginated list of failed attachments
     */
    async getFailedAttachments(
        useAdvancedPipeline: boolean = false,
        page: number = 1,
        pageSize: number = 50
    ): Promise<AttachmentStatusPagedResponse> {
        const params = new URLSearchParams({
            use_advanced_pipeline: useAdvancedPipeline.toString(),
            page: page.toString(),
            page_size: pageSize.toString()
        });
        
        const url = `/attachments/status/failed?${params.toString()}`;
        return this.get<AttachmentStatusPagedResponse>(url);
    }
}

// Export attachmentsService instance
export const attachmentsService = new AttachmentsService(API_BASE_URL); 