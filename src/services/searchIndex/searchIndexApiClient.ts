import { ApiService } from '@beaver/agent-core/transport/apiService';
import { gzipJsonValueChunked } from '../../utils/gzip';
import type { DocumentExtractResult } from '@beaver/agent-core/extract/document/shared/documentExtractResult';

export const SEARCH_INDEX_API_PREFIX = '/api/v1/index';

const requirementsTtl = (value: IndexRequirements) => value.index_validity === 'unknown' ? 5_000 : 5 * 60_000;

export interface IndexRequirements {
    index_validity?: 'current' | 'missing' | 'unknown';
    namespace_generation?: number | null;
    index_version: number;
    extract_schema_versions: Record<'pdf' | 'epub' | 'snapshot', string[]>;
}

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
    namespace_generation?: number | null;
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

export class SearchIndexApiClient extends ApiService {
    private requirementsCache?: { generation: number | undefined; expires: number; request: Promise<IndexRequirements>; value?: IndexRequirements; pending?: boolean };

    /** Last resolved requirements for the active account, without a network refresh. */
    getCachedRequirements(): IndexRequirements | undefined {
        return this.requirementsCache?.generation === Zotero.Beaver?.account?.getGeneration()
            ? this.requirementsCache?.value : undefined;
    }

    recordRequirements(requirements: IndexRequirements): void {
        const cache = this.requirementsCache;
        if (cache?.pending && cache.generation === Zotero.Beaver?.account?.getGeneration()) {
            cache.value = requirements;
            return;
        }
        this.requirementsCache = { generation: Zotero.Beaver?.account?.getGeneration(),
            expires: Date.now() + requirementsTtl(requirements), request: Promise.resolve(requirements), value: requirements };
    }

    requirements(): Promise<IndexRequirements> {
        const generation = Zotero.Beaver?.account?.getGeneration();
        if (this.requirementsCache && this.requirementsCache.generation === generation && this.requirementsCache.expires > Date.now()) {
            return this.requirementsCache.request;
        }
        const request = this.get<IndexRequirements>(`${SEARCH_INDEX_API_PREFIX}/requirements`);
        const cache = { generation, expires: Date.now() + 5 * 60_000, request,
            value: this.getCachedRequirements(), pending: true };
        this.requirementsCache = cache;
        void request.then(value => {
            if (this.requirementsCache === cache) {
                cache.value = value;
                cache.pending = false;
                cache.expires = Date.now() + requirementsTtl(value);
            }
        },
            () => {
                if (this.requirementsCache !== cache) return;
                if (!cache.value) {
                    this.requirementsCache = undefined;
                    return;
                }
                cache.pending = false;
                cache.expires = 0;
                cache.request = Promise.resolve(cache.value);
            });
        return request;
    }

    upsertHash(request: IndexUpsertRequest): Promise<IndexUpsertResponse> {
        return this.post<IndexUpsertResponse>(`${SEARCH_INDEX_API_PREFIX}/upsert`, request);
    }

    /** Payload upserts are large, so the body goes over the wire gzipped. */
    async upsertPayload(request: IndexUpsertRequest): Promise<IndexUpsertResponse> {
        return await this.postRaw<IndexUpsertResponse>(
            `${SEARCH_INDEX_API_PREFIX}/upsert`,
            await gzipJsonValueChunked(request),
            { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
        );
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

}

export const searchIndexApiClient = new SearchIndexApiClient();
