import { SubscriptionStatus, ProcessingMode, ChargeType } from '../../react/types/profile';
import { TextPart, ThinkingPart, ToolCallPart, ToolReturnPart, RetryPromptPart, RunUsage } from '../../react/agents/types';
import { ZoteroItemReference } from '../../react/types/zotero';
import { ItemDataWithStatus, AttachmentDataWithStatus } from '../../react/types/zotero';
import { ReaderState } from '../../react/types/attachments/apiTypes';
import { BeaverAgentPrompt } from '../../react/agents/types';
import { CustomChatModel } from '../../react/types/settings';
import { AttachmentData, ItemData } from '../../react/types/zotero';

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

/** Run complete event signaling the agent run finished */
export interface WSRunCompleteEvent extends WSBaseEvent {
    event: 'run_complete';
    run_id: string;
    usage: RunUsage | null;
    cost: number | null;
    citations: import('../../react/types/citations').CitationMetadata[] | null;
    agent_actions: import('../../react/agents/agentActions').AgentAction[] | null;
}

/** Done event signaling the request is fully complete (after persistence, usage logging, etc.) */
export interface WSDoneEvent extends WSBaseEvent {
    event: 'done';
}

/** Thread event sent when a thread is initialized or created */
export interface WSThreadEvent extends WSBaseEvent {
    event: 'thread';
    thread_id: string;
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
    actions: import('../../react/agents/agentActions').AgentAction[];
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

export interface WSPageContent {
    /** 1-indexed page number */
    page_number: number;
    /** Text content of the page */
    content: string;
}

export interface WSPageImage {
    /** 1-indexed page number */
    page_number: number;
    /** Base64-encoded image data */
    image_data: string;
    /** Image format (png or jpeg) */
    format: 'png' | 'jpeg';
    /** Image width in pixels */
    width: number;
    /** Image height in pixels */
    height: number;
}

/** Request from backend to fetch attachment page content */
export interface WSZoteroAttachmentPagesRequest extends WSBaseEvent {
    event: 'zotero_attachment_pages_request';
    request_id: string;
    attachment: ZoteroItemReference;
    /** 1-indexed start page (inclusive, defaults to 1) */
    start_page?: number;
    /** 1-indexed end page (inclusive, defaults to total pages) */
    end_page?: number;
    /** Skip local file size and page count limits. Default: false */
    skip_local_limits?: boolean;
}

/** Request from backend to render attachment pages as images */
export interface WSZoteroAttachmentPageImagesRequest extends WSBaseEvent {
    event: 'zotero_attachment_page_images_request';
    request_id: string;
    attachment: ZoteroItemReference;
    /** 1-indexed page numbers to render (defaults to all pages if not specified) */
    pages?: number[];
    /** Scale factor (1.0 = 72 DPI, 2.0 = 144 DPI, etc.). Default: 1.0 */
    scale?: number;
    /** Target DPI (alternative to scale, takes precedence if provided) */
    dpi?: number;
    /** Output format. Default: "png" */
    format?: 'png' | 'jpeg';
    /** JPEG quality (1-100), only used for format="jpeg". Default: 85 */
    jpeg_quality?: number;
    /** Skip local file size and page count limits. Default: false */
    skip_local_limits?: boolean;
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
}

/** Item search result with attachments (unified format) */
export interface ItemSearchFrontendResultItem {
    item: ItemData;
    attachments: AttachmentDataWithStatus[];
    /** Semantic similarity score (0-1) for topic searches, undefined for metadata searches */
    similarity?: number;
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
}

/** Error codes for item search failures */
export type ItemSearchErrorCode =
    | 'internal_error'      // General internal error
    | 'database_error'      // Database/indexing error
    | 'invalid_request'     // Invalid request parameters
    | 'timeout';            // Operation timed out

/** Response to item metadata search request */
export interface WSItemSearchByMetadataResponse {
    type: 'item_search_by_metadata';
    request_id: string;
    items: ItemSearchFrontendResultItem[];
    /** Error message if search failed */
    error?: string | null;
    /** Error code for programmatic handling */
    error_code?: ItemSearchErrorCode | null;
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
}

/** Request from backend to fetch Zotero item/attachment data */
export interface WSZoteroDataRequest extends WSBaseEvent {
    event: 'zotero_data_request';
    request_id: string;
    /** Whether to include attachments of the items */
    include_attachments: boolean;
    /** Whether to include parents of the items */
    include_parents: boolean;
    /** References to fetch data for */
    items: ZoteroItemReference[];
}

/** Response to zotero data request */
export interface WSZoteroDataResponse {
    type: 'zotero_data';
    request_id: string;
    /** Item metadata with status for successfully retrieved items */
    items: ItemDataWithStatus[];
    /** Attachment metadata with status for successfully retrieved attachments */
    attachments: AttachmentDataWithStatus[];
    /** Optional errors for references that couldn't be retrieved */
    errors?: WSDataError[];
}

/** Error codes for attachment page extraction failures */
export type AttachmentPagesErrorCode =
    | 'not_found'           // Attachment not found in Zotero
    | 'not_pdf'             // Attachment is not a PDF
    | 'file_missing'        // PDF file not available locally
    | 'file_too_large'      // PDF file exceeds size limit
    | 'encrypted'           // PDF is password-protected
    | 'no_text_layer'       // PDF needs OCR
    | 'invalid_pdf'         // Invalid/corrupted PDF
    | 'too_many_pages'      // PDF exceeds page count limit
    | 'page_out_of_range'   // Requested pages are out of range
    | 'extraction_failed';  // General extraction failure

/** Response to zotero attachment pages request */
export interface WSZoteroAttachmentPagesResponse {
    type: 'zotero_attachment_pages';
    request_id: string;
    attachment: ZoteroItemReference;
    /** Extracted page content (empty array if error) */
    pages: WSPageContent[];
    /** Total number of pages in the document */
    total_pages: number | null;
    /** Error message if extraction failed */
    error?: string | null;
    /** Error code for programmatic handling */
    error_code?: AttachmentPagesErrorCode | null;
}

/** Error codes for attachment page image rendering failures */
export type AttachmentPageImagesErrorCode =
    | 'not_found'           // Attachment not found in Zotero
    | 'not_pdf'             // Attachment is not a PDF
    | 'file_missing'        // PDF file not available locally
    | 'file_too_large'      // PDF file exceeds size limit
    | 'encrypted'           // PDF is password-protected
    | 'invalid_pdf'         // Invalid/corrupted PDF
    | 'too_many_pages'      // PDF exceeds page count limit
    | 'page_out_of_range'   // Requested pages are out of range
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
}

/** Error codes for attachment search failures */
export type AttachmentSearchErrorCode =
    | 'not_found'           // Attachment not found in Zotero
    | 'not_pdf'             // Attachment is not a PDF
    | 'file_missing'        // PDF file not available locally
    | 'file_too_large'      // PDF file exceeds size limit
    | 'encrypted'           // PDF is password-protected
    | 'invalid_pdf'         // Invalid/corrupted PDF
    | 'too_many_pages'      // PDF exceeds page count limit
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
    /** Skip local file size and page count limits. Default: false */
    skip_local_limits?: boolean;
}

/** A single search hit within a page */
export interface WSSearchHit {
    /** Hit bounding box in MuPDF format {x, y, w, h} */
    bbox: { x: number; y: number; w: number; h: number };
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
    limit: number;
    offset: number;
    fields?: string[] | null;
}

/** Result item from zotero_search */
export interface ZoteroSearchResultItem {
    item_id: string;
    item_type: string;
    title?: string | null;
    creators?: string | null;
    year?: number | null;
    extra_fields?: Record<string, any> | null;
}

/** Brief library info for error responses */
export interface AvailableLibraryInfo {
    library_id: number;
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
}

/** Request from backend for list_items */
export interface WSListItemsRequest extends WSBaseEvent {
    event: 'list_items_request';
    request_id: string;
    library_id?: number | string | null;
    collection_key?: string | null;
    tag?: string | null;
    item_category: ZoteroItemCategory;
    recursive: boolean;
    sort_by: string;
    sort_order: string;
    limit: number;
    offset: number;
}

/** Result item from list_items */
export interface ListItemsResultItem {
    item_id: string;
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

/** Request from backend for get_metadata */
export interface WSGetMetadataRequest extends WSBaseEvent {
    event: 'get_metadata_request';
    request_id: string;
    item_ids: string[];
    /** Specific field names to include. null = all fields. */
    fields?: string[] | null;
    include_attachments: boolean;
    /** Not supported yet - always false from backend */
    include_notes: boolean;
    include_tags: boolean;
    include_collections: boolean;
}

/** Response to get_metadata request */
export interface WSGetMetadataResponse {
    type: 'get_metadata';
    request_id: string;
    items: Record<string, any>[];
    not_found: string[];
    error?: string | null;
    error_code?: string | null;
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
    limit: number;
    offset: number;
}

/** Collection information */
export interface CollectionInfo {
    collection_key: string;
    name: string;
    parent_key?: string | null;
    parent_name?: string | null;
    item_count: number;
    subcollection_count: number;
}

/** Response to list_collections request */
export interface WSListCollectionsResponse {
    type: 'list_collections';
    request_id: string;
    collections: CollectionInfo[];
    total_count: number;
    library_id?: number | null;
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
    limit: number;
    offset: number;
}

/** Tag information */
export interface TagInfo {
    name: string;
    item_count: number;
    color?: string | null;
}

/** Response to list_tags request */
export interface WSListTagsResponse {
    type: 'list_tags';
    request_id: string;
    tags: TagInfo[];
    total_count: number;
    library_id?: number | null;
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

/** Library information */
export interface LibraryInfo {
    library_id: number;
    name: string;
    is_group: boolean;
    read_only: boolean;
    item_count: number;
    collection_count: number;
    tag_count: number;
}

/** Response to list_libraries request */
export interface WSListLibrariesResponse {
    type: 'list_libraries';
    request_id: string;
    libraries: LibraryInfo[];
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
export type AgentActionType = 'highlight_annotation' | 'note_annotation' | 'zotero_note' | 'create_item' | 'edit_metadata' | 'create_collection' | 'organize_items';

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

/** Response to agent action validation request */
export interface WSAgentActionValidateResponse {
    type: 'agent_action_validate_response';
    request_id: string;
    valid: boolean;
    error?: string | null;
    error_code?: string | null;
    /** Detailed list of field validation errors (for batch validation) */
    errors?: FieldValidationErrorInfo[];
    /** Current value for before/after tracking. Shape depends on action_type. */
    current_value?: any;
    preference: DeferredToolPreference;
}

/** Request from backend to execute an agent action */
export interface WSAgentActionExecuteRequest extends WSBaseEvent {
    event: 'agent_action_execute';
    request_id: string;
    action_type: AgentActionType;
    action_data: Record<string, any>;
}

/** Response to agent action execution request */
export interface WSAgentActionExecuteResponse {
    type: 'agent_action_execute_response';
    request_id: string;
    success: boolean;
    error?: string | null;
    error_code?: string | null;
    result_data?: Record<string, any>;
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

/** Union type for all WebSocket events */
export type WSEvent =
    | WSReadyEvent
    | WSRequestAckEvent
    | WSPartEvent
    | WSToolReturnEvent
    | WSToolCallProgressEvent
    | WSRunCompleteEvent
    | WSDoneEvent
    | WSThreadEvent
    | WSErrorEvent
    | WSWarningEvent
    | WSRetryEvent
    | WSAgentActionsEvent
    | WSMissingZoteroDataEvent
    | WSZoteroAttachmentPagesRequest
    | WSZoteroAttachmentPageImagesRequest
    | WSZoteroAttachmentSearchRequest
    | WSExternalReferenceCheckRequest
    | WSZoteroDataRequest
    | WSItemSearchByMetadataRequest
    | WSItemSearchByTopicRequest
    // Library management tools
    | WSZoteroSearchRequest
    | WSListItemsRequest
    | WSListCollectionsRequest
    | WSListTagsRequest
    | WSGetMetadataRequest
    | WSListLibrariesRequest
    // Deferred tool events
    | WSAgentActionValidateRequest
    | WSAgentActionExecuteRequest
    | WSDeferredApprovalRequest;


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
}

/**
 * Application state sent with messages.
 * Contains current view state and reader state if in reader view.
 */
export interface ApplicationStateInput {
    /** Current application view ('library' or 'reader') */
    current_view: 'library' | 'file_reader';
    /** Reader state when in reader view */
    reader_state?: ReaderState;
    /** Currently selected library ID (optional) */
    library_selection?: ZoteroItemReference[];
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
    /** UUID of model_configs entry (mutually exclusive with custom_model) */
    model_id?: string;
    /** User's API key for BYOK models */
    api_key?: string;
    /** Custom model configuration (mutually exclusive with model_id) */
    custom_model?: CustomChatModel;
    /** If set, instructs the server to retry from this run ID, deleting it and all subsequent runs */
    retry_run_id?: string;
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
     * Called when a part event is received (text, thinking, or tool_call)
     * @param event The part event with run_id, message_index, part_index, and part data
     */
    onPart: (event: WSPartEvent) => void;

    /**
     * Called when a tool return event is received
     * @param event The tool return event with run_id, message_index, and part data
     */
    onToolReturn: (event: WSToolReturnEvent) => void;

    /**
     * Called when a tool call progress event is received
     * @param event The tool call progress event with run_id, message_index, and part data
     */
    onToolCallProgress: (event: WSToolCallProgressEvent) => void;

    /**
     * Called when the agent run completes
     * @param event The run complete event with usage and cost info
     */
    onRunComplete: (event: WSRunCompleteEvent) => void;

    /**
     * Called when the full request is done (after persistence, usage logging, etc.)
     * Safe to close connection or send another request after this.
     */
    onDone: () => void;

    /**
     * Called when a thread is initialized or created
     * @param threadId The thread ID
     */
    onThread: (threadId: string) => void;

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
     * Called when an agent action is detected during streaming
     * @param event The agent action event with run_id and action data
     */
    onAgentActions?: (event: WSAgentActionsEvent) => void;

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
     * Called when the WebSocket connection is established
     */
    onOpen?: () => void;

    /**
     * Called when the WebSocket connection is closed
     * @param code Close code
     * @param reason Close reason
     * @param wasClean Whether the connection closed cleanly
     */
    onClose?: (code: number, reason: string, wasClean: boolean) => void;
}
