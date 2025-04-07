import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { MessageAttachment } from '../../react/types/chat/api';
import { FileStatus } from '../../react/types/fileStatus';

// processing_status from backend
export type ProcessingStatus = "unavailable" | "queued" | "processing" | "converted" | "chunked" | "embedded" | "failed";
// upload_status_literal from backend
export type UploadStatus = "pending" | "completed" | "failed";

/**
 * Represents the processing status of a single attachment.
 * Mirrors the AttachmentStatusResponse Pydantic model in the backend.
 */
export interface AttachmentStatusResponse {
    attachment_id: string;  // UUID
    library_id: number;
    zotero_key: string;

    file_id?: string;      // Optional UUID
    mime_type?: string;
    page_count?: number;

    // Processing status
    upload_status?: UploadStatus;
    md_status?: ProcessingStatus;
    docling_status?: ProcessingStatus;
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
     * @param attachments An array of MessageAttachment objects.
     * @returns Promise with an array of attachment status responses.
     */
    async getMultipleAttachmentsStatus(attachments: MessageAttachment[]): Promise<AttachmentStatusResponse[]> {
        return this.post<AttachmentStatusResponse[]>('/attachments/status/batch', attachments);
    }

    /**
     * Fetches the processing status for a specific attachment.
     * @param libraryId Zotero library ID.
     * @param zoteroKey Zotero key of the attachment.
     * @returns Promise with the attachment status response.
     */
    async getAttachmentStatus(libraryId: number, zoteroKey: string): Promise<AttachmentStatusResponse> {
        return this.get<AttachmentStatusResponse>(`/attachments/status/${libraryId}/${zoteroKey}`);
    }

    /**
     * Fetches the statistics for error codes encountered during processing.
     * @param type The type of processing ('md' or 'docling') to get stats for.
     * @returns Promise resolving to an object mapping error codes to their counts.
     */
    async getErrorCodeStats(type: 'md' | 'docling' = 'md'): Promise<Record<string, number>> {
        return this.get<Record<string, number>>(`/attachments/error-code-stats/${type}`);
    }
}

// Export attachmentsService instance
export const attachmentsService = new AttachmentsService(API_BASE_URL); 