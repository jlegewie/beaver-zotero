import { ApiService } from '../apiService';
import API_BASE_URL from '../../utils/getAPIBaseURL';
import type { DocumentExtractResult } from '../documentExtraction/shared/documentExtractResult';

export const SEARCH_INDEX_API_PREFIX = '/api/v1/index';

export interface IndexUpsertRequest {
    source: 'zotero_attachment';
    scope_ref: string;
    zotero_key: string;
    zotero_local_id: string;
    content_kind: 'pdf' | 'epub' | 'snapshot';
    doc_hash: string;
    extract_schema_version: string;
    file_hash?: string;
    payload?: DocumentExtractResult;
}

export interface IndexUpsertResponse {
    status: 'completed' | 'tagged' | 'accepted';
    namespace_ready: boolean;
    chunks_total: number;
    chunks_upserted: number;
    chunks_patched: number;
    chunks_skipped: number;
    chunks_deleted: number;
    index_version: number;
    extract_schema_version: string;
    embed_tokens: number;
}

export interface IndexDocumentRef {
    scope_ref: string;
    zotero_key: string;
    doc_hash: string;
}

export interface IndexUntagResult extends IndexDocumentRef {
    outcome: 'untagged' | 'busy' | 'failed';
    retry_after_seconds?: number | null;
}

export interface IndexDeleteResponse {
    results: IndexUntagResult[];
}

export interface IndexRefsResponse {
    refs: Array<{ doc_hash: string; zotero_key: string }>;
    next_cursor: string | null;
}

export interface IndexStatusResponse {
    namespace_exists: boolean;
    approx_row_count: number | null;
    documents: Array<{
        source: 'zotero_attachment';
        scope_ref: string;
        indexed: number;
        pending: number;
        indexed_chunks: number;
    }>;
}

export class SearchIndexApiClient extends ApiService {
    upsertHash(request: IndexUpsertRequest): Promise<IndexUpsertResponse> {
        return this.post<IndexUpsertResponse>(`${SEARCH_INDEX_API_PREFIX}/upsert`, request);
    }

    upsertPayload(request: IndexUpsertRequest): Promise<IndexUpsertResponse> {
        return this.postGzip<IndexUpsertResponse>(`${SEARCH_INDEX_API_PREFIX}/upsert`, request);
    }

    untag(
        zoteroLocalId: string,
        refs: IndexDocumentRef[],
    ): Promise<IndexDeleteResponse> {
        return this.post<IndexDeleteResponse>(`${SEARCH_INDEX_API_PREFIX}/delete`, {
            source: 'zotero_attachment',
            zotero_local_id: zoteroLocalId,
            refs,
        });
    }

    listRefs(args: {
        scopeRef: string;
        zoteroLocalId: string;
        cursor?: string | null;
        limit?: number;
    }): Promise<IndexRefsResponse> {
        const query = new URLSearchParams({
            source: 'zotero_attachment',
            scope_ref: args.scopeRef,
            zotero_local_id: args.zoteroLocalId,
            limit: String(args.limit ?? 1000),
        });
        if (args.cursor) query.set('cursor', args.cursor);
        return this.get<IndexRefsResponse>(`${SEARCH_INDEX_API_PREFIX}/refs?${query}`);
    }

    /**
     * Follow the refs cursor to the end of a scope. An `isCancelled` callback
     * stops between pages and returns the refs fetched so far.
     */
    async listAllRefs(args: {
        scopeRef: string;
        zoteroLocalId: string;
        isCancelled?: () => boolean;
    }): Promise<IndexRefsResponse['refs']> {
        const refs: IndexRefsResponse['refs'] = [];
        let cursor: string | null = null;
        do {
            const page = await this.listRefs({
                scopeRef: args.scopeRef,
                zoteroLocalId: args.zoteroLocalId,
                cursor,
            });
            refs.push(...page.refs);
            cursor = page.next_cursor;
        } while (cursor && !args.isCancelled?.());
        return refs;
    }

    status(zoteroLocalId: string): Promise<IndexStatusResponse> {
        return this.get<IndexStatusResponse>(
            `${SEARCH_INDEX_API_PREFIX}/status?zotero_local_id=${encodeURIComponent(zoteroLocalId)}`,
        );
    }
}

export const searchIndexApiClient = new SearchIndexApiClient(API_BASE_URL);

