import { SubscriptionStatus, ProcessingMode, ChargeType } from '../types/profile';
import { TextPart, ThinkingPart, ToolCallPart, ToolReturnPart, RetryPromptPart, RunUsage } from '../agents/types';
import { ZoteroItemReference } from '../types/zotero';
import { ItemDataWithStatus, AttachmentDataWithStatus, ItemStub, ItemSummary, AttachmentInfo, AttachmentStub } from '../types/zotero';
import { ReaderState, NoteState } from '../types/attachments/apiTypes';
import { BeaverAgentPrompt } from '../agents/types';
import type { RetryTrigger } from '../agents/types';
import type { CustomChatModel } from '../types/customChatModel';
import { AttachmentData, ItemData } from '../types/zotero';
import type { BeaverExtractResult } from '../extract/schema';
import type { ExtractContentKind } from '../extract/document/shared/contentKinds';
import type { DocumentExtractResult } from '../extract/document/shared/documentExtractResult';
import type { ConnectionFailureEvidence } from '../transport/connectionFailure';

export { isRenderableMessage } from '../agents/messageVisibility';

// =============================================================================
// WebSocket Event Types (matching backend ws_events.py)
// =============================================================================


/** Base interface for all WebSocket events from the server */
export interface WSBaseEvent {
    event: string;
}

/** Ready event sent after connection validation completes */
export interface WSReadyEvent extends WSBaseEvent {
    event: 'ready';
    subscription_status: SubscriptionStatus;
    processing_mode: ProcessingMode;
    indexing_complete: boolean;
    supports_request_acks?: boolean;
}

/**
 * Per-request ack sent to the backend synchronously when a backend→frontend
 * request is dispatched.
 */
export interface WSRequestReceivedAck {
    type: 'request_received';
    request_id: string;
    /** Busy-context snapshot plus dispatch lag, all numeric (booleans as 0/1) */
    busy: Record<string, number>;
}

/** Request acknowledgment event sent after chat request is validated */
export interface WSRequestAckEvent extends WSBaseEvent {
    event: 'request_ack';
    run_id: string;
    model_id: string | null;
    model_name: string | null;
    charge_type: ChargeType;
}

/** Part event for streaming content (text, thinking, tool calls) */
export interface WSPartEvent extends WSBaseEvent {
    event: 'part';
    run_id: string;
    message_index: number;
    part_index: number;
    part: TextPart | ThinkingPart | ToolCallPart;
}

/** Tool return event for tool execution results */
export interface WSToolReturnEvent extends WSBaseEvent {
    event: 'tool_return';
    run_id: string;
    message_index: number;
    part: ToolReturnPart | RetryPromptPart;
}

/** Tool call progress event for tool execution progress */
export interface WSToolCallProgressEvent extends WSBaseEvent {
    event: 'tool_call_progress';
    run_id: string;
    tool_call_id: string;
    progress: string;
}

/** Streaming tool call arguments for live preview (e.g., create_note content) */
export interface WSToolCallArgsStreamEvent extends WSBaseEvent {
    event: 'tool_call_args_stream';
    run_id: string;
    tool_call_id: string;
    tool_name: string;
    args: Record<string, any>;
}

/**
 * Run complete event signaling the agent run finished.
 *
 * Since CLIENT_FEATURES.CITATIONS_EVENT, `citations` is null here and arrives
 * on `WSRunCitationsEvent` instead — which lets the backend send this frame as
 * soon as the run is durable rather than holding it through a Zotero lookup.
 * The field stays on the type for historical runs and for the un-split path.
 */
export interface WSRunCompleteEvent extends WSBaseEvent {
    event: 'run_complete';
    run_id: string;
    usage: RunUsage | null;
    cost: number | null;
    citations: import('../types/citations').Citation[] | null;
    agent_actions: import('../agents/agentActionTypes').AgentAction[] | null;
    /** Whether the run had high input token usage (backend-assessed). */
    high_token_usage?: boolean;
    /**
     * @deprecated Always false. Runs are no longer paused at a turn threshold;
     * a long run is metered and confirmed through the credit limit. Still on
     * the wire for clients released before that change.
     */
    soft_cap_triggered?: boolean;
}

/**
 * A run's resolved citations, sent after `run_complete`.
 *
 * Resolving citations means asking this plugin what each marker points at, so
 * it finishes well after the answer does. Always sent on the completed path —
 * including with an empty list — because it is what ends the "linking sources"
 * state that `streaming_done` began. On the error and cancel paths it is sent
 * only when there is something in it; those paths clear that state themselves.
 */
export interface WSRunCitationsEvent extends WSBaseEvent {
    event: 'run_citations';
    run_id: string;
    citations: import('../types/citations').Citation[];
}

/** Done event signaling the request is fully complete (after persistence, usage logging, etc.) */
export interface WSDoneEvent extends WSBaseEvent {
    event: 'done';
}

/** Streaming done event: all LLM tokens sent, post-processing (citations) still in progress */
export interface WSStreamingDoneEvent extends WSBaseEvent {
    event: 'streaming_done';
    run_id: string;
}

/**
 * What the server removed from the thread while reconciling it against a
 * legacy retry request (`retry_run_id` / `retry_keep_run_ids`).
 *
 * Kept for wire compatibility.
 */
export interface WSRetryTruncation {
    /** Runs deleted from the thread by this request, oldest first. */
    deleted_run_ids: string[];
    /** Which anchor the truncation used, or null when none ran. */
    anchored_by: 'thread_run_ids' | 'keep_set' | 'retry_run_id' | null;
}

/** Thread event sent when a thread is initialized or created */
export interface WSThreadEvent extends WSBaseEvent {
    event: 'thread';
    thread_id: string;
    /**
     * Present when the server reconciled this thread against a legacy retry
     * request. Never triggered by current clients, which ignore it.
     */
    retry_truncation?: WSRetryTruncation | null;
}

/** Thread name event sent after background thread name generation completes */
export interface WSThreadNameEvent extends WSBaseEvent {
    event: 'thread_name';
    thread_id: string;
    name: string;
}

/** Error event for communicating failures */
export interface WSErrorEvent extends WSBaseEvent {
    event: 'error';
    /** Error type identifier (e.g., 'llm_rate_limit', 'llm_auth_error') */
    type: string;
    /** User-friendly message (may contain HTML links for billing/settings) */
    message: string;
    /** The run ID this error relates to (if applicable) */
    run_id?: string;
    /** Technical details for debugging/logging */
    details?: string;
    /** Whether a retry button should be shown */
    is_retryable?: boolean;
    /** Seconds to wait before retrying (optional) */
    retry_after?: number;
    /** Whether the run can be resumed from the point of failure */
    is_resumable?: boolean;
    /** Whether the frontend should automatically resume by starting a new run */
    try_auto_resume?: boolean;
    /** show the beaver credits button */
    has_beaver_fallback?: boolean;
}

/** Warning event for non-fatal issues */
export interface WSWarningEvent extends WSBaseEvent {
    event: 'warning';
    run_id: string;
    type: string;
    message: string;
    data?: Record<string, any>;
}

/** Retry event sent when the backend is retrying a failed request */
export interface WSRetryEvent extends WSBaseEvent {
    event: 'retry';
    run_id: string;
    /** Current attempt number (1-indexed) */
    attempt: number;
    /** Maximum number of attempts */
    max_attempts: number;
    /** Brief explanation of why retry is needed */
    reason: string;
    /** How long we're waiting before retry (if known) */
    wait_seconds?: number | null;
    /** If true, frontend should clear any partial content streamed before this retry */
    reset: boolean;
}

/** Agent action event sent when an action is detected during streaming */
export interface WSAgentActionsEvent extends WSBaseEvent {
    event: 'agent_actions';
    run_id: string;
    actions: import('../agents/agentActionTypes').AgentAction[];
}

/** Missing Zotero data event sent when referenced items are not available in the backend */
export interface WSMissingZoteroDataEvent extends WSBaseEvent {
    event: 'missing_zotero_data';
    run_id: string;
    items: ZoteroItemReference[];
}

export interface WSDataError {
    reference: ZoteroItemReference;
    error: string;
    error_code?: string;
    /** Technical details for debugging/logging */
    details?: string;
}

export interface WSPageImage {
    /** 1-indexed physical page number */
    page_number: number;
    /** PDF page label for this physical page, when the document declares one. */
    page_label?: string;
    /** Base64-encoded image data */
    image_data: string;
    /** Image format (png or jpeg) */
    format: 'png' | 'jpeg';
    /** Image width in pixels */
    width: number;
    /** Image height in pixels */
    height: number;
}

/** Request from backend to fetch a whole-document Beaver Extract result */
export interface WSZoteroDocumentRequest extends WSBaseEvent {
    event: 'zotero_document_request';
    request_id: string;
    /**
     * May be a parent item; frontend resolves it to a PDF attachment.
     * Absent for external-file requests (exactly one of `attachment` or
     * `external_file_key` is set).
     */
    attachment?: ZoteroItemReference | null;
    /**
     * Key of a user-attached external file (the 8-character key from an
     * 'ext-<KEY>' id), served from the plugin's external-files store.
     */
    external_file_key?: string | null;
    mode: BeaverExtractResult['mode'];
    /** Reject threshold for total document page count; not a page clamp. */
    max_pages?: number | null;
    /**
     * Requested file size cap. Accepted for wire compatibility and ignored:
     * the frontend's file-size ceiling is a client-side preference.
     */
    max_file_size_mb?: number | null;
    /** Frontend-side extraction deadline in seconds. */
    timeout_seconds?: number;
    /** Maximum uncompressed serialized size of payload. */
    max_payload_bytes?: number | null;
}

/** Request from backend to render attachment pages as images */
export interface WSZoteroAttachmentPageImagesRequest extends WSBaseEvent {
    event: 'zotero_attachment_page_images_request';
    request_id: string;
    attachment: ZoteroItemReference;
    /**
     * 1-indexed page numbers to render (defaults to all pages if not specified).
     * Each entry is either a physical 1-based index (number) or a PDF page
     * label string (e.g. "iv"). Same resolution semantics as start_page.
     */
    pages?: (number | string)[];
    /** Scale factor (1.0 = 72 DPI, 2.0 = 144 DPI, etc.). Default: 1.0 */
    scale?: number;
    /** Target DPI (alternative to scale, takes precedence if provided) */
    dpi?: number;
    /** Output format. Default: "png" */
    format?: 'png' | 'jpeg';
    /** JPEG quality (1-100), only used for format="jpeg". Default: 85 */
    jpeg_quality?: number;
    /** Skip caller-specific soft limits. Beaver's hard caps still apply. Default: false */
    skip_local_limits?: boolean;
    /**
     * When true, resolve `pages` entries against PDF page labels first,
     * falling back to 1-based document index when no label matches.
     */
    prefer_page_labels?: boolean;
    /** Frontend-side rendering deadline in seconds. */
    timeout_seconds?: number;
}

/** Request from backend to fetch a Zotero image attachment as a vision-ready image */
export interface WSZoteroAttachmentImageRequest extends WSBaseEvent {
    event: 'zotero_attachment_image_request';
    request_id: string;
    /** May be a parent item; frontend resolves it to an image attachment. */
    attachment: ZoteroItemReference;
    /** Maximum output width in pixels. Default: 1568, hard-capped at 4096. Never upscales. */
    max_width?: number;
    /** Maximum output height in pixels. Default: 1568, hard-capped at 4096. Never upscales. */
    max_height?: number;
    /**
     * Output format. 'auto' (default) passes PNG/JPEG sources through
     * unchanged when no resize is needed; otherwise JPEG sources re-encode
     * as JPEG and everything else as PNG (falling back to JPEG when the
     * PNG exceeds the output byte budget).
     *
     * Animated sources (GIF/APNG/animated WebP) are decoded to their first
     * frame.
     */
    format?: 'png' | 'jpeg' | 'auto';
    /** JPEG quality (1-100), used when the output is JPEG. Default: 85 */
    jpeg_quality?: number;
    /** Frontend-side processing deadline in seconds. */
    timeout_seconds?: number;
}

/**
 * Request from backend to fetch rendered images from an attachment (unified
 * `view` tool). The frontend resolves the attachment and dispatches
 * internally: PDF attachments render the requested page range; image
 * attachments return a single (possibly downscaled/converted) image and
 * ignore the page range and dpi. The response always carries a list of
 * images (length 1 for image attachments).
 *
 * Supersedes WSZoteroAttachmentPageImagesRequest and
 * WSZoteroAttachmentImageRequest for backends that gate on the `view_tool`
 * client feature; the legacy messages remain for older backends.
 */
export interface WSZoteroViewImagesRequest extends WSBaseEvent {
    event: 'zotero_view_images_request';
    request_id: string;
    /**
     * May be a parent item; frontend resolves it to a PDF or image attachment.
     * Absent for external-file requests (exactly one of `attachment` or
     * `external_file_key` is set).
     */
    attachment?: ZoteroItemReference | null;
    /**
     * Key of a user-attached external file (the 8-character key from an
     * 'ext-<KEY>' id), served from the plugin's external-files store.
     */
    external_file_key?: string | null;
    /**
     * First page to render (1-indexed, contiguous range). Default: 1.
     * Ignored for image attachments. Inverted ranges (end_page < start_page)
     * and ranges spanning more than the frontend's hard per-request cap are
     * rejected with `invalid_page_value`, not clamped.
     */
    start_page?: number | null;
    /** Last page to render (inclusive). Default: start_page. Ignored for image attachments. */
    end_page?: number | null;
    /** Target DPI for PDF page rendering. Ignored for image attachments. */
    dpi?: number | null;
    /** Maximum output width in pixels for image attachments (never upscales). Ignored for PDFs. */
    max_width?: number | null;
    /** Maximum output height in pixels for image attachments (never upscales). Ignored for PDFs. */
    max_height?: number | null;
    /** Output format. Defaults: 'png' for PDF pages, 'auto' for image attachments. */
    format?: 'png' | 'jpeg' | 'auto' | null;
    /** JPEG quality (1-100), used when the output is JPEG. Default: 85 */
    jpeg_quality?: number | null;
    /** Skip caller-specific soft limits. Beaver's hard caps still apply. Default: false */
    skip_local_limits?: boolean;
    /** Frontend-side processing deadline in seconds. */
    timeout_seconds?: number;
}

/**
 * Data for a single reference to check if it exists in Zotero library.
 * Matches the fields needed by findExistingReference.
 */
export interface ExternalReferenceCheckItem {
    /** Identifier for this item in the request (e.g., source_id from the backend) */
    id: string;
    /** Item title for fuzzy matching */
    title?: string;
    /** Date string (any format, year is used for comparison) */
    date?: string;
    /** DOI for exact matching */
    doi?: string;
    /** ISBN for exact matching (books) */
    isbn?: string;
    /** Array of creator last names for fuzzy matching */
    creators?: string[];
}

/** Request from backend to check if references exist in Zotero library */
export interface WSExternalReferenceCheckRequest extends WSBaseEvent {
    event: 'external_reference_check_request';
    request_id: string;
    /** Library IDs to search in. If not provided, search all libraries. */
    library_ids?: number[];
    /** References to check */
    items: ExternalReferenceCheckItem[];
}

/** Result for a single external reference check */
export interface ExternalReferenceCheckResult {
    /** The id from the request */
    id: string;
    /** Whether a matching item was found */
    exists: boolean;
    /** Zotero item reference if found */
    item?: ZoteroItemReference;
}

/** Response to external reference check request */
export interface WSExternalReferenceCheckResponse {
    type: 'external_reference_check';
    request_id: string;
    results: ExternalReferenceCheckResult[];
    /** Optional timing breakdown for diagnostics */
    timing?: FrontendTimingMetadata;
}

/** Item search result with attachments (unified format) */
export interface ItemSearchFrontendResultItem {
    item: ItemData;
    attachments: AttachmentInfo[];
    /** Semantic similarity score (0-1) for topic searches, undefined for metadata searches */
    similarity?: number;
}

/**
 * Optional timing breakdown from frontend operations.
 * Used for backend diagnostics to understand where time is spent during search operations.
 */
export interface FrontendTimingMetadata {
    /** Allow additional timing keys from TimingAccumulator */
    [key: string]: number | undefined;
    /** Total operation time in milliseconds */
    total_ms?: number;
    /** Time spent in search/query phase */
    search_ms?: number;
    /** Time spent serializing items */
    serialization_ms?: number;
    /** Number of items processed */
    item_count?: number;
    /** Number of attachments processed */
    attachment_count?: number;

    // Serialization breakdown (cumulative across parallel items)
    /** Time spent loading Zotero data types before serialization */
    data_loading_ms?: number;
    /** Cumulative time in serializeItem() across all items */
    item_serialization_ms?: number;
    /** Cumulative time in processAttachmentInfoBatch() across all items */
    attachment_processing_ms?: number;
    /** Cumulative time fetching attachment items + best attachment + sync dates */
    att_fetch_ms?: number;
    /** Cumulative time loading attachment data types */
    att_load_data_ms?: number;
    /** Cumulative time serializing individual attachments */
    att_serialize_ms?: number;
    /** Cumulative time computing item sync status */
    att_status_ms?: number;
    /** Cumulative time computing file status (page count, etc.) */
    att_file_status_ms?: number;

    // create_item action timings
    // NOTE: These buckets are nested, not disjoint. Summing them double-counts.
    // Hierarchy:
    //   total_ms
    //     └─ resolve_library_ms
    //     └─ apply_ms
    //          ├─ create_zotero_item_ms
    //          │    ├─ resolve_target_ms
    //          │    ├─ identifier_translation_ms | url_translation_ms | manual_creation_ms
    //          │    └─ add_to_collection_ms
    //          ├─ post_save_ms
    //          └─ pdf_check_ms
    /** Time resolving target library (name lookup, editability check) */
    resolve_library_ms?: number;
    /** Time spent in resolveImportTarget inside createZoteroItem */
    resolve_target_ms?: number;
    /** Time spent in Zotero identifier translation (DOI / ISBN / PMID / arXiv) */
    identifier_translation_ms?: number;
    /** Time spent in Zotero URL translation via HiddenBrowser (should be 0 on WS path) */
    url_translation_ms?: number;
    /** Time spent in manual (non-translator) item creation */
    manual_creation_ms?: number;
    /** Time adding the newly-created item to a collection */
    add_to_collection_ms?: number;
    /** Time spent in createZoteroItem (identifier + url + manual + collection) */
    create_zotero_item_ms?: number;
    /** Time saving post-creation field edits (extra, collections, tags) */
    post_save_ms?: number;
    /** Time checking for existing PDF attachments after creation */
    pdf_check_ms?: number;
    /** Total time inside applyCreateItemData (createZoteroItem + post-processing) */
    apply_ms?: number;

    // Reference check specific timings
    /** Time spent in phase 1: identifier (DOI/ISBN) lookup */
    phase1_identifier_lookup_ms?: number;
    /** Time spent in phase 2: fetching title candidates */
    phase2_title_candidates_ms?: number;
    /** Time spent in phase 3: fuzzy matching */
    phase3_fuzzy_matching_ms?: number;
    /** Number of title candidates fetched from database */
    candidates_fetched?: number;
    /** Number of matches found by identifiers */
    matches_by_identifier?: number;
    /** Number of matches found by fuzzy matching */
    matches_by_fuzzy?: number;
}

/** Request from backend to search Zotero library by metadata */
export interface WSItemSearchByMetadataRequest extends WSBaseEvent {
    event: 'item_search_by_metadata_request';
    request_id: string;

    // Query parameters (at least one required, combined with AND)
    /** Keyword or phrase from the title (substring match) */
    title_query?: string;
    /** Author name to search (substring match) */
    author_query?: string;
    /** Publication/journal name to search (substring match) */
    publication_query?: string;

    // Filters (optional, narrow results further)
    /** Minimum publication year (inclusive) */
    year_min?: number;
    /** Maximum publication year (inclusive) */
    year_max?: number;
    /** Filter by item type (e.g., "journalArticle") */
    item_type_filter?: string;
    /** Filter by library names or IDs (OR logic) */
    libraries_filter?: (string | number)[];
    /** Filter by tag names (OR logic) */
    tags_filter?: string[];
    /** Filter by collection names or keys (OR logic) */
    collections_filter?: (string | number)[];

    // Options
    limit: number;
    /** Number of results to skip for pagination. Default: 0. Optional for backward compatibility. */
    offset?: number;
}

/** Error codes for item search failures */
export type ItemSearchErrorCode =
    | 'internal_error'         // General internal error
    | 'database_error'         // Database/indexing error
    | 'invalid_request'        // Invalid request parameters
    | 'collection_not_found'   // collections_filter matched no collection the search covers
    | 'library_not_found'      // libraries_filter matched no library on this device
    | 'library_not_searchable' // a filter matched only in a library excluded from Beaver
    | 'tag_not_found'          // tags_filter matched no tag in the searched libraries
    | 'timeout';               // Operation timed out

/** Response to item metadata search request */
export interface WSItemSearchByMetadataResponse {
    type: 'item_search_by_metadata';
    request_id: string;
    items: ItemSearchFrontendResultItem[];
    /** Error message if search failed */
    error?: string | null;
    /** Error code for programmatic handling */
    error_code?: ItemSearchErrorCode | null;
    /** Optional timing breakdown for diagnostics */
    timing?: FrontendTimingMetadata;
}

/** Request from backend to search Zotero library by topic using semantic search */
export interface WSItemSearchByTopicRequest extends WSBaseEvent {
    event: 'item_search_by_topic_request';
    request_id: string;

    // Query parameter (required)
    /** A concise topic phrase (2-8 words) for semantic search */
    topic_query: string;

    // Filters (optional, narrow results further)
    /** List of author last names to filter results (OR'd) */
    author_filter?: string[];
    /** Minimum publication year (inclusive) */
    year_min?: number;
    /** Maximum publication year (inclusive) */
    year_max?: number;
    /** Filter by library names or IDs (OR logic) */
    libraries_filter?: (string | number)[];
    /** Filter by tag names (OR logic) */
    tags_filter?: string[];
    /** Filter by collection names or keys (OR logic) */
    collections_filter?: (string | number)[];

    // Options
    limit: number;
    /** Number of results to skip for pagination. Default: 0. Optional for backward compatibility. */
    offset?: number;
}

/** Response to item topic search request */
export interface WSItemSearchByTopicResponse {
    type: 'item_search_by_topic';
    request_id: string;
    items: ItemSearchFrontendResultItem[];
    /** Error message if search failed */
    error?: string | null;
    /** Error code for programmatic handling */
    error_code?: ItemSearchErrorCode | null;
    /** Optional timing breakdown for diagnostics */
    timing?: FrontendTimingMetadata;
}

// =============================================================================
// Zotero Item Quick Search (one string, ORed across title / creators / year)
// =============================================================================

/**
 * How much an item row carries, for the ops that let the caller choose.
 *
 * - `compact`: a {@link QuickSearchHit} — what a chip, a menu row and a hover
 *   card need, and nothing else.
 * - `full`: the op's rich row (item metadata plus attachments for the searches,
 *   the whole `toJSON` payload for `get_metadata`).
 *
 * The projection is a parameter rather than a second op so a picker and the
 * agent cannot disagree about what an item is or what matched.
 */
export type ItemProjectionDetail = 'compact' | 'full';

/** How much each quick-search hit carries. See {@link ItemProjectionDetail}. */
export type QuickSearchDetail = ItemProjectionDetail;

/**
 * A single quick-search hit in the `compact` projection.
 *
 * `display_name` and `description` are computed by the Zotero client, so every
 * surface calls the same item the same thing. A client must render these
 * rather than rebuild a label from creators, or its chips drift from what
 * citations and tool-call headers show for the same item.
 *
 * The pair is designed as two lines: `display_name` is the headline
 * ("Smith 2014") and `description` the context under it.
 */
export interface QuickSearchHit {
    /** Device-local library id. Portable identity is `library_ref`. */
    library_id: number;
    /** Device-portable library identity ("u" | "g<groupID>"). */
    library_ref?: string;
    zotero_key: string;
    /** Zotero item type, for the row's icon */
    item_type: string;
    /** Chip label, e.g. "Legewie and DiPrete 2014" */
    display_name: string;
    /**
     * Second line for the row: title and publication context, or the parent
     * relationship for a note or attachment. Shorter than `formatted_citation`.
     */
    description?: string;
    title?: string;
    year?: number;
    /** One-line bibliographic reference */
    formatted_citation?: string;
    /** Whether the item has at least one child attachment */
    has_attachment?: boolean;
    /** Ranking score; higher ranks first. Explains the result order. */
    score?: number;
}

/**
 * Request from backend to run a quick search over the user's Zotero library.
 *
 * Unlike `item_search_by_metadata`, which ANDs separate title/creator/
 * publication conditions, this takes one raw string and ORs it across
 * title-like fields, creator fields and the year — Zotero's own
 * `quicksearch-titleCreatorYear`. That is the shape a picker needs, which has
 * one string and no idea which field it belongs to.
 */
export interface WSItemQuickSearchRequest extends WSBaseEvent {
    event: 'item_quick_search_request';
    request_id: string;

    /** The user's raw string. ORed across title-like fields, creators and year. */
    query: string;

    // Filters (optional, narrow results further)
    /** Filter by item type (e.g., "journalArticle") */
    item_type_filter?: string;
    /** Filter by library names, refs or IDs (OR logic) */
    libraries_filter?: (string | number)[];
    /** Filter by tag names (OR logic) */
    tags_filter?: string[];
    /** Filter by collection names or keys (OR logic) */
    collections_filter?: (string | number)[];

    // Options
    /** What each hit carries. Default 'compact'. */
    detail?: QuickSearchDetail;
    /** Maximum number of results to return. Default 20. */
    limit?: number;
    /** Number of results to skip for pagination. Default 0. */
    offset?: number;
}

/** Response to a quick search request */
export interface WSItemQuickSearchResponse {
    type: 'item_quick_search';
    request_id: string;
    /**
     * Ranked hits, highest score first. `QuickSearchHit[]` when `detail` is
     * 'compact', `ItemSearchFrontendResultItem[]` when 'full' — branch on the
     * echoed `detail` rather than sniffing the rows.
     */
    items: QuickSearchHit[] | ItemSearchFrontendResultItem[];
    /** Projection the items are in; echoes the request's resolved `detail`. */
    detail: QuickSearchDetail;
    /**
     * Ranked matches before pagination — every one of them reachable with
     * `offset`, so a client can page the whole set.
     *
     * When `truncated` is true this is a floor, not the library's true match
     * count: ranking every match of a very common query is unbounded work, so
     * the provider ranks a bounded candidate set per library.
     */
    total_count: number;
    /**
     * True when a library held more matches than the provider's ranking budget,
     * so `total_count` undercounts and the ranking covers only part of the
     * matches. A client should treat it as "too many — keep typing" rather than
     * paging deeper. Omitted by older providers.
     */
    truncated?: boolean;
    /** Error message if search failed */
    error?: string | null;
    /** Error code for programmatic handling */
    error_code?: ItemSearchErrorCode | null;
    /** Optional timing breakdown for diagnostics */
    timing?: FrontendTimingMetadata;
}

/** Level of file status analysis to perform for attachments */
export type FileStatusLevel = 'none' | 'lightweight' | 'full';

/** Request from backend to fetch Zotero item/attachment data */
export interface WSZoteroDataRequest extends WSBaseEvent {
    event: 'zotero_data_request';
    request_id: string;
    /** Whether to include attachments of the items */
    include_attachments: boolean;
    /** Whether to include parents of the items */
    include_parents: boolean;
    /**
     * Whether to include child notes of referenced regular items.
     * Optional; older backends may omit it. When undefined, default to true
     * to match the new backend default.
     */
    include_notes?: boolean;
    /** References to fetch data for */
    items: ZoteroItemReference[];
    /**
     * Level of file status analysis for attachments:
     * - 'none': Skip file_status entirely (fastest, for metadata-only lookups)
     * - 'lightweight': Fast checks without reading full PDF (default)
     * - 'full': Full analysis including OCR detection (slowest, reads full PDF)
     */
    file_status_level?: FileStatusLevel;
}

/** Response to zotero data request */
export interface WSZoteroDataResponse {
    type: 'zotero_data';
    request_id: string;
    /** Item metadata with status for successfully retrieved items */
    items: ItemDataWithStatus[];
    /** Attachment metadata with status for successfully retrieved attachments */
    attachments: AttachmentDataWithStatus[];
    /** Note metadata for successfully retrieved notes */
    notes?: NoteResultItem[];
    /** Annotation metadata for successfully retrieved annotations */
    annotations?: AnnotationResultItem[];
    /** Optional errors for references that couldn't be retrieved */
    errors?: WSDataError[];
}

/** Error codes for document extraction failures */
export type ZoteroDocumentErrorCode =
    | 'invalid_format'      // Invalid library_id or zotero_key format
    | 'not_found'           // Attachment not found in Zotero
    | 'not_attachment'      // Item is not an attachment
    | 'not_pdf'             // Attachment is not a PDF
    | 'unsupported_type'    // Attachment kind not supported for reading
    | 'is_linked_url'       // Attachment is a linked URL, not a stored file
    | 'file_missing'        // PDF file not available locally
    | 'file_too_large'      // PDF file exceeds size limit
    | 'encrypted'           // PDF is password-protected
    | 'no_text_layer'       // PDF needs OCR
    | 'invalid_pdf'         // Invalid/corrupted PDF
    | 'empty_document'      // PDF opened but has no readable pages
    | 'pdf_too_complex'     // PDF exhausted the parser's memory
    | 'pdf_parser_crash'    // PDF crashes the local PDF parser
    | 'too_many_pages'      // PDF exceeds page count limit
    | 'page_out_of_range'   // Requested pages are out of range
    | 'download_failed'     // Remote file download failed
    | 'timeout'             // Extraction timed out
    | 'worker_unavailable'  // The local PDF engine could not start / died and could not be respawned (transient, retryable)
    | 'extraction_failed'  // General extraction failure
    | 'recursion_limit'     // Extraction overflowed the JS stack ("too much recursion" / "Maximum call stack")
    | 'library_excluded'    // Attachment is in a library the user excluded from Beaver
    | 'library_unavailable' // Attachment is in a library unavailable on this computer
    | 'document_too_large'  // Serialized extraction result exceeds the WebSocket transfer budget
    | 'schema_version_mismatch'
    | 'mode_mismatch';

/**
 * Compact health snapshot of the local PDF worker slot, attached to timeout
 * error responses so backend traces can distinguish a wedged worker (lease
 * reap, respawn churn) from a merely slow operation. Only attached when the
 * timed-out request actually posted work to the worker slot — never for
 * pre-dispatch failures or non-PDF paths, whose timeouts are unrelated to
 * worker state. Counters are cumulative for the current Zotero session.
 */
export interface WSWorkerDiagnostics {
    /** Worker slot that served the request. */
    slot: string;
    /** True when this failure was the busy-lease watchdog reaping the operation. */
    lease_reaped: boolean;
    /** Lease reaps this session. */
    lease_reap_count: number;
    /** Op name of the most recent lease reap. */
    last_lease_reap_op?: string | null;
    /** Busy age (ms) of the most recent lease reap. */
    last_lease_reap_age_ms?: number | null;
    /** Worker spawns this session (respawn-churn signal). */
    spawn_count: number;
    /** Stale-worker retries this session. */
    retry_count: number;
    /** Consecutive worker start failures. */
    consecutive_start_failures: number;
    /** Whether a live worker exists right now. */
    has_worker: boolean;
    /** Accepted operations currently in flight on the slot. */
    in_flight: number;
    /** Age (ms) of the oldest in-flight operation; null when idle. */
    oldest_in_flight_age_ms?: number | null;
}

/** Response to whole-document extraction request */
export interface WSZoteroDocumentResponse {
    type: 'zotero_document';
    request_id: string;
    /** Reference for the served Zotero attachment (routing handle) */
    resolved_attachment?: ZoteroItemReference | null;
    /** Echo of the external file key for external-file requests. */
    external_file_key?: string | null;
    content_type?: string | null;
    content_kind?: ExtractContentKind | null;
    result?: DocumentExtractResult | null;
    /** Served attachment's parent regular item anchor, when it has one. */
    parent_item?: ItemStub | null;
    /** Display metadata for the served attachment.
     * 
     * `attachment_id` is the model-facing id of the same file
     * (`<library_id>-<zotero_key>` for Zotero attachments,
     * `ext-<key>` for external files).
     */
    served_attachment?: AttachmentStub | null;
    /** Page count on error responses when available. */
    total_pages?: number | null;
    error?: string | null;
    error_code?: ZoteroDocumentErrorCode | null;
    /** Worker health snapshot, attached to timeout error responses. */
    worker_diagnostics?: WSWorkerDiagnostics | null;
}

/** Error codes for attachment page image rendering failures */
export type AttachmentPageImagesErrorCode =
    | 'invalid_format'      // Invalid library_id or zotero_key format
    | 'not_found'           // Attachment not found in Zotero
    | 'not_attachment'      // Item is not an attachment
    | 'not_pdf'             // Attachment is not a PDF
    | 'is_linked_url'       // Attachment is a linked URL, not a stored file
    | 'file_missing'        // PDF file not available locally
    | 'file_too_large'      // PDF file exceeds size limit
    | 'encrypted'           // PDF is password-protected
    | 'invalid_pdf'         // Invalid/corrupted PDF
    | 'empty_document'      // PDF opened but has no readable pages
    | 'pdf_too_complex'     // PDF exhausted the parser's memory
    | 'pdf_parser_crash'    // PDF crashes the local PDF parser
    | 'too_many_pages'      // PDF exceeds page count limit
    | 'page_out_of_range'   // Requested pages are out of range
    | 'download_failed'     // Remote file download failed
    | 'invalid_page_value'  // Non-parseable string or unresolved label
    | 'timeout'             // Rendering timed out
    | 'library_excluded'    // Attachment is in a library the user excluded from Beaver
    | 'library_unavailable' // Attachment is in a library unavailable on this computer
    | 'render_failed';      // General rendering failure

/** Response to zotero attachment page images request */
export interface WSZoteroAttachmentPageImagesResponse {
    type: 'zotero_attachment_page_images';
    request_id: string;
    attachment: ZoteroItemReference;
    /** Rendered page images (empty array if error) */
    pages: WSPageImage[];
    /** Total number of pages in the document */
    total_pages: number | null;
    /** Error message if rendering failed */
    error?: string | null;
    /** Error code for programmatic handling */
    error_code?: AttachmentPageImagesErrorCode | null;
    /** Worker health snapshot, attached to timeout error responses. */
    worker_diagnostics?: WSWorkerDiagnostics | null;
}

/** Error codes for attachment image failures */
export type AttachmentImageErrorCode =
    | 'invalid_format'             // Invalid library_id, zotero_key, or request parameter format
    | 'not_found'                  // Attachment not found in Zotero
    | 'not_attachment'             // Item is not (resolvable to) an image attachment
    | 'not_image'                  // Attachment is not an image content type
    | 'is_linked_url'              // Attachment is a linked URL, not a stored file
    | 'unsupported_image_format'   // Image format the runtime cannot decode (TIFF, HEIC, SVG, ...)
    | 'file_missing'               // Image file not available locally
    | 'file_too_large'             // Image file exceeds size limit
    | 'download_failed'            // Remote file download failed
    | 'decode_failed'              // Image could not be decoded (corrupt/truncated)
    | 'timeout'                    // Processing timed out
    | 'library_excluded'           // Attachment is in a library the user excluded from Beaver
    | 'library_unavailable'        // Attachment is in a library unavailable on this computer
    | 'image_processing_failed';   // General resize/encode failure

/** A processed attachment image. Field shapes align with WSPageImage. */
export interface WSAttachmentImage {
    /** Base64-encoded image data */
    image_data: string;
    /** Image format (png or jpeg) */
    format: 'png' | 'jpeg';
    /** Output image width in pixels */
    width: number;
    /** Output image height in pixels */
    height: number;
    /** Source image width in pixels (after EXIF orientation) */
    original_width: number;
    /** Source image height in pixels (after EXIF orientation) */
    original_height: number;
    /** Source MIME type, e.g. 'image/webp' */
    original_format: string;
    /** True when the output dimensions differ from the source */
    resized: boolean;
    /** True when the output MIME type differs from the source MIME type */
    converted: boolean;
}

/** Response to zotero attachment image request */
export interface WSZoteroAttachmentImageResponse {
    type: 'zotero_attachment_image';
    request_id: string;
    attachment: ZoteroItemReference;
    /** The attachment actually served when a parent item was auto-resolved. */
    resolved_attachment?: ZoteroItemReference | null;
    /** The processed image (null on error) */
    image: WSAttachmentImage | null;
    /** Error message if processing failed */
    error?: string | null;
    /** Error code for programmatic handling */
    error_code?: AttachmentImageErrorCode | null;
}

/** Error codes for unified view-images failures */
export type ViewImagesErrorCode =
    | AttachmentPageImagesErrorCode
    | AttachmentImageErrorCode
    | 'unsupported_type'   // Attachment is neither a PDF nor an image
    | 'view_failed';       // General dispatch-level failure

/** A single rendered image returned by a zotero_view_images request. */
export interface WSViewImage {
    /** Base64-encoded image data */
    image_data: string;
    /** Image format (png or jpeg) */
    format: 'png' | 'jpeg';
    /** Image width in pixels */
    width: number;
    /** Image height in pixels */
    height: number;
    /** 1-indexed physical page number for PDF pages. Absent for image attachments. */
    page_number?: number | null;
    /** PDF page label for this physical page, when the document declares one. */
    page_label?: string | null;
}

/** Response to zotero view images request */
export interface WSZoteroViewImagesResponse {
    type: 'zotero_view_images';
    request_id: string;
    /**
     * Echo of the requested attachment. Absent for external-file requests
     * (exactly one of `attachment` or `external_file_key` is set).
     */
    attachment?: ZoteroItemReference | null;
    /** Echo of the external file key for external-file requests. */
    external_file_key?: string | null;
    /** Reference for the served Zotero attachment (routing handle) */
    resolved_attachment?: ZoteroItemReference | null;
    /** Kind of the served attachment. Null on errors before resolution. */
    kind: 'pdf' | 'image' | null;
    /** Rendered images (empty on error; length 1 for image attachments) */
    images: WSViewImage[];
    /** Total number of pages in the document (PDFs only) */
    total_pages: number | null;
    /** Served attachment's parent regular item anchor, when it has one. */
    parent_item?: ItemStub | null;
    /** Display metadata for the served attachment.
     * 
     * `attachment_id` is the model-facing id of the same file
     * (`<library_id>-<zotero_key>` for Zotero attachments,
     * `ext-<key>` for external files).
     */
    served_attachment?: AttachmentStub | null;
    /** Error message if processing failed */
    error?: string | null;
    /** Error code for programmatic handling */
    error_code?: ViewImagesErrorCode | null;
    /** Worker health snapshot, attached to timeout error responses. */
    worker_diagnostics?: WSWorkerDiagnostics | null;
}

/** Error codes for attachment search failures */
export type AttachmentSearchErrorCode =
    | 'invalid_format'      // Invalid library_id or zotero_key format
    | 'not_found'           // Attachment not found in Zotero
    | 'not_attachment'      // Item is not an attachment
    | 'not_pdf'             // Attachment is not a PDF
    | 'file_missing'        // PDF file not available locally
    | 'file_too_large'      // PDF file exceeds size limit
    | 'encrypted'           // PDF is password-protected
    | 'invalid_pdf'         // Invalid/corrupted PDF
    | 'empty_document'      // PDF opened but has no readable pages
    | 'no_text_layer'       // PDF requires OCR — text search unavailable
    | 'too_many_pages'      // PDF exceeds page count limit
    | 'download_failed'     // Remote file download failed
    | 'timeout'             // Search timed out
    | 'library_excluded'    // Attachment is in a library the user excluded from Beaver
    | 'library_unavailable' // Attachment is in a library unavailable on this computer
    | 'search_failed';      // General search failure

/** Request from backend to search text within an attachment */
export interface WSZoteroAttachmentSearchRequest extends WSBaseEvent {
    event: 'zotero_attachment_search_request';
    request_id: string;
    attachment: ZoteroItemReference;
    /** Search query (literal phrase match, case-insensitive) */
    query: string;
    /** Maximum hits to return per page. Default: 100 */
    max_hits_per_page?: number;
    /** Skip caller-specific soft limits. Beaver's hard caps still apply. Default: false */
    skip_local_limits?: boolean;
    /** Frontend-side search deadline in seconds. */
    timeout_seconds?: number;
}

/** A single search hit within a page */
export interface WSSearchHit {
    /** Hit bounding box in source MuPDF top-left page coordinates. */
    bbox: { l: number; t: number; r: number; b: number; origin: "top-left" | "bottom-left" };
    /** Text role: heading, body, caption, footnote, unknown */
    role: string;
    /** Role weight applied to this hit */
    weight: number;
    /** Matched text content (if available) */
    matched_text?: string;
}

/** Search results for a single page */
export interface WSPageSearchResult {
    /** 0-indexed page number */
    page_index: number;
    /** Page label (e.g., "iv", "220") if available */
    label?: string;
    /** Number of matches on this page */
    match_count: number;
    /** Computed relevance score for ranking */
    score: number;
    /** Total text length on the page (for context) */
    text_length: number;
    /** Individual search hits with positions */
    hits: WSSearchHit[];
}

/** Response to zotero attachment search request */
export interface WSZoteroAttachmentSearchResponse {
    type: 'zotero_attachment_search';
    request_id: string;
    attachment: ZoteroItemReference;
    /** Search query that was executed */
    query: string;
    /** Total number of matches across all pages */
    total_matches: number;
    /** Number of pages with at least one match */
    pages_with_matches: number;
    /** Total pages in the document */
    total_pages: number | null;
    /** Pages with matches, sorted by relevance score (highest first) */
    pages: WSPageSearchResult[];
    /** Error message if search failed */
    error?: string | null;
    /** Error code for programmatic handling */
    error_code?: AttachmentSearchErrorCode | null;
    /** Worker health snapshot, attached to timeout error responses. */
    worker_diagnostics?: WSWorkerDiagnostics | null;
}

// =============================================================================
// Read Note Tool (Request/Response)
// =============================================================================

/** Request from backend to read a Zotero note's content */
export interface WSReadNoteRequest extends WSBaseEvent {
    event: 'read_note_request';
    request_id: string;
    /** Note identifier: "{libraryID}-{itemKey}" */
    note_id: string;
    /** Optional: start line (1-indexed). Omit to read from beginning. */
    offset?: number;
    /** Optional: max lines to return. Omit to read entire note. */
    limit?: number;
}

/** Response to read_note request */
export interface WSReadNoteResponse {
    type: 'read_note';
    request_id: string;
    success: boolean;
    /** Error message if success is false */
    error?: string;
    /** Note metadata */
    note_id?: string;
    /** Device-local Zotero library ID of the note. */
    library_id?: number;
    /** Zotero key of the note. */
    zotero_key?: string;
    /** Device-portable library identity ("u" | "g<groupID>") of the note. */
    library_ref?: string;
    title?: string;
    /** @deprecated Superseded by `parent_item`. Still emitted for clients/backends predating `parent_item`; remove once the backend reads `parent_item`. */
    parent_item_id?: string;
    /** @deprecated Superseded by `parent_item`. Still emitted for clients/backends predating `parent_item`; remove once the backend reads `parent_item`. */
    parent_title?: string;
    /** Bibliographic anchor for the parent item, when the note has one. */
    parent_item?: ItemStub | null;
    /** Total line count of the simplified HTML */
    total_lines?: number;
    /** The simplified HTML content */
    content?: string;
    /** Whether more lines exist beyond this page */
    has_more?: boolean;
    /** 1-indexed offset for the next page (undefined if no more lines) */
    next_offset?: number;
    /** Range of lines returned, e.g. '1-50' */
    lines_returned?: string;
    /** Items cited in the note content (resolved from citation tags) */
    cited_items?: ItemSummary[];
}

// =============================================================================
// Library Management Tools (Request/Response)
// =============================================================================

/** Search condition for zotero_search */
export interface ZoteroSearchCondition {
    /** Zotero field to search */
    field: string;
    /** Comparison operator */
    operator: string;
    /** Value to compare against */
    value?: string | null;
}

/** Zotero item category */
export type ZoteroItemCategory = 'regular' | 'attachment' | 'note' | 'annotation' | 'all';

/** Request from backend for zotero_search */
export interface WSZoteroSearchRequest extends WSBaseEvent {
    event: 'zotero_search_request';
    request_id: string;
    conditions: ZoteroSearchCondition[];
    join_mode: 'all' | 'any';
    library_id?: number | string | null;
    item_category?: ZoteroItemCategory | null;
    include_children: boolean;
    recursive: boolean;
    sort_by?: string | null;
    sort_order?: string | null;
    limit: number;
    offset: number;
    fields?: string[] | null;
    /** Post-filter: true = only items with attachments, false = only items without */
    has_attachments?: boolean | null;
}

/** Regular (non-note) result item from zotero_search */
export interface RegularSearchResultItem {
    result_type: 'regular';
    item_id: string;
    /** Device-portable library identity ("u" | "g<groupID>") of the item referenced by `item_id`. */
    library_ref?: string;
    item_type: string;
    title?: string | null;
    creators?: string | null;
    year?: number | null;
    extra_fields?: Record<string, any> | null;
}

/** Note result item from search/list results */
export interface NoteResultItem {
    result_type: 'note';
    item_id: string;
    /** Device-portable library identity ("u" | "g<groupID>") of the note referenced by `item_id`. */
    library_ref?: string;
    title?: string | null;
    /** @deprecated Superseded by `parent_item`. Still emitted for clients/backends predating `parent_item`; remove once the backend reads `parent_item`. */
    parent_item_id?: string | null;
    /** @deprecated Superseded by `parent_item`. Still emitted for clients/backends predating `parent_item`; remove once the backend reads `parent_item`. */
    parent_title?: string | null;
    /** Bibliographic anchor for the parent item, when the note has one. */
    parent_item?: ItemStub | null;
    date_modified?: string | null;
}

/** Attachment result item from search/list results */
export type AttachmentRowResult = AttachmentInfo & {
    result_type: 'attachment';
    /** @deprecated Superseded by `parent_item`. Still emitted for clients/backends predating `parent_item`; remove once the backend reads `parent_item`. */
    parent_title?: string | null;
    /** Bibliographic anchor for the parent item, when the attachment has one. */
    parent_item?: ItemStub | null;
    date_modified?: string | null;
};

/**
 * Annotation result item.
 *
 * Annotations are children of attachments, which are children of regular
 * items. The result surfaces both the parent attachment and the bibliographic
 * regular item so callers can:
 *  - render an annotation citation against the bibliographic parent.
 *  - power an LLM-facing tool (e.g. get_annotations) with clear identity
 *    names: `annotation_id` for the annotation itself, `attachment_id` for
 *    the PDF, `item_id` for the paper/book/record.
 */
export interface AnnotationResultItem {
    result_type: 'annotation';
    /** Annotation id, format "library_id-zotero_key". */
    annotation_id: string;
    /** Device-portable library identity ("u" | "g<groupID>") of the annotation referenced by `annotation_id`. */
    library_ref?: string;
    /** "highlight" | "underline" | "note" | "image" | "ink" | "text" */
    annotation_type?: string | null;
    /** Highlighted/selected text, when present. */
    text?: string | null;
    /** Comment attached to the annotation, when present. */
    comment?: string | null;
    /** Color hex (e.g. "#ffd400"). */
    color?: string | null;
    /** 1-based page number of the annotation's location. */
    page?: number | null;
    /** Document's printed page label (e.g. roman numerals); UI rendering only, not surfaced to the agent. */
    page_label?: string | null;
    /** Tag names attached to the annotation. */
    tags?: string[];
    /** Annotation author, when Zotero stores one. */
    author?: string | null;
    /** Parent attachment id ("library_id-zotero_key"). */
    attachment_id?: string | null;
    /** Bibliographic regular item id ("library_id-zotero_key"). */
    item_id?: string | null;
    /** Zotero item type of the bibliographic regular item. */
    item_type?: string | null;
    /** Title of the bibliographic regular item. */
    item_title?: string | null;
    /** Formatted creators of the bibliographic regular item. */
    item_creators?: string | null;
    /** Publication year of the bibliographic regular item. */
    item_year?: number | null;
    date_added?: string | null;
    date_modified?: string | null;
}

/** Result item from zotero_search (regular, note, or attachment) */
export type ZoteroSearchResultItem = RegularSearchResultItem | NoteResultItem | AttachmentRowResult;

/** Result item from list_items (regular, note, or attachment) */
export type ListItemsResultItem = RegularListResultItem | NoteResultItem | AttachmentRowResult;

/** Brief library info for error responses */
export interface AvailableLibraryInfo {
    library_id: number;
    /** Device-portable library identity ("u" | "g<groupID>"). See `src/utils/libraryIdentity.ts`. */
    library_ref?: string;
    name: string;
}

/** Response to zotero_search request */
export interface WSZoteroSearchResponse {
    type: 'zotero_search';
    request_id: string;
    items: ZoteroSearchResultItem[];
    total_count: number;
    error?: string | null;
    error_code?: string | null;
    /** Available libraries (only included when error_code is 'library_not_found') */
    available_libraries?: AvailableLibraryInfo[] | null;
    /** Non-fatal warnings (e.g., conditions Zotero rejected). Search still executed. */
    warnings?: string[] | null;
}

/** Request from backend for list_items */
export interface WSListItemsRequest extends WSBaseEvent {
    event: 'list_items_request';
    request_id: string;
    library_id?: number | string | null;
    collection_key?: string | null;
    tag?: string | null;
    item_category: ZoteroItemCategory;
    include_children?: boolean;
    recursive: boolean;
    sort_by: string;
    sort_order: string;
    limit: number;
    offset: number;
    /** Post-filter: true = only items with attachments, false = only items without */
    has_attachments?: boolean | null;
}

/** Regular (non-note) result item from list_items */
export interface RegularListResultItem {
    result_type: 'regular';
    item_id: string;
    /** Device-portable library identity ("u" | "g<groupID>") of the item referenced by `item_id`. */
    library_ref?: string;
    item_type: string;
    title?: string | null;
    creators?: string | null;
    year?: number | null;
    date_added?: string | null;
    date_modified?: string | null;
}

/** Response to list_items request */
export interface WSListItemsResponse {
    type: 'list_items';
    request_id: string;
    items: ListItemsResultItem[];
    total_count: number;
    library_name?: string | null;
    collection_name?: string | null;
    error?: string | null;
    error_code?: string | null;
    /** Available libraries (only included when error_code is 'library_not_found') */
    available_libraries?: AvailableLibraryInfo[] | null;
}

/**
 * Request from backend for resolve_population.
 *
 * Resolves the complete set of item ids matching a filter description in one
 * round trip, so a batch job never has to page through `list_items`.
 * Every filter is ANDed with every other one; `conditions_join_mode` sets how
 * the `conditions` list is joined among itself, and joins nothing else.
 * Filters left unset do not constrain the result, so an otherwise empty
 * request selects the whole library.
 */
export interface WSResolvePopulationRequest extends WSBaseEvent {
    event: 'resolve_population_request';
    request_id: string;
    /** Library id or name. Null/absent = the user's default library. */
    library_id?: number | string | null;
    /**
     * Bare collection keys (never library-qualified); the backend
     * down-converts. ORed: an item matches when it is in ANY of them.
     */
    collection_keys?: string[] | null;
    /** Include items from subcollections of every scoped collection. */
    recursive: boolean;
    /** Exact tag names. ORed: an item matches when it carries ANY of them. */
    tags?: string[] | null;
    /** Only items that belong to no collection. */
    unfiled: boolean;
    /** Only items that carry no tags. */
    untagged: boolean;
    /** Additional search conditions, joined per `conditions_join_mode` and ANDed with the other filters. */
    conditions: ZoteroSearchCondition[];
    /**
     * How the entries of `conditions` are joined with each other. 'all' ANDs
     * them; 'any' ORs them, so an item matches when it satisfies at least one.
     * Absent or unrecognized = 'all'.
     *
     * It joins the `conditions` list ALONE. `collection_keys`, `tags`,
     * `unfiled`, `untagged`, `has_attachments` and `item_category` stay ANDed
     * with the conditions group and with each other, so 'any' can only be used
     * to widen within `conditions`.
     *
     * Under 'any' the list may not contain a `unfiled`, `retracted`,
     * `publications` or `feed` condition: Zotero applies each of those as a
     * search-wide flag rather than as a matchable condition, so it would be
     * ANDed with the other entries instead of ORed with them. Such a request
     * is rejected with `invalid_request` rather than resolved to a population
     * narrower than described.
     */
    conditions_join_mode?: 'all' | 'any' | null;
    /** 'regular' = bibliographic items, 'attachment' = child attachments. */
    item_category: 'regular' | 'attachment';
    /** Filter regular items by attachment presence; null = no filter. */
    has_attachments?: boolean | null;
    /**
     * Maximum number of ids to return. Further matches are counted, not
     * returned. 0 returns no ids (total_count is still the true match count).
     */
    max_items: number;
    /**
     * Item ids to leave out of the result. Applied before truncation to
     * `max_items`, so a caller paging one tranche at a time can reach the
     * next — excluding after would return the same first `max_items` matches
     * every time. Entries may use any id grammar; resolve each to this
     * device's library before comparing, do not match on the raw string.
     *
     * A handler that applies this MUST set `excluded_count` (including 0)
     * so the caller can tell a build that honoured the field from one that
     * ignored it.
     */
    exclude_item_ids?: string[] | null;
}

/** Response to resolve_population request */
export interface WSResolvePopulationResponse {
    type: 'resolve_population';
    request_id: string;
    /**
     * Matching item ids in portable form (`u-<key>` for the personal library,
     * `g<groupID>-<key>` for groups — group id, not the device-local library
     * id), deterministic order, length <= max_items.
     */
    item_ids: string[];
    /**
     * True number of matches, counted after any `exclude_item_ids` were
     * removed but before truncation.
     */
    total_count: number;
    /**
     * How many matching items `exclude_item_ids` removed.
     *
     * Presence confirms this build applied the exclusion. Set on every
     * successful resolution (0 when nothing was excluded); absent from a
     * failure and from a build that predates the field. A shrinking
     * population and an ignored field both come back short, so the ids
     * alone cannot tell them apart.
     */
    excluded_count?: number | null;
    /**
     * Number of bibliographic items the filters matched, counted before any
     * attachment population is derived from them and before truncation.
     *
     * Under `item_category: 'regular'` it equals `total_count`. Under
     * `item_category: 'attachment'` the two answer different questions:
     * `total_count` counts the attachments hanging off the matched items, so it
     * can be larger than this one, and it is 0 whenever none of the matched
     * items has an attachment. This count is therefore what separates "the
     * filters matched nothing" from "the filters matched, but none of the
     * matches has an attachment" — two cases that call for opposite
     * corrections. It says nothing about whether an attachment's file is
     * present on disk: an attachment record is counted either way.
     *
     * Set on every successful resolution; absent from a failure and from a
     * provider that predates the field.
     */
    matched_item_count?: number | null;
    /** True when total_count exceeded max_items and item_ids was cut short. */
    truncated: boolean;
    /**
     * Display names of the library and collections the filters resolved
     * against. The approval card names the population's location from these
     * and says nothing about it when they are absent, so omitting them costs
     * the user the WHERE half of what they are approving.
     *
     * `collection_names` is in the order `collection_keys` named them, and is
     * answered in full or not at all — the card cannot state the place from a
     * partial list, because the collections it skipped are part of the
     * population too.
     */
    library_name?: string | null;
    collection_names?: string[] | null;
    /**
     * The join mode actually applied to the request's `conditions`. Set on
     * every successful resolution, and absent from a failure.
     *
     * A caller that asked for 'any' must check it: a provider that predates the
     * field answers without it, having resolved the population under 'all' —
     * strictly narrower than what was asked for, and otherwise indistinguishable
     * from a correct answer.
     */
    conditions_join_mode?: 'all' | 'any' | null;
    error?: string | null;
    error_code?: string | null;
    /** Available libraries (only included when error_code is 'library_not_found') */
    available_libraries?: AvailableLibraryInfo[] | null;
    /**
     * Unused by this response: a condition Zotero refuses fails the whole
     * resolution with `error_code: 'invalid_condition'` instead. The population
     * is about to be mutated, so a filter that could not be applied as
     * described has to produce an answer that cannot be acted on — no ids —
     * rather than ids the caller is trusted to discard.
     *
     * Kept so a caller that also reads older answers can still see them.
     */
    warnings?: string[] | null;
}

/** Request from backend for get_metadata */
export interface WSGetMetadataRequest extends WSBaseEvent {
    event: 'get_metadata_request';
    request_id: string;
    item_ids: string[];
    include_attachments: boolean;
    include_notes: boolean;
    /**
     * What each row carries. Default 'full' — the historical behavior.
     *
     * 'compact' returns a {@link QuickSearchHit} per item (plus its `item_id`),
     * which is what a chip needs to render a bare reference from thread
     * history. It ignores `include_attachments` / `include_notes`, whose
     * payloads have no place in that projection.
     */
    detail?: ItemProjectionDetail;
}

/** Response to get_metadata request */
export interface WSGetMetadataResponse {
    type: 'get_metadata';
    request_id: string;
    /**
     * One row per resolved item. `QuickSearchHit & {item_id}` when `detail` is
     * 'compact', the full `toJSON` payload otherwise — branch on the echoed
     * `detail` rather than sniffing the rows.
     */
    items: Record<string, any>[];
    /** Projection the items are in; echoes the request's resolved `detail`.
     * Omitted by older providers, which always serve 'full'. */
    detail?: ItemProjectionDetail;
    not_found: string[];
    error?: string | null;
    error_code?: string | null;
}

/** Request from backend for get_annotations */
export interface WSGetAnnotationsRequest extends WSBaseEvent {
    event: 'get_annotations_request';
    request_id: string;
    attachment_id: string;
    limit: number;
    offset: number;
}

/** Response to get_annotations request */
export interface WSGetAnnotationsResponse {
    type: 'get_annotations';
    request_id: string;
    annotations: AnnotationResultItem[];
    total_count: number;
    error?: string | null;
    error_code?: string | null;
}

/** Request from backend for library-wide annotation search */
export interface WSFindAnnotationsRequest extends WSBaseEvent {
    event: 'find_annotations_request';
    request_id: string;
    text_contains?: string | null;
    comment_contains?: string | null;
    tag?: string | null;
    color?: string | null;
    annotation_type?: string | null;
    author?: string | null;
    attachment_id?: string | null;
    collection?: string | null;
    recursive: boolean;
    library_id?: number | string | null;
    modified_in_last?: string | null;
    sort_by: 'date_modified' | 'date_added' | 'reading_order';
    sort_order: 'asc' | 'desc';
    limit: number;
    offset: number;
}

/** Response to find_annotations request */
export interface WSFindAnnotationsResponse {
    type: 'find_annotations';
    request_id: string;
    annotations: AnnotationResultItem[];
    total_count: number;
    note?: string | null;
    error?: string | null;
    error_code?: string | null;
    available_libraries?: AvailableLibraryInfo[] | null;
}

// =============================================================================
// Library Management: List Collections
// =============================================================================

/** Request to list collections in a library */
export interface WSListCollectionsRequest extends WSBaseEvent {
    event: 'list_collections_request';
    request_id: string;
    library_id?: number | string | null;
    parent_collection_key?: string | null;
    include_item_counts: boolean;
    /**
     * List every descendant of the scope rather than its direct children only,
     * so a whole library is one call. Each row still carries `parent_key`, so
     * the caller can rebuild the tree.
     *
     * Gated by the `list_collections_recursive` client feature: a client
     * without it silently returns direct children only.
     */
    recursive?: boolean | null;
    limit: number;
    offset: number;
}

/** Collection information */
export interface CollectionInfo {
    library_id?: number;
    /** Device-portable library identity ("u" | "g<groupID>"). */
    library_ref?: string;
    collection_key: string;
    name: string;
    parent_key?: string | null;
    parent_name?: string | null;
    /**
     * Top-level regular items directly in this collection, excluding
     * attachments, notes and annotations.
     */
    item_count: number;
    /**
     * Attachments sitting directly in this collection rather than under a
     * parent item.
     */
    standalone_attachment_count?: number;
    /**
     * Notes sitting directly in this collection rather than under a parent
     * item.
     */
    standalone_note_count?: number;
    subcollection_count: number;
}

/** Response to list_collections request */
export interface WSListCollectionsResponse {
    type: 'list_collections';
    request_id: string;
    collections: CollectionInfo[];
    total_count: number;
    library_id?: number | null;
    /** Device-portable library identity ('u' / 'g<groupID>') of the listed library. */
    library_ref?: string;
    library_name?: string | null;
    error?: string | null;
    error_code?: string | null;
    /** Available libraries (only included when error_code is 'library_not_found') */
    available_libraries?: AvailableLibraryInfo[] | null;
}

// =============================================================================
// Library Management: List Tags
// =============================================================================

/** Request to list tags in a library */
export interface WSListTagsRequest extends WSBaseEvent {
    event: 'list_tags_request';
    request_id: string;
    library_id?: number | string | null;
    collection_key?: string | null;
    min_item_count: number;
    /**
     * Keep only tags whose name contains this substring, case-insensitively.
     * Pushed into SQL, so it reduces the provider's work as well as the wire —
     * the escape hatch for a library with too many tags to fetch and filter
     * locally.
     *
     * Gated by the `list_tags_name_query` client feature: a client without it
     * silently returns the unfiltered list.
     */
    name_query?: string | null;
    /**
     * Include tags imported with an item's metadata rather than added by the
     * user. Defaults to true when absent.
     *
     * Gated by the `list_tags_types` client feature: a client without it
     * ignores the field and returns every tag.
     */
    include_automatic?: boolean | null;
    limit: number;
    offset: number;
}

/** Tag information */
export interface TagInfo {
    name: string;
    /** Number of top-level regular items carrying this tag. */
    item_count: number;
    /** Number of attachments carrying this tag. Omitted by older frontends. */
    attachment_count?: number;
    /** Number of notes carrying this tag. Omitted by older frontends. */
    note_count?: number;
    /** Number of annotations carrying this tag. Omitted by older frontends. */
    annotation_count?: number;
    color?: string | null;
    /**
     * `manual` if any occurrence is user-added, `automatic` if every
     * occurrence was imported with an item's metadata. One name can be both
     * (`itemTags.type` is per pair); manual wins. Omitted by older clients.
     */
    tag_type?: 'manual' | 'automatic';
}

/** Response to list_tags request */
export interface WSListTagsResponse {
    type: 'list_tags';
    request_id: string;
    tags: TagInfo[];
    total_count: number;
    /**
     * Automatic tags in scope after the other filters. Counted even when
     * `include_automatic` is false (they then leave `tags` and `total_count`).
     * Always 0 from clients that do not report types.
     */
    automatic_count?: number;
    library_id?: number | null;
    /** Device-portable library identity ('u' / 'g<groupID>') of the listed library. */
    library_ref?: string;
    library_name?: string | null;
    error?: string | null;
    error_code?: string | null;
    /** Available libraries (only included when error_code is 'library_not_found') */
    available_libraries?: AvailableLibraryInfo[] | null;
}

// =============================================================================
// Library Management: List Libraries
// =============================================================================

/** Request to list all available libraries */
export interface WSListLibrariesRequest extends WSBaseEvent {
    event: 'list_libraries_request';
    request_id: string;
}

/** Per-library count snapshot */
export interface LibrarySummary {
    library_id: number;
    /** Device-portable library identity ("u" | "g<groupID>"). See `src/utils/libraryIdentity.ts`. */
    library_ref?: string;
    name: string;
    is_group: boolean;
    read_only: boolean;
    /** Regular items, excluding attachments, notes and annotations. */
    item_count: number;
    /**
     * Attachments that sit at the top level of the library rather than under a
     * parent item.
     */
    standalone_attachment_count?: number;
    /**
     * All notes in the library, both standalone and attached to an item. This
     * is a library-wide total, unlike the per-collection note count, which
     * covers only notes that are collection members in their own right.
     */
    note_count: number;
    collection_count: number;
    tag_count: number;
    /**
     * Opaque per-scope change markers, for a client caching this library's
     * collections or tags. Compare for equality and re-fetch on a mismatch;
     * never parse one, and never order two of them — the provider is free to
     * change how it computes them without a wire change.
     *
     * Per scope rather than per library so an item edit does not invalidate a
     * collection cache. Absent when the provider cannot compute them, which a
     * client must read as "no freshness oracle" (do not cache) rather than
     * "unchanged".
     */
    versions?: LibraryScopeVersions;
}

/** Per-scope change markers for one library. See `LibrarySummary.versions`. */
export interface LibraryScopeVersions {
    /**
     * Changes when the library's collections change (added, renamed, moved,
     * deleted). Deliberately **not** when the items inside them change, so a
     * response cached against this marker must be one taken with
     * `include_item_counts: false` — the counts would go stale under it.
     */
    collections?: string;
    /**
     * Changes when the library's tag list, per-tag usage or tag colors change.
     *
     * Scoped to the **library-wide** `list_tags` response. A response taken
     * with `collection_key` must not be cached against it: moving an
     * already-tagged item into or out of a collection changes which tags that
     * collection shows without changing any tag row or count in the library,
     * so this marker stays put while the scoped listing has moved. Cache the
     * library-wide list and narrow it client-side, or re-fetch a scoped list
     * every time.
     */
    tags?: string;
    /** Reserved for a surface that needs to cache items. Not emitted today. */
    items?: string;
}

/** Response to list_libraries request */
export interface WSListLibrariesResponse {
    type: 'list_libraries';
    request_id: string;
    libraries: LibrarySummary[];
    total_count: number;
    error?: string | null;
    error_code?: string | null;
}

// =============================================================================
// Deferred Tool Events (Agent Action Approval Workflow)
// =============================================================================

/** User preference for how deferred tools should behave */
export type DeferredToolPreference = 'always_ask' | 'always_apply' | 'continue_without_applying';

/** Agent action type for deferred tools */
export type AgentActionType = 'highlight_annotation' | 'note_annotation' | 'create_highlight_annotations' | 'create_note_annotations' | 'edit_annotations' | 'zotero_note' | 'create_item' | 'edit_metadata' | 'create_collection' | 'organize_items' | 'manage_tags' | 'manage_collections' | 'confirm_extraction' | 'confirm_external_search' | 'edit_note' | 'edit_note_batch' | 'create_note';

/** Request from backend to validate an agent action */
export interface WSAgentActionValidateRequest extends WSBaseEvent {
    event: 'agent_action_validate';
    request_id: string;
    action_type: AgentActionType;
    action_data: Record<string, any>;
}

/** Error information for a failed field validation */
export interface FieldValidationErrorInfo {
    field: string;
    error: string;
    error_code: 'field_restricted' | 'field_unknown' | 'field_invalid_for_type';
}

/**
 * Alternative snippet returned when an `old_string` lookup fails in a note
 * edit. The backend surfaces these to the model so it can pick a candidate or
 * rewrite `old_string` to match exactly. Snippets are pre-truncated on the
 * plugin side — the backend must not re-truncate them.
 */
export interface ErrorCandidate {
    snippet: string;
    truncated: boolean;
    via:
        | 'whitespace_relaxed'
        | 'word_overlap'
        | 'inline_tag_drift'
        | 'structural_anchor'
        | 'fuzzy_window';
    score: number;
}

/** Per-edit validation failure for batch actions (e.g. edit_note_batch). */
export interface EditValidationError {
    /** Position of the failing edit in the request's edits[] array */
    index: number;
    error: string;
    error_code?: string | null;
    error_candidates?: ErrorCandidate[];
}

/** Response to agent action validation request */
export interface WSAgentActionValidateResponse {
    type: 'agent_action_validate_response';
    request_id: string;
    valid: boolean;
    error?: string | null;
    error_code?: string | null;
    /** Detailed list of field validation errors (for batch validation) */
    errors?: FieldValidationErrorInfo[];
    /**
     * Ranked alternative snippets when an edit_note old_string lookup fails.
     * Present only with `error_code === 'old_string_not_found'`. Already
     * truncated — do not re-truncate.
     */
    error_candidates?: ErrorCandidate[];
    /**
     * Per-edit validation failures for batch actions (e.g. edit_note_batch).
     * Present only when validating a multi-edit payload and one or more edits
     * fail; the whole batch is rejected (fail-closed).
     */
    edit_errors?: EditValidationError[];
    /** Current value for before/after tracking. Shape depends on action_type. */
    current_value?: any;
    /**
     * Optional normalized action payload returned by validation.
     * When present, the backend should persist and later execute this data
     * instead of the original request action_data.
     */
    normalized_action_data?: Record<string, any>;
    /** Display names of the collections the action touches */
    collection_names?: Record<string, string>;
    preference: DeferredToolPreference;
    /** Optional warnings surfaced during validation */
    warnings?: string[];
    /**
     * Optional plugin-side timing breakdown in milliseconds. Free-form keys
     * scoped to action_type. Backend logs as-is — do not interpret.
     */
    timing?: Record<string, number>;
}

/** Request from backend to execute an agent action */
export interface WSAgentActionExecuteRequest extends WSBaseEvent {
    event: 'agent_action_execute';
    request_id: string;
    action_type: AgentActionType;
    action_data: Record<string, any>;
    /** Timeout in seconds for the frontend to complete execution (default: 25 seconds) */
    timeout_seconds?: number;
    /** Agent action ID */
    action_id?: string;
    /** Run ID */
    run_id?: string;
    /** Thread ID */
    thread_id?: string;
}

/** Response to agent action execution request */
export interface WSAgentActionExecuteResponse {
    type: 'agent_action_execute_response';
    request_id: string;
    success: boolean;
    error?: string | null;
    error_code?: string | null;
    /**
     * Ranked alternative snippets when an edit_note old_string lookup fails
     * at execute time. Present only with `error_code === 'old_string_not_found'`.
     * Already truncated — do not re-truncate.
     */
    error_candidates?: ErrorCandidate[];
    result_data?: Record<string, any>;
    /** Optional timing breakdown for diagnostics (e.g. create_item latency) */
    timing?: FrontendTimingMetadata;
}

/** Request from backend for user approval of a deferred action */
export interface WSDeferredApprovalRequest extends WSBaseEvent {
    event: 'deferred_approval_request';
    /** The AgentAction ID awaiting approval */
    action_id: string;
    /** The tool call ID this action belongs to (for UI matching) */
    toolcall_id: string;
    action_type: AgentActionType;
    action_data: Record<string, any>;
    /** Current value before the change. Shape depends on action_type. */
    current_value?: any;
}

/** Response to deferred approval request (user's decision) */
export interface WSDeferredApprovalResponse {
    type: 'deferred_approval_response';
    action_id: string;
    approved: boolean;
    /** Optional additional instructions from the user (e.g., 'Change title to X instead') */
    user_instructions?: string | null;
}

/**
 * The backend is no longer waiting on an approval we responded to.
 *
 * Sent when a `deferred_approval_response` arrives after the backend's wait
 * expired (the tool already returned `pending` and the run moved on). Without
 * it the client cannot tell a swallowed response from one still being
 * processed, and would show the card as "awaiting approval" indefinitely.
 *
 * The proposal itself is unaffected — it is still stored and still applicable —
 * so the client should restore the card's local apply/reject controls.
 */
export interface WSDeferredApprovalStale extends WSBaseEvent {
    event: 'deferred_approval_stale';
    /** The AgentAction ID whose approval response was too late */
    action_id: string;
    /**
     * `timed_out`: the backend was waiting and gave up.
     * `unknown`: no record of this action on this connection.
     */
    reason: 'timed_out' | 'unknown';
}

/**
 * Ask the user to confirm continuing a run that is projected to cost credits.
 *
 * Unlike a deferred approval this carries no `toolcall_id` and no agent action:
 * the decision covers the whole run, not one tool call, so it renders as a
 * run-level card rather than inline with a tool.
 *
 * `title`, `message`, `details` and the two button labels are composed by the
 * backend and must be rendered verbatim. The numeric fields (`pending_credits`,
 * `projected_total_credits`, `threshold`) are for client-side logging and
 * telemetry only — the client must never build its own prose from them, since
 * only the backend knows how the projection was formed.
 */
export interface WSCreditConfirmationRequest extends WSBaseEvent {
    event: 'credit_confirmation_request';
    /** Correlation id for the response */
    confirmation_id: string;
    /** The agent run awaiting confirmation */
    run_id: string;
    /** Thread the run belongs to */
    thread_id?: string | null;
    /** Card title, composed by the backend */
    title: string;
    /** Card body text, composed by the backend */
    message: string;
    /** Closing line about what continuing means */
    footer?: string;
    /** Backend-provided docs link text */
    learn_more_label?: string;
    /** Docs path resolved against the client's environment-specific docs URL */
    learn_more_path?: string;
    /** Label for the approve button */
    approve_label: string;
    /** Label for the decline button */
    decline_label: string;
    /** Extra credits this decision authorizes (logging/telemetry only) */
    pending_credits: number;
    /** Projected total credits for the run if it continues (logging only) */
    projected_total_credits: number;
    /** Credit threshold that triggered this confirmation (logging only) */
    threshold: number;
    /** How long the backend will wait for a response */
    timeout_seconds: number;
}

/** Response to a credit confirmation request (the user's decision) */
export interface WSCreditConfirmationResponse {
    type: 'credit_confirmation_response';
    confirmation_id: string;
    /** Whether the user let the run continue */
    approved: boolean;
    /**
     * Optional note from the user, passed to the model when the run continues
     * without the priced steps. Only meaningful alongside a declined decision:
     * an approval covers the rest of the run unconditionally, so it cannot
     * carry a condition.
     */
    user_instructions?: string | null;
}

/**
 * The backend is no longer waiting on a credit confirmation.
 *
 * Sent when a `credit_confirmation_response` arrives after the backend's wait
 * expired (the run already proceeded without the answer). Unlike a deferred
 * approval there is nothing to apply locally — the decision has no local
 * equivalent — so the client just retires the card.
 */
export interface WSCreditConfirmationStale extends WSBaseEvent {
    event: 'credit_confirmation_stale';
    /** The confirmation whose response was too late */
    confirmation_id: string;
    /**
     * `timed_out`: the backend was waiting and gave up.
     * `unknown`: no record of this confirmation on this connection.
     */
    reason: 'timed_out' | 'unknown';
}

/**
 * Coverage a batch approval grants.
 *
 * `full_access` lets the batch's library edits apply without asking again;
 * `ask_each_time` keeps every per-call prompt. Mirrors the backend's
 * `BatchApprovalMode`; the two must stay in step.
 */
export type BatchApprovalMode = 'full_access' | 'ask_each_time';

/**
 * Ask the user to approve a batch job before it starts mutating.
 *
 * One decision covers a whole batch rather than a single tool call, so this
 * renders as a run-level card. Unlike a credit confirmation it carries a
 * `toolcall_id` — the call that declared the batch — so the card can be
 * anchored to it.
 *
 * Every user-facing string here is composed by the backend and must be
 * rendered verbatim; the client contributes only its own chrome (the mode
 * labels and the instructions placeholder). `destructive_warning` is
 * model-authored prose about what the batch removes or overwrites and belongs
 * in its own visually distinct block; it is empty when the batch declared
 * nothing destructive, and the block is then hidden.
 */
export interface WSBatchApprovalRequest extends WSBaseEvent {
    event: 'batch_approval_request';
    /** Correlation id for the response */
    approval_id: string;
    /** The agent run awaiting approval */
    run_id: string;
    /** Thread the run belongs to */
    thread_id?: string | null;
    /** Tool call that declared the batch, so the client can anchor the card */
    toolcall_id: string;
    /** Id of the batch awaiting approval */
    batch_id: string;
    /** Card title, composed by the backend */
    title: string;
    /**
     * The population's size, e.g. "184 items" — the emphasised half of the
     * scope line, and always set.
     */
    scope_primary: string;
    /**
     * Where that population lives, e.g. "in Methods and its subcollections";
     * empty when it cannot be stated truthfully, and the card then shows the
     * count alone.
     */
    scope_secondary: string;
    /** The batch goal, composed by the backend */
    message: string;
    /**
     * What the batch removes or overwrites, rendered verbatim in its own
     * block; empty when the batch declared nothing destructive.
     */
    destructive_warning: string;
    /**
     * What the job costs the user directly, rendered verbatim in its own
     * block; set only for a run served by the user's own API key that is large
     * enough to warn about, and empty for everyone else. Distinct from
     * `credit_chip`, which quotes Beaver credits: a BYOK run's real cost is its
     * provider's bill, which no credit figure states. Absent from a backend
     * that predates the field.
     */
    cost_warning?: string;
    /**
     * Short line about the confirmation limit approving raises, shown beside
     * the title; empty when the run has no credit ledger or the user switched
     * confirmations off, and the chip is then hidden.
     */
    credit_chip: string;
    /**
     * The sentence the chip abbreviates, shown on hover; empty under the same
     * conditions as the chip.
     */
    credit_tooltip: string;
    /** Coverage mode the card preselects */
    default_mode: BatchApprovalMode;
    /** Label for the approve button */
    approve_label: string;
    /** Label for the decline button */
    decline_label: string;
    /** Label the decline button takes once the user has typed instructions */
    decline_with_instructions_label?: string;
    /** Backend-provided docs link text; empty means no link */
    learn_more_label?: string;
    /** Docs path resolved against the client's environment-specific docs URL */
    learn_more_path?: string;
    /**
     * Initial contents of the instructions box; a non-empty value also
     * opens it. Set only for a continuation, from the instructions the
     * earlier batch was approved with. An editable default — whatever
     * the response carries is what binds.
     */
    user_instructions_prefill?: string;
    /** How long the backend will wait for a response */
    timeout_seconds: number;
}

/**
 * Response to a batch approval request (the user's decision).
 *
 * Both outcomes may carry instructions: on an approval they constrain how the
 * batch runs, on a decline they say what to do instead.
 */
export interface WSBatchApprovalResponse {
    type: 'batch_approval_response';
    approval_id: string;
    /** Whether the user approved the batch */
    approved: boolean;
    /** Coverage the approval grants */
    mode: BatchApprovalMode;
    /**
     * Optional instructions from the user, kept in front of the model for the
     * life of the batch and taking precedence over the batch goal.
     */
    user_instructions?: string | null;
}

/**
 * The backend is no longer waiting on a batch approval.
 *
 * Sent when a `batch_approval_response` arrives after the backend's wait
 * expired. The batch then runs with no coverage and every mutating call keeps
 * its own prompt, so there is nothing to apply locally — the client just
 * retires the card.
 */
export interface WSBatchApprovalStale extends WSBaseEvent {
    event: 'batch_approval_stale';
    /** The approval whose response was too late */
    approval_id: string;
    /**
     * `timed_out`: the backend was waiting and gave up.
     * `unknown`: no record of this approval on this connection.
     */
    reason: 'timed_out' | 'unknown';
}

/** One selectable option of an ask_user_question item (ids are server-assigned) */
export interface AskUserQuestionOption {
    /** Server-assigned option id (e.g. 'q0-o1') */
    id: string;
    /** Display text for the option */
    label: string;
    /** Optional one-line explanation or tradeoff */
    description?: string | null;
}

/** One question of an ask_user_question request */
export interface AskUserQuestionItem {
    /** Server-assigned question id (e.g. 'q0') */
    id: string;
    /** Very short chip label for the question (max ~12 chars) */
    header?: string | null;
    /** The complete question to show the user */
    question: string;
    /** Selectable options, recommended option first */
    options: AskUserQuestionOption[];
    /** Whether multiple options may be selected */
    allow_multiple?: boolean;
    /** Whether a free-text 'Other' answer is offered */
    allow_custom?: boolean;
}

/**
 * Request from backend to ask the user structured multiple-choice question(s).
 * The agent run blocks until the frontend sends a WSAskUserQuestionResponse
 * with the matching question_id (or the backend-side timeout elapses).
 *
 * Like deferred_approval_request, this event carries no request_id — the
 * response is correlated by question_id.
 */
export interface WSAskUserQuestionRequest extends WSBaseEvent {
    event: 'ask_user_question_request';
    /** Correlation id for the response */
    question_id: string;
    /** The tool call ID this question belongs to (for inline UI matching) */
    toolcall_id: string;
    /** Optional card title */
    title?: string | null;
    /** The questions to present (1-4) */
    questions: AskUserQuestionItem[];
}

/** The user's answer to a single question of an ask_user_question request */
export interface AskUserQuestionAnswer {
    /** Matches AskUserQuestionItem.id (e.g. 'q0') */
    item_id: string;
    /** Ids of the selected options */
    selected_option_ids: string[];
    /** Free-text 'Other' answer the user typed, if any */
    custom_text?: string | null;
}

/** Response to an ask_user_question request (user's answers, or a skip) */
export interface WSAskUserQuestionResponse {
    type: 'ask_user_question_response';
    question_id: string;
    answers: AskUserQuestionAnswer[];
    /** True when the user skipped the question(s) (or no handler is registered) */
    cancelled: boolean;
}

/** Union type for all WebSocket events */
export type WSEvent =
    | WSReadyEvent
    | WSRequestAckEvent
    | WSPartEvent
    | WSToolReturnEvent
    | WSToolCallProgressEvent
    | WSToolCallArgsStreamEvent
    | WSRunCompleteEvent
    | WSRunCitationsEvent
    | WSStreamingDoneEvent
    | WSDoneEvent
    | WSThreadEvent
    | WSThreadNameEvent
    | WSErrorEvent
    | WSWarningEvent
    | WSRetryEvent
    | WSAgentActionsEvent
    | WSMissingZoteroDataEvent
    | WSZoteroDocumentRequest
    | WSZoteroAttachmentPageImagesRequest
    | WSZoteroAttachmentImageRequest
    | WSZoteroViewImagesRequest
    | WSZoteroAttachmentSearchRequest
    | WSExternalReferenceCheckRequest
    | WSZoteroDataRequest
    | WSItemSearchByMetadataRequest
    | WSItemSearchByTopicRequest
    | WSItemQuickSearchRequest
    // Library management tools
    | WSZoteroSearchRequest
    | WSListItemsRequest
    | WSResolvePopulationRequest
    | WSListCollectionsRequest
    | WSListTagsRequest
    | WSGetMetadataRequest
    | WSGetAnnotationsRequest
    | WSFindAnnotationsRequest
    | WSListLibrariesRequest
    // Note tools
    | WSReadNoteRequest
    // Deferred tool events
    | WSAgentActionValidateRequest
    | WSAgentActionExecuteRequest
    | WSDeferredApprovalRequest
    | WSDeferredApprovalStale
    // Run-level credit confirmation
    | WSCreditConfirmationRequest
    | WSCreditConfirmationStale
    // Run-level batch approval
    | WSBatchApprovalRequest
    | WSBatchApprovalStale
    // User interaction events
    | WSAskUserQuestionRequest;


// =============================================================================
// Client Message Types (sent from frontend to backend)
// =============================================================================

/**
 * Authentication message sent immediately after WebSocket connection opens.
 * Must be the first message sent by the client.
 */
export interface WSAuthMessage {
    type: 'auth';
    /** JWT authentication token */
    token: string;
    /** frontend version */
    frontend_version?: string;
    /** Client identifier (e.g. 'zotero-plugin', 'word-addin'). Absent for older
     * clients; the backend treats a missing value as 'zotero-plugin'. */
    client_type?: string;
    /** Features this client supports. When provided, the backend gates tools on
     * this set instead of deriving it from `frontend_version`. */
    client_features?: string[];
    /** Identifies the specific Zotero install behind this connection. Lets the
     * backend tell apart multiple installs of one Beaver account (e.g. work +
     * home both open) and show the user a recognizable label. Absent for
     * non-Zotero clients. */
    zotero_instance?: ZoteroInstanceWire;
    /** Provider-mode handshakes only: echo of the `wake_id` from the
     * provider-wake broadcast that triggered this connection. Absent for chat
     * connections and for provider connections opened without a wake. */
    wake_id?: string;
    /** Provider-mode handshakes only: echo of the originating backend
     * `instance_id` from the wake broadcast (multi-instance routing seam). */
    wake_instance_id?: string;
    /**
     * Total connect attempts for this handshake including the successful one.
     * New clients always send this, including `1` on first-try success.
     */
    connect_attempts: number;
    /**
     * Milliseconds from the start of the initial connection attempt until auth
     * was sent on this socket. Includes failed attempts and retry backoff.
     */
    connect_latency_ms: number;
    /** Compact summary of the failed attempt that triggered auto-retry. */
    last_connect_failure?: {
        stage: string;
        close_code?: number | null;
        timed_out?: boolean;
    };
}

/**
 * Wire shape (snake_case) identifying a Zotero install. `local_user_key` is always
 * present and unique per install — the discriminator when one Beaver account has
 * several installs connected. The rest are best-effort context/labels (`user_id`/
 * `account_name` are absent when Zotero sync is off).
 *
 * `index_scope_refs` carries the install's searchable index scope — search-
 * index scope refs for libraries not excluded in Beaver Preferences.
 */
export interface ZoteroInstanceWire {
    local_user_key: string;
    user_id?: string;
    account_name?: string;
    device_name?: string;
    /** Search-index scope refs in scope: `l<localUserKey>` (personal, always) and
     * `g<groupID>` values for searchable libraries.
     */
    index_scope_refs?: string[];
}

/**
 * Client feature identifiers — the shared vocabulary a client declares in the
 * auth handshake (`WSAuthMessage.client_features`) so the backend gates tools on
 * declared support rather than inferring from `frontend_version`. The string
 * values MUST match the backend's `FEAT_*` constants exactly.
 */
export const CLIENT_FEATURES = {
    LIBRARY_MANAGEMENT: 'library_management',
    MANAGE_LIBRARY_STRUCTURE: 'manage_library_structure',
    NOTE_SUPPORT: 'note_support',
    NOTE_APPEND: 'note_append',
    ANNOTATION_SUPPORT: 'annotation_support',
    FIND_ANNOTATIONS: 'find_annotations',
    EXTRACT: 'extract',
    BEAVER_EXTRACT: 'beaver_extract',
    IMAGE_EXTRACTION: 'image_extraction',
    VIEW_PAGE_IMAGES: 'view_page_images',
    READ_TOOL: 'read_tool',
    VIEW_TOOL: 'view_tool',
    FIND_IN_ATTACHMENTS: 'find_in_attachments',
    DOCUMENT_PAYLOAD_BUDGET: 'document_payload_budget',
    FILTER_ONLY_SEARCH: 'filter_only_search',
    SENTENCE_LEVEL_CITATION: 'sentence_level_citation',
    UNIFIED_CITATION_FORMAT: 'unified_citation_format',
    CITATION_V2: 'citation_v2',
    TOOL_RESULT_VIEW: 'tool_result_view',
    EXTERNAL_SEARCH_SURCHARGE: 'external_search_surcharge',
    EDIT_METADATA_CREATORS: 'edit_metadata_creators',
    EXTERNAL_FILES: 'external_files',
    ASK_USER_QUESTION: 'ask_user_question',
    PORTABLE_IDS: 'portable_ids',
    LIST_ITEMS_INCLUDE_CHILDREN: 'list_items_include_children',
    CREATE_NOTE_TAGS_COLLECTIONS: 'create_note_tags_collections',
    /** Batch multi-edit note editing (edit_note_batch action type). */
    EDIT_NOTE_BATCH: 'edit_note_batch',
    /** Atomic common-field editing for annotations returned by find_annotations. */
    EDIT_ANNOTATIONS: 'edit_annotations',
    /**
     * Citations arrive on their own `run_citations` event instead of inside
     * `run_complete`, so the run is reported finished as soon as it is durable
     * rather than after the backend has finished asking us about its citations.
     */
    CITATIONS_EVENT: 'citations_event',
    /**
     * `collections_filter` on the search tools matches items in the named
     * collections *and their subcollections*. Older clients matched direct
     * membership only, so the backend warns the model about that when this
     * feature is absent.
     */
    RECURSIVE_COLLECTIONS_FILTER: 'recursive_collections_filter',
    /**
     * `item_quick_search_request`: one-string search ORed across title-like
     * fields, creators and the year. A client asking for it without this
     * feature would get no handler and wait out the request timeout, so the
     * backend refuses the op up front instead.
     */
    ITEM_QUICK_SEARCH: 'item_quick_search',
    /**
     * `list_collections` honors `recursive`, listing every descendant of the
     * scope instead of its direct children. A client without it ignores the
     * flag and answers with direct children only, which reads as a complete
     * library that happens to be flat.
     */
    LIST_COLLECTIONS_RECURSIVE: 'list_collections_recursive',
    /**
     * `list_tags` honors `name_query`, filtering tag names in SQL. A client
     * without it ignores the parameter and returns the unfiltered list, which
     * reads as "these are the matches".
     */
    LIST_TAGS_NAME_QUERY: 'list_tags_name_query',
    /**
     * `list_tags` reports each tag as `manual` or `automatic` and honors
     * `include_automatic`. A client without it ignores the flag and returns
     * every tag untyped, which must not be presented as the user's vocabulary.
     */
    LIST_TAGS_TYPES: 'list_tags_types',
    /**
     * `credit_confirmation_request`: the run's credit cost is confirmed once per
     * run instead of per tool call. A client declaring it is asked at the
     * threshold its `ChargingPermissions` carry; a client without it keeps the
     * per-tool `confirm_extraction` / `confirm_external_search` approvals.
     */
    CREDIT_CONFIRMATION: 'credit_confirmation',
    /** `batch_jobs` capability (batch_start / batch_resolve). */
    BATCH_JOBS: 'batch_jobs',
    /** `citation_graph` capability (`find_related_works`). */
    CITATION_GRAPH: 'citation_graph',
    /**
     * `create_item` actions carry `pdf_candidates`: a ranked list of places the
     * PDF might be downloaded from.
     */
    PDF_CANDIDATES: 'pdf_candidates',
} as const;

/** Client type identifier for the Zotero plugin. */
export const ZOTERO_PLUGIN_CLIENT_TYPE = 'zotero-plugin';

/** Client type identifier for the Word add-in. */
export const WORD_ADDIN_CLIENT_TYPE = 'word-addin';

/**
 * The Beaver clients this build knows about, for code that has to branch on
 * which client it is running as. These are wire values: the handshake sends one
 * as `WSAuthMessage.client_type` and the backend keys its per-client agent
 * mapping on them, so a client cannot rename one on its own.
 *
 * `WSAuthMessage.client_type` itself stays a plain `string` — a backend may
 * know clients a given build does not.
 */
export type BeaverClientType =
    | typeof ZOTERO_PLUGIN_CLIENT_TYPE
    | typeof WORD_ADDIN_CLIENT_TYPE;

/**
 * Agent the backend runs for, and stamps on threads created by, the Zotero
 * plugin. Threads are listed per agent, so this is what scopes the plugin's
 * thread list to its own threads.
 */
export const ZOTERO_AGENT_NAME = 'beaver';

/**
 * Features the current Zotero plugin build always declares in the auth
 * handshake.
 */
export const ZOTERO_PLUGIN_FEATURES: string[] = Object.values(CLIENT_FEATURES);

/** Current library context for application state */
export interface CurrentLibrary {
    /** Library ID */
    library_id: number;
    /** Device-portable library identity ("u" | "g<groupID>"). See `src/utils/libraryIdentity.ts`. */
    library_ref?: string;
    /** Library name (e.g., "My Library" or group name) */
    name: string;
    /** Whether this is a group library */
    is_group: boolean;
    /** Whether the library data is read-only (not editable) */
    read_only: boolean;
    /** Whether the library is synced with Beaver (Pro feature) */
    is_synced: boolean;
}

/** Current collection context for application state */
export interface CurrentCollection {
    /** Collection key */
    collection_key: string;
    /** Collection name */
    name: string;
    /** Library ID this collection belongs to */
    library_id: number;
    /** Device-portable library identity ("u" | "g<groupID>"). See `src/utils/libraryIdentity.ts`. */
    library_ref?: string;
    /** Parent collection key, if this is a subcollection */
    parent_key?: string | null;
    /**
     * Top-level regular items directly in this collection, excluding
     * attachments, notes, annotations and anything trashed. Counts are for
     * direct membership only — a subcollection's contents are not included.
     */
    item_count?: number;
    /**
     * Attachments sitting directly in this collection. Counted separately from
     * `item_count` so a collection of loose files is not reported as empty.
     */
    standalone_attachment_count?: number;
    /**
     * Notes sitting directly in this collection. Notes attached to an item are
     * reached through that item and are not collection members themselves, so
     * they are not counted here.
     */
    note_count?: number;
    /** Direct, non-trashed subcollections of this collection. */
    subcollection_count?: number;
}

/**
 * A saved search selected in the collections pane. Saved searches can be
 * selected alongside collections, so they are reported as their own list
 * rather than folded into `current_collections`.
 */
export interface CurrentSavedSearch {
    /** Saved search key */
    search_key: string;
    /** Saved search name */
    name: string;
    /** Library ID this saved search belongs to */
    library_id: number;
    /** Device-portable library identity ("u" | "g<groupID>"). See `src/utils/libraryIdentity.ts`. */
    library_ref?: string;
}

/**
 * Application state sent with messages.
 * Contains current view state and reader state if in reader view.
 */
export interface ApplicationStateInput {
    /** Current application view ('library', 'file_reader', or 'note_editor') */
    current_view: 'library' | 'file_reader' | 'note_editor';
    /** Reader state when in reader view */
    reader_state?: ReaderState;
    /** Note state when in note editor view */
    note_state?: NoteState;
    /** Current library context */
    current_library?: CurrentLibrary;
    /**
     * First selected collection.
     *
     * Superseded by `current_collections`, which carries the whole selection.
     * Still emitted alongside it so a client reporting a multi-row selection
     * stays understandable to a server that only reads the single-collection
     * field. Prefer `current_collections` when consuming.
     */
    current_collection?: CurrentCollection;
    /**
     * Every selected collection, in selection order. The collections pane
     * supports selecting several rows at once, and a selection can span
     * libraries — each entry carries its own `library_id`/`library_ref`.
     */
    current_collections?: CurrentCollection[];
    /**
     * Saved searches in the current selection, in selection order. A selection
     * can mix collections and saved searches, so this list is independent of
     * `current_collections`.
     */
    current_searches?: CurrentSavedSearch[];
    /**
     * Currently selected library items, truncated to a client-defined maximum.
     */
    library_selection?: ZoteroItemReference[];
    /** Number of items the user actually has selected, before truncation. */
    library_selection_total_count?: number;
    /** Frontend embedding index status */
    indexing_status?: IndexingStatus;
    /** Per-library summary stats (counts) for searchable libraries. */
    libraries?: LibrarySummary[];
}

/** Frontend embedding index status reported with each agent run. */
export interface IndexingStatus {
    /** True when the initial indexing pass is complete (semantic search ready). */
    is_complete: boolean;
    /**
     * Percent of items indexed across the initial pass (0-100).
     * Omitted when complete or when total_items is 0 (no signal to report).
     */
    percent_complete?: number;
    /** Total items expected in the initial pass. Omitted when complete. */
    total_items?: number;
    /** Items still pending indexing. Omitted when zero or when complete. */
    items_pending?: number;
    /** Items permanently failed (cannot be retried). Omitted when zero. */
    items_failed?: number;
}

export interface ChargingPermissions {
    /**
     * Per-tool cost confirmations, read only by a backend that predates the
     * run-level credit confirmation. Omitted by this build: such a backend
     * defaults them to asking, which is the safe direction.
     */
    confirm_extraction_costs?: boolean;
    confirm_external_search_costs?: boolean;
    /**
     * Whether to ask the user to confirm a run projected to cost credits at all.
     * Read only for clients that declare CLIENT_FEATURES.CREDIT_CONFIRMATION,
     * for which it supersedes the two per-tool booleans above.
     */
    confirm_credits: boolean;
    /**
     * Total credits a single request may be projected to use before the user is
     * asked to confirm it — the whole run cost, not just the surcharges. `null`
     * uses the server default. Read only for clients that declare
     * CLIENT_FEATURES.CREDIT_CONFIRMATION.
     */
    credit_confirm_threshold: number | null;
    /**
     * Whether to pause a long-running run at a turn threshold, read only by a
     * backend that predates the long-running surcharge. Omitted by this build:
     * such a backend defaults to pausing, which is the safe direction. A
     * current backend meters run length instead and ignores this.
     */
    pause_long_running_agent?: boolean;
}

/**
 * Agent run request sent by the client after receiving the 'ready' event.
 * Model selection is included in this request (moved from auth message).
 */
export interface AgentRunRequest {
    /** Request type discriminator */
    type: 'chat';
    /** Client-generated run ID for this agent run */
    run_id: string;
    /** Thread ID (new UUID for new thread, existing UUID for continuation) */
    thread_id: string | null;
    /** The user's message */
    user_prompt: BeaverAgentPrompt;
    /** Permissions for the agent run */
    permissions: ChargingPermissions;
    /** When true and using your own API key, enables plus tools for a reduced credit cost */
    request_plus_tools?: boolean;
    /** UUID of model_configs entry (mutually exclusive with custom_model) */
    model_id?: string;
    /** User's API key for BYOK models */
    api_key?: string;
    /** Custom model configuration (mutually exclusive with model_id) */
    custom_model?: CustomChatModel;
    /**
     * Legacy, no longer sent by this client. Instructed the server to retry
     * from this run ID, deleting it and all subsequent runs. Retries now
     * commit their removal through `POST /threads/{id}/truncate` before the
     * run request is sent; the field stays documented because the backend
     * keeps accepting it from released clients.
     */
    retry_run_id?: string;
    /**
     * Legacy, no longer sent by this client (see `retry_run_id`). The run IDs
     * the client still held after dropping the ones it was regenerating.
     */
    retry_keep_run_ids?: string[];
    /**
     * Who started this retry. Set on the run request that follows a retry's
     * truncate call, which is the only thing marking that request as a retry.
     * Only `auto` reorders the backend's model chain, for the same reason an
     * automatic resume does — the provider that just aborted should not lead
     * the next attempt. Omitted on an ordinary message.
     */
    retry_trigger?: RetryTrigger;
    /** Pre-generated assistant message ID (optional) */
    assistant_message_id?: string;
}


// =============================================================================
// Callback Types
// =============================================================================

/** Data received in the ready event */
export interface WSReadyData {
    subscriptionStatus: SubscriptionStatus;
    processingMode: ProcessingMode;
    indexingComplete: boolean;
}

/** Data received in the request_ack event */
export interface WSRequestAckData {
    runId: string;
    modelId: string | null;
    modelName: string | null;
    chargeType: ChargeType;
}

export interface WSCallbacks {
    /**
     * Called when the server is ready to accept chat requests.
     * This is sent after connection authentication completes.
     * @param data Ready event data containing subscription info
     */
    onReady: (data: WSReadyData) => void;

    /**
     * Called when a chat request is acknowledged and model is validated.
     * This is sent after the chat request is received and validated.
     * @param data Request ack data containing model and charge info
     */
    onRequestAck?: (data: WSRequestAckData) => void;

    /**
     * Called when a part event is received (text, thinking, or tool_call).
     * May be async to pre-load item data before updating state.
     * @param event The part event with run_id, message_index, part_index, and part data
     */
    onPart: (event: WSPartEvent) => void | Promise<void>;

    /**
     * Called when a tool return event is received.
     * May be async to process tool return results.
     * @param event The tool return event with run_id, message_index, and part data
     */
    onToolReturn: (event: WSToolReturnEvent) => void | Promise<void>;

    /**
     * Called when a tool call progress event is received
     * @param event The tool call progress event with run_id, message_index, and part data
     */
    onToolCallProgress: (event: WSToolCallProgressEvent) => void;

    /**
     * Called when streaming tool call arguments are received for live preview.
     * @param event The tool call args stream event with partially-parsed arguments
     */
    onToolCallArgsStream: (event: WSToolCallArgsStreamEvent) => void;

    /**
     * Called when the agent run completes.
     * May be async to load item data for agent actions.
     * @param event The run complete event with usage and cost info
     */
    onRunComplete: (event: WSRunCompleteEvent) => void | Promise<void>;

    /**
     * Called when a run's citations have been resolved, after `onRunComplete`.
     * May be async to preload page labels for cited attachments.
     * @param event The citations event, possibly with an empty list
     */
    onRunCitations?: (event: WSRunCitationsEvent) => void | Promise<void>;

    /**
     * Called when LLM streaming ends but post-processing (citations) is still running.
     * Use to show footer with loading state before citations are resolved.
     */
    onStreamingDone?: (event: WSStreamingDoneEvent) => void;

    /**
     * Called when the full request is done (after persistence, usage logging, etc.)
     * Safe to close connection or send another request after this.
     */
    onDone: () => void;

    /**
     * Called when a thread is initialized or created
     * @param threadId The thread ID
     * @param truncation What the server removed reconciling the thread against
     *        the client's asserted state, when it removed anything. Absent from
     *        backends that predate the report.
     */
    onThread: (threadId: string, truncation?: WSRetryTruncation | null) => void;

    /**
     * Called when the backend generates a name for a new thread
     * @param event The thread name event with thread_id and name
     */
    onThreadName?: (event: WSThreadNameEvent) => void;

    /**
     * Called when an error occurs
     * @param event The error event
     */
    onError: (event: WSErrorEvent) => void;

    /**
     * Called when a warning occurs (non-fatal)
     * @param event The warning event
     */
    onWarning: (event: WSWarningEvent) => void;

    /**
     * Called when an agent action is detected during streaming.
     * May be async to load item data for agent actions.
     * @param event The agent action event with run_id and action data
     */
    onAgentActions?: (event: WSAgentActionsEvent) => void | Promise<void>;

    /**
     * Called when the backend is retrying a failed request
     * @param event The retry event with attempt info and reason
     */
    onRetry?: (event: WSRetryEvent) => void;

    /**
     * Called when referenced items are not available in the backend cache.
     * Frontend should determine the reason and display a warning.
     * @param event The missing zotero data event with item references
     */
    onMissingZoteroData?: (event: WSMissingZoteroDataEvent) => void;

    /**
     * Called when the backend requests user approval for a deferred action.
     * The frontend should show an approval UI and call the provided callback.
     * @param event The deferred approval request with action details
     */
    onDeferredApprovalRequest?: (event: WSDeferredApprovalRequest) => void;

    /**
     * Called when an approval response we sent arrived too late to be used.
     * The frontend should stop showing the action as awaiting a decision and
     * restore its local apply/reject controls.
     * @param event The stale-approval notice, keyed by action id
     */
    onDeferredApprovalStale?: (event: WSDeferredApprovalStale) => void;

    /**
     * Called when the backend asks the user to confirm the run's credit cost.
     * The frontend should render the backend-composed card verbatim and send a
     * WSCreditConfirmationResponse when the user decides.
     * @param event The confirmation request with copy and correlation id
     */
    onCreditConfirmationRequest?: (event: WSCreditConfirmationRequest) => void;

    /**
     * Called when a credit confirmation response we sent arrived too late to be
     * used. The frontend should retire the card; there is nothing to apply
     * locally.
     * @param event The stale-confirmation notice, keyed by confirmation id
     */
    onCreditConfirmationStale?: (event: WSCreditConfirmationStale) => void;

    /**
     * Called when the backend asks the user to approve a batch job before
     * it starts mutating. The frontend should render the backend-composed card
     * verbatim and send a WSBatchApprovalResponse when the user decides.
     * @param event The approval request with copy and correlation id
     */
    onBatchApprovalRequest?: (event: WSBatchApprovalRequest) => void;

    /**
     * Called when a batch approval response we sent arrived too late to be
     * used. The frontend should retire the card; there is nothing to apply
     * locally.
     * @param event The stale-approval notice, keyed by approval id
     */
    onBatchApprovalStale?: (event: WSBatchApprovalStale) => void;

    /**
     * Called when the backend asks the user structured multiple-choice
     * question(s). The frontend should render the question card and send a
     * WSAskUserQuestionResponse when the user submits or skips.
     * @param event The question request with questions and correlation id
     */
    onAskUserQuestionRequest?: (event: WSAskUserQuestionRequest) => void;

    /**
     * Called when the WebSocket connection is established
     */
    onOpen?: () => void;

    /**
     * Called when the WebSocket connection is closed
     * @param code Close code
     * @param reason Close reason
     * @param wasClean Whether the connection closed cleanly
     */
    onClose?: (
        code: number,
        reason: string,
        wasClean: boolean,
        evidence?: ConnectionFailureEvidence,
    ) => void;
}
