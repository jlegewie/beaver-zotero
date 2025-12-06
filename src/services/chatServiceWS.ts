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

// =============================================================================
// WebSocket Event Types (matching backend ws_events.py)
// =============================================================================

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

/** Delta event for streaming content updates */
export interface WSDeltaEvent extends WSBaseEvent {
    event: 'delta';
    message_id: string;
    delta: string;
    type: 'reasoning' | 'content';
}

/** Complete event signaling the end of a response */
export interface WSCompleteEvent extends WSBaseEvent {
    event: 'complete';
    message_id: string;
}

/** Error event for communicating failures */
export interface WSErrorEvent extends WSBaseEvent {
    event: 'error';
    type: string;
    message: string;
    message_id?: string;
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
    message_id: string;
    type: WSWarningType;
    message: string;
    data?: Record<string, any>;
}

/** Union type for all WebSocket events */
export type WSEvent = WSReadyEvent | WSDeltaEvent | WSCompleteEvent | WSErrorEvent | WSWarningEvent;

// =============================================================================
// Client Message Types (sent from frontend to backend)
// =============================================================================

/** Chat request message sent to initiate a chat */
export interface WSChatRequest {
    message: string;
    // TODO: Add more fields as the backend evolves
    // thread_id?: string;
    // attachments?: MessageAttachment[];
    // model_id?: string;
}

// =============================================================================
// Callback Types
// =============================================================================

export type DeltaType = 'reasoning' | 'content';

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
     * Called when a delta (partial content) is received
     * @param messageId ID of the message being streamed
     * @param delta The text chunk
     * @param type Whether this is reasoning or content
     */
    onDelta: (messageId: string, delta: string, type: DeltaType) => void;

    /**
     * Called when a message is complete
     * @param messageId ID of the completed message
     */
    onComplete: (messageId: string) => void;

    /**
     * Called when an error occurs
     * @param type Error type identifier
     * @param message Human-readable error message
     * @param messageId Optional message ID if error is associated with a specific message
     * @param details Optional additional error details
     */
    onError: (type: string, message: string, messageId?: string, details?: string) => void;

    /**
     * Called when a warning occurs (non-fatal)
     * @param messageId Message ID associated with the warning
     * @param type Warning type identifier
     * @param message Human-readable warning message
     * @param data Optional additional warning data
     */
    onWarning: (messageId: string, type: WSWarningType, message: string, data?: Record<string, any>) => void;

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
     * 1. Client connects with token in query params
     * 2. Server authenticates, fetches profile, validates model
     * 3. Server sends "ready" event
     * 4. Client sends chat request
     * 5. Server streams delta events and sends complete event
     * 
     * @param request The chat request to send
     * @param callbacks Event callbacks
     * @returns Promise that resolves when connection is established and ready, rejects on error
     */
    async connect(request: WSChatRequest, callbacks: WSCallbacks): Promise<void> {
        // Close existing connection if any
        this.close();

        this.callbacks = callbacks;

        try {
            const token = await this.getAuthToken();
            const wsUrl = `${this.getWebSocketUrl()}?token=${encodeURIComponent(token)}`;

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
                    onError: (type: string, message: string, messageId?: string, details?: string) => {
                        // Call the original error callback
                        callbacks.onError(type, message, messageId, details);
                        // If we haven't resolved yet, this is a connection-phase error
                        if (!hasResolved) {
                            hasResolved = true;
                            reject(new Error(`${type}: ${message}`));
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

                case 'delta':
                    this.callbacks.onDelta(
                        event.message_id,
                        event.delta,
                        event.type
                    );
                    break;

                case 'complete':
                    this.callbacks.onComplete(event.message_id);
                    break;

                case 'error':
                    this.callbacks.onError(
                        event.type,
                        event.message,
                        event.message_id,
                        event.details
                    );
                    break;

                case 'warning':
                    this.callbacks.onWarning(
                        event.message_id,
                        event.type,
                        event.message,
                        event.data
                    );
                    break;

                default:
                    logger(`ChatServiceWS: Unknown event type: ${(event as any).event}`, 1);
            }
        } catch (error) {
            logger(`ChatServiceWS: Failed to parse message: ${error}`, 1);
            this.callbacks.onError('parse_error', 'Failed to parse server message');
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
}

// =============================================================================
// Singleton Export
// =============================================================================

export const chatServiceWS = new ChatServiceWS(API_BASE_URL);

