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
    /** Library ID to search in */
    library_id: number;
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

/** Zotero item search result with attachments (unified format) */
export interface ZoteroItemSearchResultItem {
    item: ItemData;
    attachments: AttachmentDataWithStatus[];
}

/** Request from backend to search Zotero library */
export interface WSZoteroItemSearchRequest extends WSBaseEvent {
    event: 'zotero_item_search_request';
    request_id: string;

    // Query parameters (at least one required, combined with AND)
    /** List of phrases to search in title+abstract (OR'd within, AND'd with other queries) */
    topic_query?: string[];
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

/** Response to zotero item search request */
export interface WSZoteroItemSearchResponse {
    type: 'zotero_item_search';
    request_id: string;
    items: ZoteroItemSearchResultItem[];
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
    | WSExternalReferenceCheckRequest
    | WSZoteroDataRequest
    | WSZoteroItemSearchRequest;


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
