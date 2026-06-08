/**
 * Agent Data Provider
 * 
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 * 
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */

import { logger } from '../../utils/logger';
import {
    WSListLibrariesRequest,
    WSListLibrariesResponse,
} from '../agentProtocol';
import { getSearchableLibraryIds } from './utils';
import { getLibrarySummaries } from './libraryCounts';


/**
 * Handle list_libraries request from backend.
 * Lists searchable libraries in the user's Zotero.
 * For Pro users, only synced libraries are returned.
 * For Free users, all local libraries are returned.
 */
export async function handleListLibrariesRequest(
    request: WSListLibrariesRequest
): Promise<WSListLibrariesResponse> {
    logger(`handleListLibrariesRequest: Listing searchable libraries`, 1);

    try {
        // Get only searchable libraries (Pro: synced, Free: all local)
        const searchableLibraryIds = getSearchableLibraryIds();
        const libraries = await getLibrarySummaries(searchableLibraryIds);

        logger(`handleListLibrariesRequest: Returning ${libraries.length} libraries`, 1);

        return {
            type: 'list_libraries',
            request_id: request.request_id,
            libraries,
            total_count: libraries.length,
        };
    } catch (error) {
        logger(`handleListLibrariesRequest: Error: ${error}`, 1);
        return {
            type: 'list_libraries',
            request_id: request.request_id,
            libraries: [],
            total_count: 0,
            error: String(error),
            error_code: 'list_failed',
        };
    }
}
