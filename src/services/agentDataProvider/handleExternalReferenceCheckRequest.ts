/**
 * Agent Data Provider
 * 
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 * 
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */

import { logger } from '../../utils/logger';

import { batchFindExistingReferences, BatchReferenceCheckItem } from '../../../react/utils/batchFindExistingReferences';
import {
    WSExternalReferenceCheckRequest,
    WSExternalReferenceCheckResponse,
    ExternalReferenceCheckResult,

} from '../agentProtocol';


/**
 * Handle external_reference_check_request event.
 * 
 * Uses batch lookups for optimal performance:
 * - Phase 1: Batch DOI/ISBN lookup across all libraries in 2 queries
 * - Phase 2: Batch title candidate collection in 1 query
 * - Phase 3: Single batch load of all candidate item data
 * - Phase 4: In-memory fuzzy matching
 * 
 * If library_ids is provided, only search those libraries.
 * If library_ids is not provided or empty, search all accessible libraries.
 */
export async function handleExternalReferenceCheckRequest(request: WSExternalReferenceCheckRequest): Promise<WSExternalReferenceCheckResponse> {
    // Determine which libraries to search
    const libraryIds: number[] = request.library_ids && request.library_ids.length > 0
        ? request.library_ids
        : Zotero.Libraries.getAll().map(lib => lib.libraryID);

    // Convert request items to batch format
    const batchItems: BatchReferenceCheckItem[] = request.items.map(item => ({
        id: item.id,
        data: {
            title: item.title,
            date: item.date,
            DOI: item.doi,
            ISBN: item.isbn,
            creators: item.creators
        }
    }));

    // Use batch lookup for all items at once
    let batchResults;
    try {
        batchResults = await batchFindExistingReferences(batchItems, libraryIds);
    } catch (error) {
        logger(`AgentService: Batch reference check failed: ${error}`, 1);
        // Return all as not found on error
        batchResults = batchItems.map(item => ({ id: item.id, item: null }));
    }

    // Convert batch results to response format
    const results: ExternalReferenceCheckResult[] = batchResults.map(result => {
        if (result.item) {
            return {
                id: result.id,
                exists: true,
                item: {
                    library_id: result.item.libraryID,
                    zotero_key: result.item.key
                }
            };
        } else {
            return {
                id: result.id,
                exists: false
            };
        }
    });

    const response: WSExternalReferenceCheckResponse = {
        type: 'external_reference_check',
        request_id: request.request_id,
        results
    };

    return response;
}
