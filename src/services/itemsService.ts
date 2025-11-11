import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';

/**
 * Request body for batch validation of regular item with attachments
 */
export interface ValidateRegularItemRequest {
    item: {
        library_id: number;
        zotero_key: string;
        date_added: string | null;
    };
    attachments: Array<{
        library_id: number;
        zotero_key: string;
        file_hash: string;
        date_added: string | null;
    }>;
}

/**
 * Response from batch validation of regular item with attachments
 */
export interface ValidateRegularItemResponse {
    item_valid: boolean;
    attachments: Array<{
        library_id: number;
        zotero_key: string;
        processed: boolean;
        details?: string;
    }>;
}

/**
 * Items-specific API service that extends the base API service
 */
export class ItemsService extends ApiService {

    /**
     * Validates a regular item with all its attachments in a single batch request
     * This checks if each attachment has been processed on the backend
     * 
     * @param item The regular Zotero item
     * @param attachments Array of attachments with their file hashes
     * @returns Promise with validation response for the item and all attachments
     * 
     * Backend Endpoint Specification:
     * POST /api/v1/items/validate
     * 
     * Request Body:
     * {
     *   "item": {
     *     "library_id": number,
     *     "zotero_key": string,
     *     "date_added": string | null  // ISO 8601 format
     *   },
     *   "attachments": [
     *     {
     *       "library_id": number,
     *       "zotero_key": string,
     *       "file_hash": string,
     *       "date_added": string | null  // ISO 8601 format
     *     }
     *   ]
     * }
     * 
     * Response:
     * {
     *   "item_valid": boolean,
     *   "attachments": [
     *     {
     *       "library_id": number,
     *       "zotero_key": string,
     *       "processed": boolean,  // true if file has been processed/indexed
     *       "details": string | undefined  // error/status message if not processed
     *     }
     *   ]
     * }
     * 
     * Backend should:
     * 1. Verify the regular item exists in the database
     * 2. For each attachment, check if it has been successfully processed (text extraction completed)
     * 3. Return processed status for each attachment
     */
    async validateRegularItemBatch(
        item: Zotero.Item,
        attachments: Array<{ item: Zotero.Item; fileHash: string }>
    ): Promise<ValidateRegularItemResponse> {
        const request: ValidateRegularItemRequest = {
            item: {
                library_id: item.libraryID,
                zotero_key: item.key,
                date_added: item.dateAdded ? Zotero.Date.sqlToISO8601(item.dateAdded) : null
            },
            attachments: attachments.map(att => ({
                library_id: att.item.libraryID,
                zotero_key: att.item.key,
                file_hash: att.fileHash,
                date_added: att.item.dateAdded ? Zotero.Date.sqlToISO8601(att.item.dateAdded) : null
            }))
        };

        return this.post<ValidateRegularItemResponse>('/api/v1/items/validate', request);
    }
}

// Export attachmentsService instance
export const itemsService = new ItemsService(API_BASE_URL); 