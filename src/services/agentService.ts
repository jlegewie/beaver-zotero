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
import { AgentRun } from '../../react/agents/types';
import { AgentAction, toAgentAction } from '../../react/agents/agentActions';
import { ApiService } from './apiService';
import { 
    handleZoteroDataRequest, 
    handleExternalReferenceCheckRequest,
    handleZoteroAttachmentPagesRequest,
    handleZoteroAttachmentPageImagesRequest,
    handleZoteroAttachmentSearchRequest,
    handleItemSearchByMetadataRequest,
    handleItemSearchByTopicRequest,
} from './agentDataProvider';
import { AgentRunRequest } from './agentProtocol';
import {
    WSEvent,
    WSErrorEvent,
    WSCallbacks,
    WSAuthMessage,
    WSReadyData,
    WSRequestAckData,
} from './agentProtocol';


// =============================================================================
// Agent Service
// =============================================================================

export class AgentService {
    private baseUrl: string;
    private ws: WebSocket | null = null;
    private callbacks: WSCallbacks | null = null;
    private connecting: boolean = false;

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
     * 4. Client sends agent run request (with model selection: model_id/api_key or custom_model)
     * 5. Server validates model and sends "request_ack" event
     * 6. Server streams delta events and sends complete event
     * 
     * @param request The agent run request to send (should include model_id/api_key or custom_model)
     * @param callbacks Event callbacks
     * @returns Promise that resolves when connection is established and ready, rejects on error
     */
    async connect(request: AgentRunRequest, callbacks: WSCallbacks, frontendVersion?: string): Promise<void> {
        // Guard: Don't allow overlapping connect attempts
        if (this.connecting) {
            logger('AgentService: connect() already in progress, ignoring duplicate call', 1);
            return;
        }
        this.connecting = true;

        // Log if closing an existing connection
        if (this.ws) {
            logger(`AgentService: Closing existing connection before new connect (state=${this.ws.readyState})`, 1);
        }
        
        // Close existing connection if any
        this.close();

        this.callbacks = callbacks;

        try {
            const token = await this.getAuthToken();

            // Auth message now includes token and frontend version
            const authMessage: WSAuthMessage = {
                type: 'auth',
                token,
                frontend_version: frontendVersion,
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
                            this.connecting = false;
                            resolve();
                        }
                    },
                    onError: (event: WSErrorEvent) => {
                        // Call the original error callback
                        callbacks.onError(event);
                        // If we haven't resolved yet, this is a connection-phase error
                        if (!hasResolved) {
                            hasResolved = true;
                            this.connecting = false;
                            reject(new Error(event.message));
                        }
                    }
                };

                this.callbacks = wrappedCallbacks;
                this.ws = new WebSocket(wsUrl);
                
                // Capture the WebSocket instance to avoid race conditions if connect()
                // is called again before auth completes. The second connect() would call
                // close() which sets this.ws = null, but we need the original instance.
                const wsInstance = this.ws;

                this.ws.onopen = () => {
                    logger('AgentService: Connection established, sending auth message', 1);
                    // Small delay to ensure server has completed accept() before we send
                    // This prevents a race condition where messages sent immediately in onopen
                    // may be dropped if the server hasn't finished accepting the connection
                    setTimeout(() => {
                        // Use captured wsInstance instead of this.ws to handle case where
                        // connect() is called again during the delay (which would null this.ws)
                        if (wsInstance.readyState === WebSocket.OPEN) {
                            wsInstance.send(JSON.stringify(authMessage));
                            logger('AgentService: Auth message sent', 1);
                        } else {
                            logger(`AgentService: WebSocket not open for auth (state=${wsInstance.readyState}), connection may have been superseded`, 1);
                        }
                    }, 50); // 50ms delay to allow server to complete accept()
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
                        this.connecting = false;
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
                        this.connecting = false;
                        reject(new Error(`Connection closed: ${event.reason || 'Unknown reason. Please try again.'}`));
                    }
                };
            });
        } catch (error) {
            logger(`AgentService: Connection setup error: ${error}`, 1);
            this.connecting = false;
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
        
        // Sanitize sensitive data for logging
        const sanitizedData = { ...data };
        if ('api_key' in sanitizedData) {
            sanitizedData.api_key = '[REDACTED]';
        }
        if ('custom_model' in sanitizedData && typeof sanitizedData.custom_model === 'object') {
            sanitizedData.custom_model = {
                ...sanitizedData.custom_model,
                api_key: sanitizedData.custom_model.api_key ? '[REDACTED]' : undefined
            };
        }
        const sanitizedMessage = JSON.stringify(sanitizedData);
        logger(`AgentService: Sending "${sanitizedData.type}"`, sanitizedData, 1);
        
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
                    // Call onError callback
                    this.callbacks.onError(event);
                    // Backend behavior: some errors close connection (auth, internal), 
                    // others keep it open (LLM errors, rate limits, invalid_request).
                    // Since each connect() is for a single run (for now), close on any error.
                    // Use a small delay to avoid race with server-initiated close.
                    setTimeout(() => {
                        if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
                            // Firefox/Zotero only allows code 1000 or 3000-4999 for close()
                            // 1011 causes InvalidAccessError, so we use 1000 (Normal Closure)
                            this.close(1000, `Client closing after error: ${event.type}`);
                        }
                    }, 100);
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

                case 'missing_zotero_data':
                    this.callbacks.onMissingZoteroData?.(event);
                    break;

                case 'zotero_attachment_pages_request':
                    logger("AgentService: Received zotero_attachment_pages_request", event, 1);
                    handleZoteroAttachmentPagesRequest(event)
                        .then(res => this.send(res))
                        .catch(err => {
                            logger(`AgentService: zotero_attachment_pages_request failed: ${err}`, 1);
                            // Send error response to backend so it doesn't timeout
                            this.send({
                                type: 'zotero_attachment_pages',
                                request_id: event.request_id,
                                attachment: event.attachment,
                                pages: [],
                                total_pages: null,
                                error: String(err),
                                error_code: 'extraction_failed',
                            });
                        });
                    break;

                case 'zotero_attachment_page_images_request':
                    logger("AgentService: Received zotero_attachment_page_images_request", event, 1);
                    handleZoteroAttachmentPageImagesRequest(event)
                        .then(res => this.send(res))
                        .catch(err => {
                            logger(`AgentService: zotero_attachment_page_images_request failed: ${err}`, 1);
                            // Send error response to backend so it doesn't timeout
                            this.send({
                                type: 'zotero_attachment_page_images',
                                request_id: event.request_id,
                                attachment: event.attachment,
                                pages: [],
                                total_pages: null,
                                error: String(err),
                                error_code: 'render_failed',
                            });
                        });
                    break;

                case 'zotero_attachment_search_request':
                    logger("AgentService: Received zotero_attachment_search_request", event, 1);
                    handleZoteroAttachmentSearchRequest(event)
                        .then(res => this.send(res))
                        .catch(err => {
                            logger(`AgentService: zotero_attachment_search_request failed: ${err}`, 1);
                            // Send error response to backend so it doesn't timeout
                            this.send({
                                type: 'zotero_attachment_search',
                                request_id: event.request_id,
                                attachment: event.attachment,
                                query: event.query,
                                total_matches: 0,
                                pages_with_matches: 0,
                                total_pages: null,
                                pages: [],
                                error: String(err),
                                error_code: 'search_failed',
                            });
                        });
                    break;

                case 'external_reference_check_request':
                    logger("AgentService: Received external_reference_check_request", event, 1);
                    handleExternalReferenceCheckRequest(event)
                        .then(res => this.send(res))
                        .catch(err => {
                            logger(`AgentService: external_reference_check_request failed: ${err}`, 1);
                            // Send error response with empty results - backend will treat as "none found"
                            this.send({
                                type: 'external_reference_check',
                                request_id: event.request_id,
                                results: [],
                            });
                        });
                    break;

                case 'zotero_data_request':
                    logger("AgentService: Received zotero_data_request", event, 1);
                    handleZoteroDataRequest(event)
                        .then(res => this.send(res))
                        .catch(err => {
                            logger(`AgentService: zotero_data_request failed: ${err}`, 1);
                            // Send error response with empty data and errors for all requested items
                            this.send({
                                type: 'zotero_data',
                                request_id: event.request_id,
                                items: [],
                                attachments: [],
                                errors: event.items.map(ref => ({
                                    reference: ref,
                                    error: String(err),
                                    error_code: 'load_failed',
                                })),
                            });
                        });
                    break;

                case 'item_search_by_metadata_request':
                    logger("AgentService: Received item_search_by_metadata_request", event, 1);
                    handleItemSearchByMetadataRequest(event)
                        .then(res => this.send(res))
                        .catch(err => {
                            logger(`AgentService: item_search_by_metadata_request failed: ${err}`, 1);
                            // Send error response to backend so it doesn't timeout
                            this.send({
                                type: 'item_search_by_metadata',
                                request_id: event.request_id,
                                items: [],
                                error: String(err),
                                error_code: 'internal_error',
                            });
                        });
                    break;

                case 'item_search_by_topic_request':
                    logger("AgentService: Received item_search_by_topic_request", event, 1);
                    handleItemSearchByTopicRequest(event)
                        .then(res => this.send(res))
                        .catch(err => {
                            logger(`AgentService: item_search_by_topic_request failed: ${err}`, 1);
                            // Send error response to backend so it doesn't timeout
                            this.send({
                                type: 'item_search_by_topic',
                                request_id: event.request_id,
                                items: [],
                                error: String(err),
                                error_code: 'internal_error',
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
            // Only attempt to close if not already closing/closed
            // CLOSING = 2, CLOSED = 3
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                logger(`AgentService: Closing connection - code=${code}, reason=${reason}`, 1);
                try {
                    this.ws.close(code, reason);
                } catch (error) {
                    // Log but don't throw - the connection may already be closing from server side
                    logger(`AgentService: Error closing WebSocket (state=${this.ws.readyState}): ${error}`, 1);
                }
            } else {
                logger(`AgentService: WebSocket already closing/closed (state=${this.ws.readyState})`, 1);
            }
            this.ws = null;
        }
        this.callbacks = null;
    }

    /**
     * Cancel the current run and close the connection.
     * Sends a cancel message to the backend before closing to ensure proper cleanup.
     * @param waitMs Time to wait after sending cancel before closing (default: 250ms)
     */
    async cancel(waitMs: number = 250): Promise<void> {
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
