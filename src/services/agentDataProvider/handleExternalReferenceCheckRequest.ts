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
 * - Phase 2: Batch title candidate collection in 1 query (with optional date filtering)
 * - Phase 3: Single batch load of all candidate item data
 * - Phase 4: In-memory fuzzy matching
 *
 * If library_ids is provided, only search those libraries.
 * If library_ids is not provided or empty, search all accessible libraries.
 */
export async function handleExternalReferenceCheckRequest(request: WSExternalReferenceCheckRequest): Promise<WSExternalReferenceCheckResponse> {
    const startTime = Date.now();

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
    let timing;
    try {
        const batchOutput = await batchFindExistingReferences(batchItems, libraryIds);
        batchResults = batchOutput.results;
        timing = batchOutput.timing;
    } catch (error) {
        logger(`AgentService: Batch reference check failed: ${error}`, 1);
        // Return all as not found on error
        batchResults = batchItems.map(item => ({ id: item.id, item: null }));
        timing = {
            total_ms: Date.now() - startTime,
            phase1_identifier_lookup_ms: 0,
            phase2_title_candidates_ms: 0,
            phase3_fuzzy_matching_ms: 0,
            candidates_fetched: 0,
            matches_by_identifier: 0,
            matches_by_fuzzy: 0,
        };
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
        results,
        timing: {
            total_ms: timing.total_ms,
            item_count: request.items.length,
            phase1_identifier_lookup_ms: timing.phase1_identifier_lookup_ms,
            phase2_title_candidates_ms: timing.phase2_title_candidates_ms,
            phase3_fuzzy_matching_ms: timing.phase3_fuzzy_matching_ms,
            candidates_fetched: timing.candidates_fetched,
            matches_by_identifier: timing.matches_by_identifier,
            matches_by_fuzzy: timing.matches_by_fuzzy,
        }
    };

    return response;
}
