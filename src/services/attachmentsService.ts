import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { FileHashReference, ZoteroItemReference } from '../../react/types/zotero';
import { FileStatus } from '../../react/types/fileStatus';
import { UploadQueueRecord } from './database';
import { logger } from '../utils/logger';
import { getPDFPageCount } from '../../react/utils/pdfUtils';
import { store } from '../../react/index';
import { userAtom } from '../../react/atoms/auth';
import { fileUploader } from './FileUploader';
import pako from 'pako';

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
     * Fetches attachments by processing status.
     * @param status The processing status to filter by
     * @param pipeline The pipeline type ("basic", "standard" or "advanced", default: "basic")
     * @param page Page number (1-based, default: 1)
     * @param pageSize Number of items per page (default: 50, max: 100)
     * @returns Promise with paginated list of attachments with the specified status
     */
    async getAttachmentsByStatus(
        status: ProcessingStatus,
        pipeline: "basic" | "standard" | "advanced" = "basic",
        page: number = 1,
        pageSize: number = 50
    ): Promise<AttachmentStatusPagedResponse> {
        const params = new URLSearchParams({
            status: status,
            pipeline: pipeline,
            page: page.toString(),
            page_size: pageSize.toString()
        });
        
        const url = `/attachments/by-status?${params.toString()}`;
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

        // Get user ID
        const userId = store.get(userAtom)?.id;
        if (!userId) {
            throw new Error('User ID not found');
        }

        // Update attachment in local db
        await Zotero.Beaver.db.updateAttachment(userId, result.library_id, result.zotero_key, {
            file_hash: result.file_hash,
            upload_status: 'pending'
        });

        // Queue file hash for upload
        await Zotero.Beaver.db.upsertQueueItem(userId, {
            file_hash: result.file_hash,
            library_id: result.library_id,
            zotero_key: result.zotero_key
        });
        
        // Start upload
        await fileUploader.start("manual");

        // Return the result
        return result;
    }

    /**
     * Uploads text content as a compressed file to the backend
     * @param textContent The text content to upload
     * @param fileHash The hash of the file
     * @param lastModifiedAt The last modified date of the file
     * @returns Promise with the upload response
     */
    async uploadFileContent(textContent: string, fileHash: string, lastModifiedAt: Date | null): Promise<UploadResponse> {
        try {
            // Step 1: Compress the content using pako
            const textEncoder = new TextEncoder();
            const textBytes = textEncoder.encode(textContent);
            const compressedBytes = pako.gzip(textBytes); // This is a Uint8Array

            // Step 2: Create form data
            const formData = new FormData();

            // Create a blob from compressed bytes
            const compressedBlob = new Blob([compressedBytes], { 
                type: 'application/gzip' 
            });

            // Add compressed file to form data
            formData.append('file', compressedBlob, `${fileHash}.gz`);
            formData.append('file_hash', fileHash);
            formData.append('last_modified_at', lastModifiedAt?.toISOString() || '');
            formData.append('is_compressed', 'true');

            // Step 3: Get auth headers (but exclude Content-Type for FormData)
            const authHeaders = await this.getAuthHeaders();
            const { 'Content-Type': _, ...headersWithoutContentType } = authHeaders;

            // Step 4: Upload to backend
            const response = await fetch(`${this.baseUrl}/attachments/upload-file-content`, {
                method: 'POST',
                headers: headersWithoutContentType,
                body: formData,
            });

            if (!response.ok) {
                throw new Error(`Upload failed with status ${response.status}`);
            }

            return response.json() as unknown as Promise<UploadResponse>;

        } catch (error: any) {
            logger(`Beaver Attachments Service: Error uploading file content for hash ${fileHash}: ${error.message}`, 1);
            throw error;
        }
    }
}

// Export attachmentsService instance
export const attachmentsService = new AttachmentsService(API_BASE_URL); 