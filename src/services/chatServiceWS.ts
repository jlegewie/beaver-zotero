/**
 * WebSocket-based Chat Service
 * 
 * This service provides WebSocket communication for chat completions,
 * offering bidirectional communication as an alternative to the SSE-based chatService.
 * 
 * It will eventually replace the SSE implementation as more features are added.
 */

import { supabase } from './supabaseClient';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { logger } from '../utils/logger';
import { SubscriptionStatus, ChargeType, ProcessingMode } from '../../react/types/profile';
import { ReaderState } from '../../react/types/attachments/apiTypes';
import { BeaverAgentPrompt } from '../../react/agents/types';
import { AttachmentDataWithMimeType, ItemData, ZoteroItemReference } from '../../react/types/zotero';
import { CustomChatModel } from '../../react/types/settings';
import { serializeAttachment, serializeItem } from '../utils/zoteroSerializers';

// =============================================================================
// WebSocket Event Types (matching backend ws_events.py)
// =============================================================================

import {
    TextPart,
    ThinkingPart,
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
    model_id: string | null;
    model_name: string | null;
    subscription_status: SubscriptionStatus;
    charge_type: ChargeType;
    processing_mode: ProcessingMode;
    indexing_complete: boolean;
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
    part: ToolReturnPart;
}

/** Run complete event signaling the agent run finished */
export interface WSRunCompleteEvent extends WSBaseEvent {
    event: 'run_complete';
    run_id: string;
    usage: RunUsage | null;
    cost: number | null;
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
    type: string;
    message: string;
    run_id?: string;
    details?: string;
}

/** Warning event types */
export type WSWarningType =
    | 'user_key_failed'
    | 'user_key_rate_limit_exceeded'
    | 'user_key_failed_unexpected'
    | 'missing_attachments'
    | 'low_credits';

/** Warning event for non-fatal issues */
export interface WSWarningEvent extends WSBaseEvent {
    event: 'warning';
    run_id: string;
    type: WSWarningType;
    message: string;
    data?: Record<string, any>;
}

/** Citation event sent when a citation is parsed during streaming */
export interface WSCitationEvent extends WSBaseEvent {
    event: 'citation';
    run_id: string;
    citation: import('../../react/types/citations').CitationMetadata;
}

/** Agent action event sent when an action is detected during streaming */
export interface WSAgentActionEvent extends WSBaseEvent {
    event: 'agent_action';
    run_id: string;
    action: import('../../react/agents/agentActions').AgentAction;
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

export interface WSItemDataRequest extends WSBaseEvent {
    event: 'item_data_request';
    request_id: string;
    items: ZoteroItemReference[];
}

export interface WSAttachmentDataRequest extends WSBaseEvent {
    event: 'attachment_data_request';
    request_id: string;
    attachments: ZoteroItemReference[];
}

export interface WSAttachmentContentRequest extends WSBaseEvent {
    event: 'attachment_content_request';
    request_id: string;
    attachment: ZoteroItemReference;
    page_numbers?: number[] | null;
}

export interface WSItemDataResponse {
    type: 'item_data';
    request_id: string;
    items: ItemData[];
    errors?: WSDataError[];
}

export interface WSAttachmentDataResponse {
    type: 'attachment_data';
    request_id: string;
    attachments: AttachmentDataWithMimeType[];
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
    | WSPartEvent
    | WSToolReturnEvent
    | WSRunCompleteEvent
    | WSDoneEvent
    | WSThreadEvent
    | WSErrorEvent
    | WSWarningEvent
    | WSCitationEvent
    | WSAgentActionEvent
    | WSItemDataRequest
    | WSAttachmentDataRequest
    | WSAttachmentContentRequest;

// =============================================================================
// Client Message Types (sent from frontend to backend)
// =============================================================================

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
 * Chat request sent by the client after receiving the 'ready' event.
 * Model selection and API key are passed as query parameters during connection.
 */
export interface WSChatRequest {
    /** Request type discriminator */
    type: 'chat';
    /** Client-generated run ID for this agent run */
    run_id: string;
    /** Thread ID (new UUID for new thread, existing UUID for continuation) */
    thread_id: string | null;
    /** The user's message */
    user_prompt: BeaverAgentPrompt;
    /** If set, instructs the server to retry from this run ID, deleting it and all subsequent runs */
    retry_run_id?: string;
    /** Custom system instructions for this request */
    custom_instructions?: string;
    /** Custom model configuration */
    custom_model?: CustomChatModel;
}

/** Options for WebSocket connection */
export interface WSConnectOptions {
    /** Access ID from PlanModelAccess (optional, backend will use plan default if not provided) */
    accessId?: string;
    /** User's own API key for the model provider (optional) */
    apiKey?: string;
}

// =============================================================================
// Callback Types
// =============================================================================

/** Data received in the ready event */
export interface WSReadyData {
    modelId: string | null;
    modelName: string | null;
    subscriptionStatus: SubscriptionStatus;
    chargeType: ChargeType;
    processingMode: ProcessingMode;
    indexingComplete: boolean;
}

export interface WSCallbacks {
    /**
     * Called when the server is ready to accept chat requests.
     * This is sent after connection validation (auth, profile, model validation) completes.
     * @param data Ready event data containing model/subscription info
     */
    onReady: (data: WSReadyData) => void;

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
     * Called when a citation is parsed during streaming
     * @param event The citation event with run_id and citation metadata
     */
    onCitation?: (event: WSCitationEvent) => void;

    /**
     * Called when an agent action is detected during streaming
     * @param event The agent action event with run_id and action data
     */
    onAgentAction?: (event: WSAgentActionEvent) => void;

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
// WebSocket Chat Service
// =============================================================================

export class ChatServiceWS {
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
        return `${wsProtocol}://${httpUrl.host}/api/v1/chat/ws/completions`;
    }

    /**
     * Get auth token from Supabase session
     */
    private async getAuthToken(): Promise<string> {
        const { data, error } = await supabase.auth.getSession();

        if (error) {
            logger(`ChatServiceWS: Error getting session: ${error.message}`, 2);
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
     * Connect to the WebSocket endpoint and send a chat request
     * 
     * Protocol flow:
     * 1. Client connects with token (and optionally model_id, api_key) in query params
     * 2. Server authenticates, fetches profile, validates model
     * 3. Server sends "ready" event
     * 4. Client sends chat request
     * 5. Server streams delta events and sends complete event
     * 
     * @param request The chat request to send
     * @param callbacks Event callbacks
     * @param options Optional connection options (modelId, apiKey)
     * @returns Promise that resolves when connection is established and ready, rejects on error
     */
    async connect(request: WSChatRequest, callbacks: WSCallbacks, options?: WSConnectOptions): Promise<void> {
        // Close existing connection if any
        this.close();

        this.callbacks = callbacks;

        try {
            const token = await this.getAuthToken();
            const useCustomModel = !!request.custom_model;

            // Build URL with query parameters
            const params = new URLSearchParams();
            params.set('token', token);
            if (useCustomModel) {
                params.set('custom_model', 'true');
            } else if (options?.accessId) {
                params.set('access_id', options.accessId);
            }
            if (options?.apiKey) {
                params.set('api_key', options.apiKey);
            }
            const wsUrl = `${this.getWebSocketUrl()}?${params.toString()}`;

            logger(`ChatServiceWS: Connecting to ${this.getWebSocketUrl()}`, 1);

            return new Promise<void>((resolve, reject) => {
                let hasResolved = false;

                // Wrap the onReady callback to send request after ready
                const wrappedCallbacks: WSCallbacks = {
                    ...callbacks,
                    onReady: (data: WSReadyData) => {
                        logger('ChatServiceWS: Server ready, sending chat request', 1);
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
                    logger('ChatServiceWS: Connection established, waiting for ready event', 1);
                    callbacks.onOpen?.();
                    // Note: Don't resolve here - wait for ready event
                };

                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };

                this.ws.onerror = (event) => {
                    logger(`ChatServiceWS: WebSocket error`, 1);
                    // Note: The error event doesn't contain useful info in browsers
                    // The actual error will come through onclose
                    if (!hasResolved) {
                        hasResolved = true;
                        reject(new Error('WebSocket connection failed'));
                    }
                };

                this.ws.onclose = (event) => {
                    logger(`ChatServiceWS: Connection closed - code=${event.code}, reason=${event.reason}, clean=${event.wasClean}`, 1);
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
            logger(`ChatServiceWS: Connection setup error: ${error}`, 1);
            throw error;
        }
    }

    /**
     * Send a message to the server
     */
    send(data: WSChatRequest | Record<string, any>): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            logger('ChatServiceWS: Cannot send - WebSocket not connected', 1);
            return;
        }

        const message = JSON.stringify(data);
        logger(`ChatServiceWS: Sending message: ${message}`, 1);
        this.ws.send(message);
    }

    /**
     * Handle incoming WebSocket message
     */
    private handleMessage(rawData: string): void {
        if (!this.callbacks) return;

        try {
            const event = JSON.parse(rawData) as WSEvent;
            logger(`ChatServiceWS: Received event: ${event.event}`, 1);

            switch (event.event) {
                case 'ready': {
                    // Convert snake_case backend response to camelCase frontend data
                    const readyData: WSReadyData = {
                        modelId: event.model_id,
                        modelName: event.model_name,
                        subscriptionStatus: event.subscription_status,
                        chargeType: event.charge_type,
                        processingMode: event.processing_mode,
                        indexingComplete: event.indexing_complete,
                    };
                    this.callbacks.onReady(readyData);
                    break;
                }

                case 'part':
                    this.callbacks.onPart(event);
                    break;

                case 'tool_return':
                    this.callbacks.onToolReturn(event);
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
                    this.callbacks.onError(event);
                    // Close the connection after an error
                    this.close(1011, `Server error: ${event.type}`);
                    break;

                case 'warning':
                    this.callbacks.onWarning(event);
                    break;

                case 'citation':
                    this.callbacks.onCitation?.(event);
                    break;

                case 'agent_action':
                    this.callbacks.onAgentAction?.(event);
                    break;

                case 'item_data_request':
                    this.handleItemDataRequest(event).catch((error) => {
                        logger(`ChatServiceWS: Failed to handle item_data_request: ${error}`, 1);
                        this.callbacks?.onError({
                            event: 'error',
                            type: 'item_data_request_failed',
                            message: String(error),
                        });
                    });
                    break;

                case 'attachment_data_request':
                    this.handleAttachmentDataRequest(event).catch((error) => {
                        logger(`ChatServiceWS: Failed to handle attachment_data_request: ${error}`, 1);
                        this.callbacks?.onError({
                            event: 'error',
                            type: 'attachment_data_request_failed',
                            message: String(error),
                        });
                    });
                    break;

                case 'attachment_content_request':
                    this.handleAttachmentContentRequest(event).catch((error) => {
                        logger(`ChatServiceWS: Failed to handle attachment_content_request: ${error}`, 1);
                        this.callbacks?.onError({
                            event: 'error',
                            type: 'attachment_content_request_failed',
                            message: String(error),
                        });
                    });
                    break;

                default:
                    logger(`ChatServiceWS: Unknown event type: ${(event as any).event}`, 1);
            }
        } catch (error) {
            logger(`ChatServiceWS: Failed to parse message: ${error}`, 1);
            this.callbacks.onError({
                event: 'error',
                type: 'parse_error',
                message: 'Failed to parse server message',
            });
        }
    }

    /**
     * Close the WebSocket connection
     * @param code Optional close code (default: 1000 for normal closure)
     * @param reason Optional close reason
     */
    close(code: number = 1000, reason: string = 'Client closing'): void {
        if (this.ws) {
            logger(`ChatServiceWS: Closing connection - code=${code}, reason=${reason}`, 1);
            this.ws.close(code, reason);
            this.ws = null;
        }
        this.callbacks = null;
    }

    /**
     * Handle item_data_request event by serializing requested items.
     */
    private async handleItemDataRequest(request: WSItemDataRequest): Promise<void> {
        const items: ItemData[] = [];
        const errors: WSDataError[] = [];

        for (const reference of request.items) {
            try {
                const item = await Zotero.Items.getByLibraryAndKeyAsync(reference.library_id, reference.zotero_key);
                if (!item) {
                    errors.push({
                        reference,
                        error: 'Item not found in local database',
                        error_code: 'not_found'
                    });
                    continue;
                }

                try {
                    // Ensure all data is available for serialization
                    await item.loadAllData();
                } catch (e) {
                    // Ignore benign load errors
                }

                const serialized = await serializeItem(item, undefined);
                items.push(serialized);
            } catch (error: any) {
                logger(`ChatServiceWS: Failed to serialize item ${reference.library_id}-${reference.zotero_key}: ${error}`, 1);
                errors.push({
                    reference,
                    error: 'Failed to load item metadata',
                    error_code: 'serialization_failed'
                });
            }
        }

        const response: WSItemDataResponse = {
            type: 'item_data',
            request_id: request.request_id,
            items,
            errors: errors.length > 0 ? errors : undefined
        };

        this.send(response);
    }

    /**
     * Handle attachment_data_request event by serializing requested attachments.
     */
    private async handleAttachmentDataRequest(request: WSAttachmentDataRequest): Promise<void> {
        const attachments: AttachmentDataWithMimeType[] = [];
        const errors: WSDataError[] = [];

        for (const reference of request.attachments) {
            try {
                const attachment = await Zotero.Items.getByLibraryAndKeyAsync(reference.library_id, reference.zotero_key);
                if (!attachment) {
                    errors.push({
                        reference,
                        error: 'Attachment not found in local database',
                        error_code: 'not_found'
                    });
                    continue;
                }

                if (!attachment.isAttachment()) {
                    errors.push({
                        reference,
                        error: 'Requested item is not an attachment',
                        error_code: 'invalid_type'
                    });
                    continue;
                }

                try {
                    await attachment.loadAllData();
                } catch (e) {
                    // Ignore benign load errors
                }

                const serialized = await serializeAttachment(attachment, undefined);
                if (serialized) {
                    attachments.push(serialized);
                } else {
                    errors.push({
                        reference,
                        error: 'Attachment not available locally or on server',
                        error_code: 'not_available'
                    });
                }
            } catch (error: any) {
                logger(`ChatServiceWS: Failed to serialize attachment ${reference.library_id}-${reference.zotero_key}: ${error}`, 1);
                errors.push({
                    reference,
                    error: 'Failed to load attachment metadata',
                    error_code: 'serialization_failed'
                });
            }
        }

        const response: WSAttachmentDataResponse = {
            type: 'attachment_data',
            request_id: request.request_id,
            attachments,
            errors: errors.length > 0 ? errors : undefined
        };

        this.send(response);
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
}

// =============================================================================
// Singleton Export
// =============================================================================

export const chatServiceWS = new ChatServiceWS(API_BASE_URL);
