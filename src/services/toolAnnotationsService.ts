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
 * Single item in a batch update request
 * Matches backend BatchUpdateItem model
 */
export interface BatchUpdateItem {
    annotation_id: string;
    status?: AnnotationStatus;
    error_message?: string | null;
    color?: ToolAnnotationColor | null;
    comment?: string;
    zotero_key?: string | null;
}

/**
 * Request body for batch annotation updates
 * Matches backend BatchUpdateRequest model
 */
export interface BatchUpdateRequest {
    updates: BatchUpdateItem[];
}

/**
 * Error details for individual annotation update failures
 * Matches backend BatchUpdateError model
 */
export interface BatchUpdateError {
    annotation_id: string;
    code: 'not_found' | 'no_fields' | 'db_error';
    detail: string;
}

/**
 * Response from batch update endpoint
 * Matches backend BatchUpdateResponse model
 */
export interface BatchUpdateResponse {
    success: boolean;
    updated: number;
    errors: BatchUpdateError[];
}

type UpdateResolution = {
    resolve: (value: UpdateAnnotationResponse) => void;
    reject: (reason: unknown) => void;
};

type PendingAnnotationUpdate = {
    updates: UpdateAnnotationRequest;
    requests: UpdateResolution[];
};

const UPDATE_FLUSH_INTERVAL_MS = 100;
const MAX_PENDING_UPDATE_ENTRIES = 25;

type BatchedAnnotationUpdate = {
    annotationId: string;
    updates: UpdateAnnotationRequest;
    requests: UpdateResolution[];
};

class AnnotationUpdateBatcher {
    private pendingUpdates = new Map<string, PendingAnnotationUpdate>();
    private timer: NodeJS.Timeout | null = null;
    private isFlushing = false;
    private flushRequestedWhileRunning = false;

    constructor(
        private readonly dispatchUpdates: (
            updates: BatchedAnnotationUpdate[]
        ) => Promise<BatchUpdateResponse>
    ) {}

    enqueue(annotationId: string, updates: UpdateAnnotationRequest): Promise<UpdateAnnotationResponse> {
        const mergedUpdates = { ...updates };

        return new Promise<UpdateAnnotationResponse>((resolve, reject) => {
            const existing = this.pendingUpdates.get(annotationId);
            if (existing) {
                existing.updates = { ...existing.updates, ...mergedUpdates };
                existing.requests.push({ resolve, reject });
            } else {
                this.pendingUpdates.set(annotationId, {
                    updates: mergedUpdates,
                    requests: [{ resolve, reject }]
                });
            }

            if (this.pendingUpdates.size >= MAX_PENDING_UPDATE_ENTRIES) {
                this.triggerImmediateFlush();
            } else {
                this.scheduleFlush();
            }
        });
    }

    private scheduleFlush(): void {
        if (this.timer) {
            return;
        }

        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush().catch((error) => {
                logger(`AnnotationUpdateBatcher: flush error: ${error?.message || error}`, 1);
            });
        }, UPDATE_FLUSH_INTERVAL_MS);
    }

    private triggerImmediateFlush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        this.flush().catch((error) => {
            logger(`AnnotationUpdateBatcher: immediate flush error: ${error?.message || error}`, 1);
        });
    }

    private async flush(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        if (this.isFlushing) {
            this.flushRequestedWhileRunning = true;
            return;
        }

        this.isFlushing = true;
        try {
            while (this.pendingUpdates.size > 0) {
                const batchedEntries = Array.from(this.pendingUpdates.entries()).map(
                    ([annotationId, entry]): BatchedAnnotationUpdate => ({
                        annotationId,
                        updates: entry.updates,
                        requests: entry.requests
                    })
                );
                this.pendingUpdates.clear();

                await this.dispatchAndResolve(batchedEntries);
            }
        } finally {
            this.isFlushing = false;
            if (this.flushRequestedWhileRunning) {
                this.flushRequestedWhileRunning = false;
                if (this.pendingUpdates.size > 0) {
                    await this.flush();
                }
            }
        }
    }

    private async dispatchAndResolve(entries: BatchedAnnotationUpdate[]): Promise<void> {
        if (entries.length === 0) {
            return;
        }

        try {
            const response = await this.dispatchUpdates(entries);

            // Build a map of errors by annotation_id for quick lookup
            const errorMap = new Map<string, BatchUpdateError>();
            response.errors.forEach(error => {
                errorMap.set(error.annotation_id, error);
            });

            // Process each entry - if it's in the error map, reject it; otherwise resolve it
            entries.forEach(entry => {
                const error = errorMap.get(entry.annotationId);
                if (error) {
                    // This annotation failed to update
                    const errorMessage = `${error.code}: ${error.detail}`;
                    const err = new Error(errorMessage);
                    entry.requests.forEach(({ reject }) => reject(err));
                } else {
                    // This annotation was successfully updated
                    // We don't get the full annotation back, so we construct a minimal response
                    // with the updates that were applied
                    const updateResponse: UpdateAnnotationResponse = {
                        success: true,
                        annotation: {
                            id: entry.annotationId,
                            // These fields would ideally come from the backend, but the backend
                            // doesn't return the full annotation. We'll set minimal required fields.
                            message_id: '',
                            status: entry.updates.status || 'pending',
                            library_id: 0,
                            attachment_key: '',
                            annotation_type: '',
                            title: '',
                            comment: entry.updates.comment || '',
                            created_at: '',
                            modified_at: new Date().toISOString(),
                            ...(entry.updates.color && { color: entry.updates.color }),
                            ...(entry.updates.zotero_key && { zotero_key: entry.updates.zotero_key })
                        }
                    };
                    entry.requests.forEach(({ resolve }) => resolve(updateResponse));
                }
            });
        } catch (error) {
            // Network or other error - reject all entries
            entries.forEach(entry => entry.requests.forEach(({ reject }) => reject(error)));
        }
    }

    /**
     * Cleanup method for the batcher
     * Note: In practice, the 50ms timer is short enough that pending updates
     * will flush before shutdown completes, and JavaScript timers are cleared
     * automatically when the context is destroyed.
     */
    dispose(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.pendingUpdates.clear();
    }
}

/**
 * Tool annotations-specific API service that extends the base API service
 */
export class ToolAnnotationsService extends ApiService {
    private readonly annotationUpdateBatcher: AnnotationUpdateBatcher;

    /**
     * Creates a new ToolAnnotationsService instance
     * @param backendUrl The base URL of the backend API
     */
    constructor(backendUrl: string) {
        super(backendUrl);
        this.annotationUpdateBatcher = new AnnotationUpdateBatcher((entries) =>
            this.dispatchAnnotationUpdates(entries)
        );
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
        
        return this.annotationUpdateBatcher.enqueue(annotationId, updates).then((response) => {
            logger(`updateAnnotation: Successfully updated annotation ${annotationId}`);
            return response;
        });
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

    /**
     * Cleanup method - not typically needed due to short timer duration
     * and automatic JavaScript cleanup, but provided for completeness.
     */
    dispose(): void {
        this.annotationUpdateBatcher.dispose();
    }

    private async dispatchAnnotationUpdates(
        entries: BatchedAnnotationUpdate[]
    ): Promise<BatchUpdateResponse> {
        // Flatten the updates directly into each item to match backend BatchUpdateItem format
        const request: BatchUpdateItem[] = entries.map(({ annotationId, updates }) => ({
            annotation_id: annotationId,
            ...updates // Spread the updates directly - no nesting
        }));

        const body: BatchUpdateRequest = {
            updates: request
        };

        return super.patch<BatchUpdateResponse>(
            '/api/v1/tool-annotations/batch',
            body
        );
    }
}

// Export toolAnnotationsService instance
export const toolAnnotationsService = new ToolAnnotationsService(API_BASE_URL);
