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
    ItemProjectionDetail,
    ItemSearchFrontendResultItem,
    LibrarySummary,
    QuickSearchDetail,
    QuickSearchHit,
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

/** Params for `item_quick_search` */
export interface ItemQuickSearchParams {
    /**
     * The user's raw string, ORed across title-like fields, creators and the
     * year — what a picker has. Use `item_search_by_metadata` when the query is
     * already parsed into fields, which are ANDed.
     */
    query: string;
    /** Library names or refs; OR'd */
    libraries_filter?: string[];
    /** Collection names or keys; OR'd */
    collections_filter?: string[];
    /** Tag names; OR'd */
    tags_filter?: string[];
    item_type_filter?: string;
    /** What each hit carries. Default 'compact'. */
    detail?: QuickSearchDetail;
    /**
     * Also render `formatted_citation` per hit. Default false, and best left
     * that way: it runs the CSL engine once per row at hundreds of
     * milliseconds each. Every hit already carries `description`, which says
     * the same thing at field-read cost.
     */
    include_citation?: boolean;
    /** 1–50, default 20 */
    limit?: number;
    offset?: number;
}

/**
 * Result of `item_quick_search`, ranked highest-score first.
 *
 * Discriminated on `detail` so the hit type follows the projection that was
 * actually served rather than the one that was asked for.
 */
export type ItemQuickSearchData =
    | {
        detail: 'compact';
        items: QuickSearchHit[];
        /** Ranked matches, which may exceed the page returned. See `truncated`. */
        total_count: number;
        /** True when the library held more matches than could be ranked, so
         * `total_count` undercounts — prompt for a narrower query rather than
         * paging deeper. */
        truncated?: boolean;
    }
    | {
        detail: 'full';
        items: ItemSearchFrontendResultItem[];
        total_count: number;
        truncated?: boolean;
    };

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
    /**
     * Every descendant of the scope rather than its direct children, so a whole
     * library is one call. Rows still carry `parent_key`, so the tree can be
     * rebuilt client-side.
     */
    recursive?: boolean;
    /**
     * Counting the items in every collection is the expensive part of this op
     * and counts are decoration in a picker — pass `false` there. Default true.
     */
    include_item_counts?: boolean;
    /** Up to 1000, so one library is one call; 50 when omitted. */
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
    /**
     * Restrict to tags on items in this collection.
     *
     * A scoped response is **not** covered by `LibraryScopeVersions.tags`:
     * moving an already-tagged item in or out of a collection changes this
     * listing while that marker stays put. Either re-fetch it every time, or
     * cache the library-wide list and narrow it client-side.
     */
    collection_key?: string;
    /** Drop tags used by fewer items than this; default 1 */
    min_item_count?: number;
    /**
     * Keep only tags whose name contains this substring (case-insensitive for
     * ASCII). Filtered in the provider's SQL, so it is the escape hatch for a
     * library with too many tags to fetch once and filter locally — fetch with
     * a generous `limit` first, and fall back to this only when `total_count`
     * says the list was cut short.
     */
    name_query?: string;
    /** Up to 1000, so the fetch-once-and-filter-locally path works; 50 when omitted. */
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

/** Params for `get_metadata` */
export interface GetMetadataParams {
    /** Model-facing item ids ("<library_ref>-<zotero_key>") */
    item_ids: string[];
    /** What each row carries. Default 'full'. */
    detail?: ItemProjectionDetail;
    /**
     * Render `formatted_citation` on compact rows. Default false; ignored when
     * `detail` is 'full'. This is where to ask for a real bibliography entry —
     * for the one item a user paused on, never for a list.
     */
    include_citation?: boolean;
    /** Child attachments per item. Default false; ignored when compact. */
    include_attachments?: boolean;
    /** Child notes per item. Default false; ignored when compact. */
    include_notes?: boolean;
}

/** One `get_metadata` row in the `compact` projection. */
export interface CompactMetadataItem extends QuickSearchHit {
    /** Echo of the requested id, so a caller can key the row back to its ref */
    item_id: string;
}

/**
 * Result of `get_metadata`. Ids that resolved to nothing come back in
 * `not_found` rather than as an error, so a partial batch still answers.
 */
export type GetMetadataData =
    | {
        detail: 'compact';
        items: CompactMetadataItem[];
        not_found: string[];
    }
    | {
        /** Absent on responses from providers that predate the parameter. */
        detail?: 'full';
        items: Record<string, any>[];
        not_found: string[];
    };

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
    /** Search the user's library with one string, ranked like Zotero's picker */
    item_quick_search: {
        params: ItemQuickSearchParams;
        data: ItemQuickSearchData;
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
    /**
     * Look up known items by id — for rendering a thread's stored references
     * and for building a citation, not for a picker, which already has
     * everything it needs from `item_quick_search`.
     */
    get_metadata: {
        params: GetMetadataParams;
        data: GetMetadataData;
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
