/**
 * Zotero full-text search handler.
 *
 * Finds candidate attachments with Zotero's own full-text index and returns
 * their best passages for the backend to rerank. See
 * `src/services/zoteroFulltext/search.ts` for the pipeline.
 */

import type {
    WSZoteroFulltextSearchRequest,
    WSZoteroFulltextSearchResponse,
} from '@beaver/agent-core/protocol/agentProtocol';
import { logger } from '@beaver/agent-core/platform/logger';
import { runZoteroFulltextSearch } from '../zoteroFulltext/search';

export async function handleZoteroFulltextSearchRequest(
    request: WSZoteroFulltextSearchRequest,
): Promise<WSZoteroFulltextSearchResponse> {
    const response = await runZoteroFulltextSearch(request);
    logger(
        `handleZoteroFulltextSearchRequest: ${response.status} (${response.engine}), `
        + `${response.documents.length} documents, ${response.passages.length} passages `
        + `in ${response.timing?.total_ms ?? '?'} ms`,
        3,
    );
    return response;
}
