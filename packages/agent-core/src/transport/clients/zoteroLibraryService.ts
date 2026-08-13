/**
 * Reads library data from the signed-in user's running Zotero.
 *
 * Used by hosts without a local library (e.g. the Word add-in). The Zotero
 * plugin reads its own library directly and should not use this. When Zotero
 * is not running, the request fails with `zotero_offline` — branch on
 * `isZoteroOffline` rather than treating that as a generic error.
 */

import { ApiService, type RequestOptions } from '../apiService';
import { ApiError } from '../../types/apiErrors';
import type {
    CollectionInfo,
    ItemSearchFrontendResultItem,
    LibrarySummary,
    TagInfo,
} from '../../protocol/agentProtocol';

const ZOTERO_REQUEST_ENDPOINT = '/api/v1/zotero/request';

/**
 * Default deadline for one library request.
 *
 * Must sit above the backend's stacked budgets (up to ~8s to wake an idle
 * provider, then 15–25s for the op) plus round-trip and a 401 retry. Callers
 * that block interactive UI can pass a shorter `timeoutMs`.
 */
export const ZOTERO_REQUEST_TIMEOUT_MS = 45_000;

// =============================================================================
// Op payloads
// =============================================================================

/** Params for `item_search_by_metadata` */
export interface ItemSearchByMetadataParams {
    /** Matched against title-like fields */
    title_query?: string;
    /** Matched against creator names */
    author_query?: string;
    /** Matched against publication / container titles */
    publication_query?: string;
    /** Earliest publication year, inclusive */
    year_min?: number;
    /** Latest publication year, inclusive */
    year_max?: number;
    item_type_filter?: string;
    /** Library names or refs; OR'd */
    libraries_filter?: string[];
    /** Tag names; OR'd */
    tags_filter?: string[];
    /** Collection names or keys; OR'd */
    collections_filter?: string[];
    /** 1–50, default 25. Hits include full metadata plus attachments. */
    limit?: number;
    offset?: number;
}

/** Result of `item_search_by_metadata` */
export interface ItemSearchByMetadataData {
    items: ItemSearchFrontendResultItem[];
}

/** `list_libraries` takes no parameters. */
export type ListLibrariesParams = Record<string, never>;

/** Result of `list_libraries` */
export interface ListLibrariesData {
    libraries: LibrarySummary[];
    total_count: number;
}

/** Params for `list_collections` */
export interface ListCollectionsParams {
    /** Library ref, name or numeric id; the user's personal library when absent */
    library_id?: number | string;
    /** Children of this collection; omit for the library root */
    parent_collection_key?: string;
    include_item_counts?: boolean;
    /** 1–200, default 100 */
    limit?: number;
    offset?: number;
}

/** Result of `list_collections` */
export interface ListCollectionsData {
    collections: CollectionInfo[];
    /** Matching collections, which may exceed the page returned */
    total_count: number;
    library_id?: number | null;
    library_ref?: string | null;
    library_name?: string | null;
}

/** Params for `list_tags` */
export interface ListTagsParams {
    /** Library ref, name or numeric id; the user's personal library when absent */
    library_id?: number | string;
    /** Restrict to tags used inside this collection */
    collection_key?: string;
    /** Drop tags used by fewer items than this; default 1 */
    min_item_count?: number;
    /** 1–200, default 100 */
    limit?: number;
    offset?: number;
}

/** Result of `list_tags` */
export interface ListTagsData {
    tags: TagInfo[];
    /** Matching tags, which may exceed the page returned */
    total_count: number;
    library_id?: number | null;
    library_ref?: string | null;
    library_name?: string | null;
}

/**
 * Library ops a client may request, with params and result typed together.
 * The backend keeps a matching allowlist.
 */
export interface ZoteroLibraryOpMap {
    /** Search the user's library by metadata */
    item_search_by_metadata: {
        params: ItemSearchByMetadataParams;
        data: ItemSearchByMetadataData;
    };
    /** List the libraries this user's Zotero can see */
    list_libraries: {
        params: ListLibrariesParams;
        data: ListLibrariesData;
    };
    /** List collections in one library */
    list_collections: {
        params: ListCollectionsParams;
        data: ListCollectionsData;
    };
    /** List tags in one library */
    list_tags: {
        params: ListTagsParams;
        data: ListTagsData;
    };
}

/** Identifier of a library op */
export type ZoteroLibraryOp = keyof ZoteroLibraryOpMap;

/** Params accepted by a single op */
export type ZoteroLibraryOpParams<Op extends ZoteroLibraryOp> = ZoteroLibraryOpMap[Op]['params'];

/** Data returned by a single op */
export type ZoteroLibraryOpData<Op extends ZoteroLibraryOp> = ZoteroLibraryOpMap[Op]['data'];

/** Successful response envelope, narrowed to one op */
interface ZoteroLibraryResponse<Op extends ZoteroLibraryOp> {
    /** Echo of the requested op */
    op: Op;
    data: ZoteroLibraryOpData<Op>;
}

// =============================================================================
// Degraded states
// =============================================================================

/** Backend code for "the user's Zotero is not reachable". */
export const ZOTERO_OFFLINE_CODE = 'zotero_offline';

/** True when the request failed because the user's Zotero is not running. */
export function isZoteroOffline(error: unknown): boolean {
    return error instanceof ApiError && error.code === ZOTERO_OFFLINE_CODE;
}

// =============================================================================
// Service
// =============================================================================

/**
 * Reads library data from the signed-in user's running Zotero.
 */
export class ZoteroLibraryService extends ApiService {
    /**
     * Runs one library op and returns its data.
     *
     * @throws ApiError with `code === 'zotero_offline'` when Zotero is
     * unreachable (see `isZoteroOffline`). Other failures arrive as an
     * `ApiError` with a user-facing `message`.
     */
    async runOp<Op extends ZoteroLibraryOp>(
        op: Op,
        params: ZoteroLibraryOpParams<Op>,
        options?: RequestOptions,
    ): Promise<ZoteroLibraryOpData<Op>> {
        const response = await this.post<ZoteroLibraryResponse<Op>>(
            ZOTERO_REQUEST_ENDPOINT,
            { op, params },
            { timeoutMs: ZOTERO_REQUEST_TIMEOUT_MS, ...options },
        );
        return response.data;
    }
}

export const zoteroLibraryService = new ZoteroLibraryService();
