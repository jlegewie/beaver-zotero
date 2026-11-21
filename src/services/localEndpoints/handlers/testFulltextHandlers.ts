/**
 * Development endpoints for full-text search on Zotero's own index.
 */

import type { WSZoteroFulltextSearchRequest } from '@beaver/agent-core/protocol/agentProtocol';
import { runZoteroFulltextSearch } from '../../zoteroFulltext/search';
import { getZoteroFulltextState } from '../../zoteroFulltext/state';
import { resetEngineCache } from '../../zoteroFulltext/zoteroIndex';

/**
 * POST /beaver/test/zotero-fulltext-search
 *
 * Body: the `zotero_fulltext_search_request` fields (`query`, `keywords`,
 * filters, `attachments`, `max_documents`, `max_passages`, `timeout_ms`).
 * Returns the full response, with per-stage timings. Pass `include_text: false`
 * to drop passage text and locators from the output.
 */
export async function handleTestZoteroFulltextSearchHttpRequest(request: any) {
    if (!request || typeof request.query !== 'string') {
        return { error: 'query (string) is required' };
    }
    if (request.reset_engine) resetEngineCache();
    const { include_text: includeText = true, reset_engine: _reset, ...fields } = request;
    const response = await runZoteroFulltextSearch({
        ...fields,
        event: 'zotero_fulltext_search_request',
        request_id: `test-${Date.now()}`,
    } as WSZoteroFulltextSearchRequest);
    if (includeText) return response;
    return {
        ...response,
        passages: response.passages.map(({ text, locator, ...rest }) => ({
            ...rest,
            chars: text.length,
            has_locator: !!locator,
        })),
    };
}

/** POST /beaver/test/zotero-fulltext-state — the snapshot sent with each agent run. */
export async function handleTestZoteroFulltextStateHttpRequest(request: any) {
    if (request?.reset_engine) resetEngineCache();
    return (await getZoteroFulltextState()) ?? { error: 'state unavailable' };
}
