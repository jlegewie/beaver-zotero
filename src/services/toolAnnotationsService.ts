import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { AnnotationStatus, ToolAnnotationColor } from '../../react/types/chat/toolAnnotations';
import { logger } from '../utils/logger';

/**
 * Link between annotation ID and its corresponding Zotero key
 */
export interface AckLink {
    annotation_id: string;
    zotero_key: string;
}

/**
 * Request body for acknowledging annotation creation in Zotero
 */
export interface AckRequest {
    message_id: string;
    links: AckLink[];
}

/**
 * Error details for individual annotation acknowledgment failures
 */
export interface AckError {
    annotation_id: string;
    code: 'not_found' | 'ownership' | 'zotero_key_conflict' | 'db_error';
    detail: string;
}

/**
 * Response from annotation acknowledgment endpoint
 */
export interface AckResponse {
    success: boolean;
    message_id: string;
    updated: number;
    errors: AckError[];
}

/**
 * Request body for updating annotation fields
 */
export interface UpdateAnnotationRequest {
    status?: AnnotationStatus;
    error_message?: string | null;
    color?: ToolAnnotationColor | null;
    comment?: string;
    zotero_key?: string | null;
}

/**
 * Response format for annotation data from the backend
 */
export interface AnnotationResponse {
    id: string;
    message_id: string;
    status: string;
    zotero_key?: string | null;
    library_id: number;
    attachment_key: string;
    annotation_type: string;
    title: string;
    comment: string;
    color?: string | null;
    created_at: string;
    modified_at: string;
}

/**
 * Response from updating a single annotation
 */
export interface UpdateAnnotationResponse {
    success: boolean;
    annotation: AnnotationResponse;
}

/**
 * Tool annotations-specific API service that extends the base API service
 */
export class ToolAnnotationsService extends ApiService {
    /**
     * Creates a new ToolAnnotationsService instance
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
     * Acknowledges that specific annotations were successfully created in Zotero.
     * This endpoint sets zotero_key for each annotation and updates status to 'applied'.
     * It is idempotent (safe to call multiple times).
     * 
     * @param messageId The message ID containing the annotations
     * @param links Array of annotation_id -> zotero_key mappings
     * @returns Promise with success status, count of updated annotations, and any per-item errors
     */
    async acknowledgeAnnotations(
        messageId: string,
        links: AckLink[]
    ): Promise<AckResponse> {
        logger(`acknowledgeAnnotations: Acknowledging ${links.length} annotations for message ${messageId}`);
        
        const request: AckRequest = {
            message_id: messageId,
            links
        };
        
        const response = await this.post<AckResponse>('/api/v1/tool-annotations/ack', request);
        
        logger(`acknowledgeAnnotations: Successfully updated ${response.updated} annotations, ${response.errors.length} errors`);
        return response;
    }

    /**
     * Updates lifecycle fields for a single annotation.
     * This endpoint handles status changes, error message updates, color changes,
     * comment updates, and automatic timestamp management.
     * 
     * @param annotationId UUID of the annotation to update
     * @param updates Fields to update (only non-null fields will be updated)
     * @returns Promise with updated annotation data
     */
    async updateAnnotation(
        annotationId: string,
        updates: UpdateAnnotationRequest
    ): Promise<UpdateAnnotationResponse> {
        logger(`updateAnnotation: Updating annotation ${annotationId} with fields: ${Object.keys(updates).join(', ')}`);
        
        const response = await this.patch<UpdateAnnotationResponse>(
            `/api/v1/tool-annotations/${annotationId}`,
            updates
        );
        
        logger(`updateAnnotation: Successfully updated annotation ${annotationId}`);
        return response;
    }

    /**
     * Updates the status of multiple annotations
     * 
     * @param annotationIds Array of annotation IDs to update
     * @param status New status to set
     * @param errorMessage Optional error message for failed annotations
     * @returns Promise with array of update responses
     */
    async updateAnnotationStatusBatch(
        annotationIds: string[],
        status: AnnotationStatus,
        errorMessage?: string
    ): Promise<UpdateAnnotationResponse[]> {
        logger(`updateAnnotationStatusBatch: Updating ${annotationIds.length} annotations to status: ${status}`);
        
        const updates: UpdateAnnotationRequest = { status };
        if (errorMessage) {
            updates.error_message = errorMessage;
        }
        
        const responses = await Promise.all(
            annotationIds.map(id => this.updateAnnotation(id, updates))
        );
        
        logger(`updateAnnotationStatusBatch: Successfully updated ${responses.length} annotations`);
        return responses;
    }

    /**
     * Marks multiple annotations as applied with their Zotero keys
     * 
     * @param messageId The message ID containing the annotations
     * @param annotationKeyPairs Array of {annotationId, zoteroKey} pairs
     * @returns Promise with acknowledgment response
     */
    async markAnnotationsApplied(
        messageId: string,
        annotationKeyPairs: Array<{ annotationId: string; zoteroKey: string }>
    ): Promise<AckResponse> {
        const links: AckLink[] = annotationKeyPairs.map(pair => ({
            annotation_id: pair.annotationId,
            zotero_key: pair.zoteroKey
        }));
        
        return this.acknowledgeAnnotations(messageId, links);
    }

    /**
     * Marks annotations as failed with an error message
     * 
     * @param annotationIds Array of annotation IDs that failed
     * @param errorMessage Description of the failure
     * @returns Promise with array of update responses
     */
    async markAnnotationsFailed(
        annotationIds: string[],
        errorMessage: string
    ): Promise<UpdateAnnotationResponse[]> {
        return this.updateAnnotationStatusBatch(annotationIds, 'error', errorMessage);
    }

    /**
     * Marks annotations as deleted
     * 
     * @param annotationIds Array of annotation IDs to mark as deleted
     * @returns Promise with array of update responses
     */
    async markAnnotationsDeleted(annotationIds: string[]): Promise<UpdateAnnotationResponse[]> {
        return this.updateAnnotationStatusBatch(annotationIds, 'deleted');
    }
}

// Export toolAnnotationsService instance
export const toolAnnotationsService = new ToolAnnotationsService(API_BASE_URL);
