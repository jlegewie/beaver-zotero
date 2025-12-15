/**
 * Agent Service
 * 
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 * 
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */

import { supabase } from './supabaseClient';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { logger } from '../utils/logger';
import { SubscriptionStatus, ChargeType, ProcessingMode } from '../../react/types/profile';
import { ReaderState } from '../../react/types/attachments/apiTypes';
import { AgentRun, BeaverAgentPrompt } from '../../react/agents/types';
import { AgentAction, toAgentAction } from '../../react/agents/agentActions';
import { AttachmentDataWithMimeType, ItemData, ZoteroItemReference } from '../../react/types/zotero';
import { CustomChatModel } from '../../react/types/settings';
import { serializeAttachment, serializeItem } from '../utils/zoteroSerializers';
import { ApiService } from './apiService';
import { findExistingReference, FindReferenceData } from '../../react/utils/findExistingReference';

// =============================================================================
// WebSocket Event Types (matching backend ws_events.py)
// =============================================================================

import {
    TextPart,
    ThinkingPart,
    RetryPromptPart,
    ToolCallPart,
    ToolReturnPart,
    RunUsage,
} from '../../react/agents/types';

/** Base interface for all WebSocket events from the server */
interface WSBaseEvent {
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
}

/** Agent action event sent when an action is detected during streaming */
export interface WSAgentActionsEvent extends WSBaseEvent {
    event: 'agent_actions';
    run_id: string;
    actions: import('../../react/agents/agentActions').AgentAction[];
}

export interface WSDataError {
    reference: ZoteroItemReference;
    error: string;
    error_code?: string;
}

export interface WSPageContent {
    page_number: number;
    content: string;
}

export interface WSAttachmentContentRequest extends WSBaseEvent {
    event: 'attachment_content_request';
    request_id: string;
    attachment: ZoteroItemReference;
    page_numbers?: number[] | null;
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
    /** Item metadata for references that are regular items */
    items: ItemData[];
    /** Attachment metadata for references that are attachments */
    attachments: AttachmentDataWithMimeType[];
    /** Optional errors for references that couldn't be retrieved */
    errors?: WSDataError[];
}

export interface WSAttachmentContentResponse {
    type: 'attachment_content';
    request_id: string;
    attachment: ZoteroItemReference;
    pages: WSPageContent[];
    total_pages?: number | null;
    error?: string | null;
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
    | WSAttachmentContentRequest
    | WSExternalReferenceCheckRequest
    | WSZoteroDataRequest;

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
    /** UUID of plan_model_access entry (mutually exclusive with custom_model) */
    access_id?: string;
    /** User's API key for plan models that require BYOK */
    api_key?: string;
    /** Custom model configuration (mutually exclusive with access_id) */
    custom_model?: CustomChatModel;
    /** If set, instructs the server to retry from this run ID, deleting it and all subsequent runs */
    retry_run_id?: string;
    /** Custom system instructions for this request */
    custom_instructions?: string;
    /** Pre-generated assistant message ID (optional) */
    assistant_message_id?: string;
    /** frontend version */
    frontend_version?: string;
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

// =============================================================================
// Agent Service
// =============================================================================

export class AgentService {
    private baseUrl: string;
    private ws: WebSocket | null = null;
    private callbacks: WSCallbacks | null = null;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }

    /**
     * Get WebSocket URL from HTTP base URL
     */
    private getWebSocketUrl(): string {
        const wsProtocol = this.baseUrl.startsWith('https') ? 'wss' : 'ws';
        const httpUrl = new URL(this.baseUrl);
        return `${wsProtocol}://${httpUrl.host}/api/v1/agents/beaver/run`;
    }

    /**
     * Get auth token from Supabase session
     */
    private async getAuthToken(): Promise<string> {
        const { data, error } = await supabase.auth.getSession();

        if (error) {
            logger(`AgentService: Error getting session: ${error.message}`, 2);
            throw new Error('Error retrieving user session');
        }

        if (!data.session?.access_token) {
            throw new Error('User not authenticated');
        }

        return data.session.access_token;
    }

    /**
     * Check if WebSocket is currently connected
     */
    isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    /**
     * Connect to the WebSocket endpoint and send an agent run request
     * 
     * Protocol flow:
     * 1. Client connects with clean URL (no sensitive data in params)
     * 2. Client sends WSAuthMessage with token only
     * 3. Server authenticates and sends "ready" event
     * 4. Client sends agent run request (with model selection: access_id/api_key or custom_model)
     * 5. Server validates model and sends "request_ack" event
     * 6. Server streams delta events and sends complete event
     * 
     * @param request The agent run request to send (should include access_id/api_key or custom_model)
     * @param callbacks Event callbacks
     * @returns Promise that resolves when connection is established and ready, rejects on error
     */
    async connect(request: AgentRunRequest, callbacks: WSCallbacks): Promise<void> {
        // Close existing connection if any
        this.close();

        this.callbacks = callbacks;

        try {
            const token = await this.getAuthToken();

            // Auth message now only contains token - model selection is in chat request
            const authMessage: WSAuthMessage = {
                type: 'auth',
                token,
            };

            // Connect with clean URL (no sensitive data in params)
            const wsUrl = this.getWebSocketUrl();

            logger(`AgentService: Connecting to ${wsUrl}`, 1);

            return new Promise<void>((resolve, reject) => {
                let hasResolved = false;

                // Wrap the onReady callback to send request after ready
                const wrappedCallbacks: WSCallbacks = {
                    ...callbacks,
                    onReady: (data: WSReadyData) => {
                        logger('AgentService: Server ready, sending agent run request', 1);
                        // Call the original onReady callback first
                        callbacks.onReady(data);
                        // Send the chat request now that server is ready
                        this.send(request);
                        // Resolve the connect promise
                        if (!hasResolved) {
                            hasResolved = true;
                            resolve();
                        }
                    },
                    onError: (event: WSErrorEvent) => {
                        // Call the original error callback
                        callbacks.onError(event);
                        // If we haven't resolved yet, this is a connection-phase error
                        if (!hasResolved) {
                            hasResolved = true;
                            reject(new Error(`${event.type}: ${event.message}`));
                        }
                    }
                };

                this.callbacks = wrappedCallbacks;
                this.ws = new WebSocket(wsUrl);

                this.ws.onopen = () => {
                    logger('AgentService: Connection established, sending auth message', 1);
                    // Send auth message immediately after connection opens
                    this.ws?.send(JSON.stringify(authMessage));
                    callbacks.onOpen?.();
                    // Note: Don't resolve here - wait for ready event
                };

                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };

                this.ws.onerror = (event) => {
                    logger(`AgentService: Connecting to Beaver failed`, 1);
                    // Note: The error event doesn't contain useful info in browsers
                    // The actual error will come through onclose
                    if (!hasResolved) {
                        hasResolved = true;
                        reject(new Error('Connecting to Beaver failed'));
                    }
                };

                this.ws.onclose = (event) => {
                    logger(`AgentService: Connection closed - code=${event.code}, reason=${event.reason}, clean=${event.wasClean}`, 1);
                    callbacks.onClose?.(event.code, event.reason, event.wasClean);
                    this.ws = null;
                    this.callbacks = null;
                    // If we haven't resolved yet, the connection closed before ready
                    if (!hasResolved) {
                        hasResolved = true;
                        reject(new Error(`Connection closed: ${event.reason || 'Unknown reason'}`));
                    }
                };
            });
        } catch (error) {
            logger(`AgentService: Connection setup error: ${error}`, 1);
            throw error;
        }
    }

    /**
     * Send a message to the server
     */
    send(data: AgentRunRequest | Record<string, any>): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            logger('AgentService: Cannot send - WebSocket not connected', 1);
            return;
        }

        const message = JSON.stringify(data);
        logger(`AgentService: Sending message: ${message}`, 1);
        this.ws.send(message);
    }

    /**
     * Handle incoming WebSocket message
     */
    private handleMessage(rawData: string): void {
        if (!this.callbacks) return;

        // Guard against invalid data during close handshake
        if (typeof rawData !== 'string' || !rawData) {
            logger('AgentService: Received invalid message data (likely during close)', 1);
            return;
        }

        let event: WSEvent;
        try {
            event = JSON.parse(rawData) as WSEvent;
        } catch (error) {
            logger(`AgentService: Failed to parse message: ${error}`, 1);
            // Only report parse errors if we're still actively listening
            if (this.callbacks) {
                this.callbacks.onError({
                    event: 'error',
                    type: 'parse_error',
                    message: 'Failed to parse server message',
                });
            }
            return;
        }

        try {
            logger(`AgentService: Received event: ${event.event}`, 1);

            switch (event.event) {
                case 'ready': {
                    // Convert snake_case backend response to camelCase frontend data
                    const readyData: WSReadyData = {
                        subscriptionStatus: event.subscription_status,
                        processingMode: event.processing_mode,
                        indexingComplete: event.indexing_complete,
                    };
                    this.callbacks.onReady(readyData);
                    break;
                }

                case 'request_ack': {
                    // Request acknowledged with model info
                    const ackData: WSRequestAckData = {
                        runId: event.run_id,
                        modelId: event.model_id,
                        modelName: event.model_name,
                        chargeType: event.charge_type,
                    };
                    this.callbacks.onRequestAck?.(ackData);
                    break;
                }

                case 'part':
                    this.callbacks.onPart(event);
                    break;

                case 'tool_return':
                    this.callbacks.onToolReturn(event);
                    break;
                
                case 'tool_call_progress':
                    this.callbacks.onToolCallProgress(event);
                    break;

                case 'run_complete':
                    this.callbacks.onRunComplete(event);
                    break;

                case 'done':
                    this.callbacks.onDone();
                    break;

                case 'thread':
                    this.callbacks.onThread(event.thread_id);
                    break;

                case 'error':
                    // Call onError first, then clear callbacks before closing
                    // to prevent race conditions during close handshake
                    this.callbacks.onError(event);
                    this.callbacks = null;
                    this.close(1011, `Server error: ${event.type}`);
                    break;

                case 'warning':
                    this.callbacks.onWarning(event);
                    break;

                case 'agent_actions':
                    this.callbacks.onAgentActions?.(event);
                    break;

                case 'retry':
                    this.callbacks.onRetry?.(event);
                    break;

                case 'attachment_content_request':
                    this.handleAttachmentContentRequest(event).catch((error) => {
                        logger(`AgentService: Failed to handle attachment_content_request: ${error}`, 1);
                        this.callbacks?.onError({
                            event: 'error',
                            type: 'attachment_content_request_failed',
                            message: String(error),
                        });
                    });
                    break;

                case 'external_reference_check_request':
                    this.handleExternalReferenceCheckRequest(event).catch((error) => {
                        logger(`AgentService: Failed to handle external_reference_check_request: ${error}`, 1);
                        this.callbacks?.onError({
                            event: 'error',
                            type: 'external_reference_check_request_failed',
                            message: String(error),
                        });
                    });
                    break;

                case 'zotero_data_request':
                    this.handleZoteroDataRequest(event).catch((error) => {
                        logger(`AgentService: Failed to handle zotero_data_request: ${error}`, 1);
                        this.callbacks?.onError({
                            event: 'error',
                            type: 'zotero_data_request_failed',
                            message: String(error),
                        });
                    });
                    break;

                default:
                    logger(`AgentService: Unknown event type: ${(event as any).event}`, 1);
            }
        } catch (error) {
            logger(`AgentService: Error handling event: ${error}`, 1);
            // Only report handling errors if we're still actively listening
            if (this.callbacks) {
                this.callbacks.onError({
                    event: 'error',
                    type: 'event_handling_error',
                    message: 'Failed to handle server event',
                    details: String(error),
                });
            }
        }
    }

    /**
     * Close the WebSocket connection
     * @param code Optional close code (default: 1000 for normal closure)
     * @param reason Optional close reason
     */
    close(code: number = 1000, reason: string = 'Client closing'): void {
        if (this.ws) {
            logger(`AgentService: Closing connection - code=${code}, reason=${reason}`, 1);
            this.ws.close(code, reason);
            this.ws = null;
        }
        this.callbacks = null;
    }

    /**
     * Cancel the current run and close the connection.
     * Sends a cancel message to the backend before closing to ensure proper cleanup.
     * @param waitMs Time to wait after sending cancel before closing (default: 50ms)
     */
    async cancel(waitMs: number = 50): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            logger('AgentService: Cannot cancel - WebSocket not connected', 1);
            this.close();
            return;
        }

        // Send cancel message to backend
        logger('AgentService: Sending cancel message', 1);
        this.ws.send(JSON.stringify({ type: 'cancel' }));

        // Wait briefly to allow the message to be flushed
        await new Promise(resolve => setTimeout(resolve, waitMs));

        // Close the connection
        this.close(1000, 'User cancelled');
    }

    /**
     * Handle attachment_content_request event.
     * Currently returns placeholder content until full extraction is implemented.
     */
    private async handleAttachmentContentRequest(request: WSAttachmentContentRequest): Promise<void> {
        const pageNumbers = request.page_numbers && request.page_numbers.length > 0
            ? request.page_numbers
            : [1];

        const pages: WSPageContent[] = pageNumbers.map((pageNumber) => ({
            page_number: pageNumber,
            content: 'Attachment content retrieval not implemented yet.'
        }));

        const response: WSAttachmentContentResponse = {
            type: 'attachment_content',
            request_id: request.request_id,
            attachment: request.attachment,
            pages,
            total_pages: null,
            error: 'Attachment content retrieval not implemented'
        };

        this.send(response);
    }

    /**
     * Handle external_reference_check_request event.
     * Checks if references exist in Zotero library using findExistingReference.
     */
    private async handleExternalReferenceCheckRequest(request: WSExternalReferenceCheckRequest): Promise<void> {
        const results: ExternalReferenceCheckResult[] = [];

        // Process all items in parallel for efficiency
        const checkPromises = request.items.map(async (item): Promise<ExternalReferenceCheckResult> => {
            try {
                const referenceData: FindReferenceData = {
                    title: item.title,
                    date: item.date,
                    DOI: item.doi,
                    ISBN: item.isbn,
                    creators: item.creators
                };

                const existingItem = await findExistingReference(request.library_id, referenceData);

                if (existingItem) {
                    return {
                        id: item.id,
                        exists: true,
                        item: {
                            library_id: existingItem.libraryID,
                            zotero_key: existingItem.key
                        }
                    };
                }

                return {
                    id: item.id,
                    exists: false
                };
            } catch (error) {
                logger(`AgentService: Failed to check reference ${item.id}: ${error}`, 1);
                // Return as not found on error
                return {
                    id: item.id,
                    exists: false
                };
            }
        });

        const resolvedResults = await Promise.all(checkPromises);
        results.push(...resolvedResults);

        const response: WSExternalReferenceCheckResponse = {
            type: 'external_reference_check',
            request_id: request.request_id,
            results
        };

        this.send(response);
    }

    /**
     * Handle zotero_data_request event.
     * Fetches item/attachment metadata for the requested references.
     * Optionally includes attachments of items and/or parents of attachments.
     */
    private async handleZoteroDataRequest(request: WSZoteroDataRequest): Promise<void> {
        const errors: WSDataError[] = [];

        // Track keys to avoid duplicates when including parents/attachments
        const itemKeys = new Set<string>();
        const attachmentKeys = new Set<string>();

        // Collect Zotero items to serialize
        const itemsToSerialize: Zotero.Item[] = [];
        const attachmentsToSerialize: Zotero.Item[] = [];

        const makeKey = (libraryId: number, zoteroKey: string) => `${libraryId}-${zoteroKey}`;

        // Phase 1: Collect all items and attachments to process
        for (const reference of request.items) {
            try {
                const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(reference.library_id, reference.zotero_key);
                if (!zoteroItem) {
                    errors.push({
                        reference,
                        error: 'Item not found in local database',
                        error_code: 'not_found'
                    });
                    continue;
                }

                if (zoteroItem.isAttachment()) {
                    const key = makeKey(zoteroItem.libraryID, zoteroItem.key);
                    if (!attachmentKeys.has(key)) {
                        attachmentKeys.add(key);
                        attachmentsToSerialize.push(zoteroItem);
                    }

                    // Include parent item if requested
                    if (request.include_parents && zoteroItem.parentID) {
                        const parentItem = await Zotero.Items.getAsync(zoteroItem.parentID);
                        if (parentItem && !parentItem.isAttachment()) {
                            const parentKey = makeKey(parentItem.libraryID, parentItem.key);
                            if (!itemKeys.has(parentKey)) {
                                itemKeys.add(parentKey);
                                itemsToSerialize.push(parentItem);
                            }
                        }
                    }
                } else if (zoteroItem.isRegularItem()) {
                    const key = makeKey(zoteroItem.libraryID, zoteroItem.key);
                    if (!itemKeys.has(key)) {
                        itemKeys.add(key);
                        itemsToSerialize.push(zoteroItem);
                    }

                    // Include attachments if requested
                    if (request.include_attachments) {
                        const attachmentIds = zoteroItem.getAttachments();
                        for (const attachmentId of attachmentIds) {
                            const attachment = await Zotero.Items.getAsync(attachmentId);
                            if (attachment) {
                                const attKey = makeKey(attachment.libraryID, attachment.key);
                                if (!attachmentKeys.has(attKey)) {
                                    attachmentKeys.add(attKey);
                                    attachmentsToSerialize.push(attachment);
                                }
                            }
                        }
                    }
                }
            } catch (error: any) {
                logger(`AgentService: Failed to collect zotero data ${reference.library_id}-${reference.zotero_key}: ${error}`, 1);
                errors.push({
                    reference,
                    error: 'Failed to load item/attachment',
                    error_code: 'load_failed'
                });
            }
        }

        // Phase 2: Serialize all items and attachments in parallel
        const [itemResults, attachmentResults] = await Promise.all([
            Promise.all(itemsToSerialize.map(async (item) => {
                try {
                    await item.loadAllData();
                } catch (e) {
                    // Ignore benign load errors
                }
                return serializeItem(item, undefined);
            })),
            Promise.all(attachmentsToSerialize.map(async (attachment) => {
                try {
                    await attachment.loadAllData();
                } catch (e) {
                    // Ignore benign load errors
                }
                const serialized = await serializeAttachment(attachment, undefined);
                if (!serialized) {
                    errors.push({
                        reference: { library_id: attachment.libraryID, zotero_key: attachment.key },
                        error: 'Attachment not available locally',
                        error_code: 'not_available'
                    });
                }
                return serialized;
            }))
        ]);

        // Filter out null attachments
        const items = itemResults;
        const attachments = attachmentResults.filter((a): a is AttachmentDataWithMimeType => a !== null);

        const response: WSZoteroDataResponse = {
            type: 'zotero_data',
            request_id: request.request_id,
            items,
            attachments,
            errors: errors.length > 0 ? errors : undefined
        };

        this.send(response);
    }
}

// =============================================================================
// Agent Run REST API Types
// =============================================================================

/** Response for getting thread runs with optional actions */
export interface ThreadRunsResponse {
    runs: AgentRun[];
    agent_actions: AgentAction[] | null;
}

/** Response for getting a single run with optional actions */
export interface AgentRunWithActionsResponse {
    run: AgentRun;
    agent_actions: AgentAction[] | null;
}

/** Response for paginated runs list */
export interface PaginatedRunsResponse {
    data: AgentRun[];
    next_cursor: string | null;
    has_more: boolean;
}

// =============================================================================
// Agent Run REST API Service
// =============================================================================

/**
 * Service for managing agent runs via REST API.
 * Handles fetching runs, run details, and associated actions.
 */
export class AgentRunService extends ApiService {
    constructor(baseUrl: string) {
        super(baseUrl);
    }

    /**
     * Gets all runs for a thread with optional agent actions.
     * @param threadId The thread ID to fetch runs for
     * @param includeActions Whether to include agent actions in the response
     * @returns Promise with runs and optionally actions
     */
    async getThreadRuns(
        threadId: string,
        includeActions: boolean = false
    ): Promise<ThreadRunsResponse> {
        let endpoint = `/api/v1/agents/beaver/threads/${threadId}/runs`;
        if (includeActions) {
            endpoint += '?include_actions=true';
        }
        
        const response = await this.get<{ runs: AgentRun[]; agent_actions?: Record<string, any>[] | null }>(endpoint);
        
        return {
            runs: response.runs,
            agent_actions: response.agent_actions?.map(toAgentAction) ?? null
        };
    }

    /**
     * Gets a single run by ID with optional agent actions.
     * @param runId The run ID to fetch
     * @param includeActions Whether to include agent actions in the response
     * @returns Promise with the run and optionally actions
     */
    async getRun(
        runId: string,
        includeActions: boolean = false
    ): Promise<AgentRunWithActionsResponse> {
        let endpoint = `/api/v1/agents/beaver/runs/${runId}`;
        if (includeActions) {
            endpoint += '?include_actions=true';
        }
        
        const response = await this.get<{ run: AgentRun; agent_actions?: Record<string, any>[] | null }>(endpoint);
        
        return {
            run: response.run,
            agent_actions: response.agent_actions?.map(toAgentAction) ?? null
        };
    }

    /**
     * Gets paginated list of all runs for the current user.
     * @param limit Maximum number of runs to return (default: 20)
     * @param after Cursor for pagination (run ID of the last item from previous page)
     * @returns Promise with paginated runs data
     */
    async getRuns(
        limit: number = 20,
        after: string | null = null
    ): Promise<PaginatedRunsResponse> {
        let endpoint = `/api/v1/agents/beaver/runs?limit=${limit}`;
        if (after) {
            endpoint += `&after=${after}`;
        }
        
        return this.get<PaginatedRunsResponse>(endpoint);
    }
}

// =============================================================================
// Singleton Exports
// =============================================================================

export const agentService = new AgentService(API_BASE_URL);
export const agentRunService = new AgentRunService(API_BASE_URL);
