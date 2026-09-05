/**
 * Agent Service
 * 
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 * 
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */

import { supabase } from './supabaseClient';
import { getApiBaseUrl } from './config';
import { logger } from '../platform/logger';
import { AgentRun } from '../agents/types';
import type { AgentAction } from '../agents/agentActionTypes';
import { toAgentAction } from '../agents/agentActionTypes';
import { ApiService } from './apiService';
import {
    AgentDataProviderMap,
    resolveDefaultAgentDataProvider,
    unknownDataRequestErrorResponse,
    NOOP_KEEPALIVE,
    QUESTION_KEEPALIVE_INTERVAL_MS,
    REQUEST_KEEPALIVE_INTERVAL_MS,
    isBackendRequestEvent,
    isRequestSignal,
    type AgentDataRequestContext,
    type RequestKeepalive,
} from './agentDataDispatch';
import { AgentRunRequest, ZoteroInstanceWire } from '../protocol/agentProtocol';
import { DEFAULT_BACKEND_TIMEOUT_MS } from '../run-state/askUserQuestionCountdown';
import {
    WSEvent,
    WSErrorEvent,
    WSCallbacks,
    WSAuthMessage,
    WSReadyData,
    WSRequestAckData,
    WSQuestionKeepalive,
    WSRequestKeepalive,
    WSRequestReceivedAck,
    AskUserQuestionAnswer,
    BatchApprovalMode,
} from '../protocol/agentProtocol';
import { resolveBusyContext } from './busyContextProvider';
import {
    isPreparedJsonMessage,
    materializePreparedJsonMessage,
    preparedJsonEnvelope,
    withPreparedJsonEnvelope,
    type PreparedJsonMessage,
} from './preparedJsonMessage';
import {
    baselineConnectionEvidence,
    connectRecoveryAuthFields,
    ConnectRecoveryAuthFields,
    ConnectionFailureEvidence,
    ConnectionFailureStage,
} from './connectionFailure';


// =============================================================================
// Auth helpers
// =============================================================================

/**
 * Get an auth token from the Supabase session for a backend WebSocket handshake.
 * Includes a defense-in-depth expiry check to catch tokens that were valid
 * when getSession() ran but became stale due to OS process suspension (e.g.
 * macOS sleep between getSession()'s internal Date.now() check and here).
 * Shared by the chat connection (AgentService) and the provider connection.
 */
export async function getWSAuthToken(): Promise<string> {
    const { data, error } = await supabase.auth.getSession();

    if (error) {
        logger(`AgentService: Error getting session: ${error.message}`, 2);
        throw new Error('Error getting user session');
    }

    if (!data.session?.access_token) {
        throw new Error('User not authenticated');
    }

    // Proactively refresh if token is expired or expires within 30s.
    const expiresAt = data.session.expires_at;
    if (expiresAt && expiresAt - Math.floor(Date.now() / 1000) < 30) {
        logger('AgentService: Access token expired or near-expiry, refreshing session');
        const refreshResult = await supabase.auth.refreshSession();
        if (refreshResult.error || !refreshResult.data.session?.access_token) {
            logger(`AgentService: Session refresh failed: ${refreshResult.error?.message}`, 2);
            throw new Error('Session expired and refresh failed');
        }
        return refreshResult.data.session.access_token;
    }

    return data.session.access_token;
}


// =============================================================================
// Agent Service
// =============================================================================

/** Backstop timeout for a full connect attempt (auth token + handshake + ready). */
export const CONNECT_TIMEOUT_MS = 20_000;

interface ConnectionAttemptState {
    stage: ConnectionFailureStage;
    socketOpened: boolean;
    readyReceived: boolean;
    /** When the socket's open event fired (null until then). */
    openedAt: number | null;
    /**
     * When the last WebSocket message arrived (null until the first one).
     * At failure time this separates idle-kill drops (proxies and load
     * balancers closing a quiet connection) from mid-stream cuts.
     */
    lastMessageAt: number | null;
}

function attemptEvidence(
    attempt: ConnectionAttemptState,
    overrides: Partial<ConnectionFailureEvidence> = {},
): ConnectionFailureEvidence {
    const now = Date.now();
    return baselineConnectionEvidence(attempt.stage, {
        socketOpened: attempt.socketOpened,
        readyReceived: attempt.readyReceived,
        wsUptimeMs: attempt.openedAt !== null ? Math.max(0, now - attempt.openedAt) : null,
        msSinceLastWsMessageMs:
            attempt.lastMessageAt !== null ? Math.max(0, now - attempt.lastMessageAt) : null,
        ...overrides,
    });
}

export class AgentConnectionError extends Error {
    readonly evidence: ConnectionFailureEvidence;

    constructor(message: string, evidence: ConnectionFailureEvidence) {
        super(message);
        this.name = 'AgentConnectionError';
        this.evidence = evidence;
    }
}

/**
 * Thrown when a connect attempt never settles within CONNECT_TIMEOUT_MS.
 *
 * The attempt is torn down with a normal close code, so the failure carries no
 * WebSocket close code of its own. Callers must identify it by type rather than
 * by close code, otherwise it is indistinguishable from a plain network outage.
 */
export class ConnectTimeoutError extends AgentConnectionError {
    constructor(evidence: ConnectionFailureEvidence, timeoutMs: number = CONNECT_TIMEOUT_MS) {
        super(`Connection attempt timed out after ${timeoutMs}ms`, {
            ...evidence,
            timedOut: true,
            errorName: 'ConnectTimeoutError',
        });
        this.name = 'ConnectTimeoutError';
    }
}

export class AgentService {
    /** Set only when a caller pins this instance to a specific backend. */
    private overrideBaseUrl?: string;
    private ws: WebSocket | null = null;
    private callbacks: WSCallbacks | null = null;
    private connecting: boolean = false;
    /**
     * Settles the promise for the current pre-ready connection attempt.
     * close() resolves it (an intentional client close is not a failure);
     * the socket's own close event rejects it.
     */
    private activeConnectFinish: ((error?: Error) => void) | null = null;
    /** Queue to serialize async message processing */
    private messageQueue: Promise<void> = Promise.resolve();
    /** Queue to serialize action execution (prevents concurrent edits to the same resource) */
    private actionExecutionQueue: Promise<void> = Promise.resolve();
    /** Monotonic counter incremented on close to invalidate stale queued messages */
    private connectionId: number = 0;
    /** Whether the connected backend understands `request_received` acks (from the ready event) */
    private serverSupportsRequestAcks: boolean = false;
    /** Whether the connected backend understands `request_keepalive` messages (from the ready event) */
    private serverSupportsRequestKeepalive: boolean = false;
    /** Whether the connected backend understands `question_keepalive` messages (from the ready event) */
    private serverSupportsQuestionKeepalive: boolean = false;
    /**
     * Arrival times of inbound messages not yet fully handled: the one being
     * handled plus those queued behind it. Reported in acks as `queue_depth`
     * / `queue_oldest_ms` so the backend can tell a blocked message queue from
     * a frozen main thread.
     */
    private queuedMessageArrivals: number[] = [];
    /**
     * Keepalive controllers started on receipt of a backend request, keyed by
     * request id until the dispatcher picks them up, plus every controller
     * still ticking. Stopped as a group when the connection is reset so a
     * hung handler cannot keep sending keepalives on a replacement socket.
     */
    private pendingKeepalives: Map<string, RequestKeepalive> = new Map();
    /** Running `question_keepalive` timers, by question id. */
    private questionKeepalives: Map<string, () => void> = new Map();
    private activeKeepalives: Set<RequestKeepalive> = new Set();
    /**
     * Map of backend data-request event -> handler. Injectable so a non-Zotero
     * host can serve the same requests its own way. Resolved lazily from the
     * registered default (see `resolveDefaultAgentDataProvider`) on first use,
     * so this module-level singleton can be constructed before a host has
     * registered its provider.
     */
    private dataProvider: AgentDataProviderMap | null;

    constructor(baseUrl?: string, dataProvider?: AgentDataProviderMap) {
        this.overrideBaseUrl = baseUrl;
        this.dataProvider = dataProvider ?? null;
    }

    /**
     * Resolved per use rather than captured at construction, so a host can
     * register its transport config after this module has loaded.
     */
    private get baseUrl(): string {
        return this.overrideBaseUrl ?? getApiBaseUrl();
    }

    /** Replace the data-request provider map (e.g. a Word add-in injects its own). */
    setDataProvider(dataProvider: AgentDataProviderMap): void {
        this.dataProvider = dataProvider;
    }

    /** Resolve the data-provider map, falling back to the registered default on first use. */
    private getDataProvider(): AgentDataProviderMap {
        if (!this.dataProvider) {
            this.dataProvider = resolveDefaultAgentDataProvider();
        }
        return this.dataProvider;
    }

    private resetConnectionState(): void {
        this.ws = null;
        this.callbacks = null;
        this.connectionId++;
        this.messageQueue = Promise.resolve();
        this.actionExecutionQueue = Promise.resolve();
        this.serverSupportsRequestAcks = false;
        this.serverSupportsRequestKeepalive = false;
        this.serverSupportsQuestionKeepalive = false;
        this.queuedMessageArrivals = [];
        this.stopAllKeepalives();
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
     * Get auth token from Supabase session (see getWSAuthToken).
     */
    private async getAuthToken(): Promise<string> {
        return getWSAuthToken();
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
    async connect(
        request: AgentRunRequest,
        callbacks: WSCallbacks,
        frontendVersion?: string,
        clientType?: string,
        clientFeatures?: string[],
        zoteroInstance?: ZoteroInstanceWire,
        connectRecovery?: ConnectRecoveryAuthFields,
    ): Promise<void> {
        const connectTelemetry = connectRecovery ?? connectRecoveryAuthFields(1, null);
        // Guard: Don't allow overlapping connect attempts
        if (this.connecting) {
            logger('AgentService: connect() already in progress, ignoring duplicate call', 1);
            return;
        }

        // Log if closing an existing connection
        if (this.ws) {
            logger(`AgentService: Closing existing connection before new connect (state=${this.ws.readyState})`, 1);
        }

        // Close existing connection if any. close() clears `connecting`, so
        // this attempt claims the flag only after the old state is torn down.
        this.close(1000, 'Client closing', { notifyClose: false });
        this.connecting = true;

        // close() increments connectionId. Capture the new value so an
        // external close during the async auth-token lookup can abort setup
        // before it creates a socket.
        const setupConnectionId = this.connectionId;
        const attempt: ConnectionAttemptState = {
            stage: 'auth',
            socketOpened: false,
            readyReceived: false,
            openedAt: null,
            lastMessageAt: null,
        };

        this.callbacks = callbacks;

        // Backstop: if neither ready, a server error event, nor a close event
        // ever settles this attempt (including an auth-token lookup that
        // hangs), fail it instead of leaving the caller pending forever.
        // The timer is scoped to this attempt via its connection generation:
        // a timer that outlives a superseded attempt (e.g. the user cancelled
        // during the token lookup and a new run has since connected) must not
        // tear down the newer connection.
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const connectTimeout = new Promise<void>((resolve, reject) => {
            timeoutId = setTimeout(() => {
                if (this.connectionId !== setupConnectionId) {
                    // Superseded while still unsettled: settle quietly,
                    // mirroring an intentional client close.
                    resolve();
                    return;
                }
                // Reject before close(): close() resolves the pending
                // establishConnection promise, so closing first would let the
                // race settle as a success and mask the timeout.
                reject(new ConnectTimeoutError(attemptEvidence(attempt), CONNECT_TIMEOUT_MS));
                this.close(1000, 'Connection attempt timed out');
            }, CONNECT_TIMEOUT_MS);
        });

        try {
            await Promise.race([
                this.establishConnection(
                    request,
                    callbacks,
                    setupConnectionId,
                    attempt,
                    frontendVersion,
                    clientType,
                    clientFeatures,
                    zoteroInstance,
                    connectTelemetry,
                ),
                connectTimeout,
            ]);
        } catch (error) {
            logger(`AgentService: Connection setup error: ${error}`, 1);
            // Only reset if this attempt still owns the connection state — a
            // close() or newer connect() during the token await has already
            // moved on (and may have set `connecting` for its own attempt).
            if (this.connectionId === setupConnectionId) {
                this.connecting = false;
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Fetch the auth token, open the socket, and settle once the server's
     * `ready` event arrives (or the attempt fails). Split from connect() so
     * the caller can race it against the attempt-scoped backstop timeout.
     */
    private async establishConnection(
        request: AgentRunRequest,
        callbacks: WSCallbacks,
        setupConnectionId: number,
        attempt: ConnectionAttemptState,
        frontendVersion?: string,
        clientType?: string,
        clientFeatures?: string[],
        zoteroInstance?: ZoteroInstanceWire,
        connectTelemetry?: ConnectRecoveryAuthFields,
    ): Promise<void> {
        let token: string;
        try {
            token = await this.getAuthToken();
        } catch (error) {
            if (error instanceof AgentConnectionError) throw error;
            const message = error instanceof Error ? error.message : String(error);
            throw new AgentConnectionError(message || 'Could not check user session', attemptEvidence(attempt, {
                stage: 'auth',
                errorName: error instanceof Error ? error.name : 'UnknownError',
            }));
        }

        // A close() during the token lookup superseded this attempt (and
        // already cleared `connecting`). An intentional client close is
        // not a failure, so resolve quietly without creating a socket.
        if (this.connectionId !== setupConnectionId) {
            return;
        }

        // Auth message includes token, frontend version, and — when the
        // caller supplies them — the client identity, declared features, and
        // optional connect-recovery telemetry after client-side auto-retry.
        const resolvedConnectTelemetry = connectTelemetry ?? connectRecoveryAuthFields(1, null);
        const { connect_started_at_ms: connectStartedAtMs, ...wireTelemetry } = resolvedConnectTelemetry;
        const authMessageBase: Omit<WSAuthMessage, 'connect_latency_ms'> = {
            type: 'auth',
            token,
            frontend_version: frontendVersion,
            ...(clientType ? { client_type: clientType } : {}),
            ...(clientFeatures ? { client_features: clientFeatures } : {}),
            ...(zoteroInstance ? { zotero_instance: zoteroInstance } : {}),
            ...wireTelemetry,
        };

        // Connect with clean URL (no sensitive data in params)
        const wsUrl = this.getWebSocketUrl();
        attempt.stage = 'opening';

        logger(`AgentService: Connecting to ${wsUrl}`, 1);

        return new Promise<void>((resolve, reject) => {
            let hasResolved = false;
            const finish = (error?: Error) => {
                if (hasResolved) return;
                hasResolved = true;
                this.connecting = false;
                if (this.activeConnectFinish === finish) {
                    this.activeConnectFinish = null;
                }
                if (error) reject(error);
                else resolve();
            };
            // close() invalidates this socket before its onclose handler
            // runs, so expose the promise settler explicitly.
            this.activeConnectFinish = finish;

            // Wrap the onReady callback to send request after ready
            const wrappedCallbacks: WSCallbacks = {
                ...callbacks,
                onReady: (data: WSReadyData) => {
                    attempt.stage = 'mid_run';
                    attempt.readyReceived = true;
                    logger('AgentService: Server ready, sending agent run request', 1);
                    // Call the original onReady callback first
                    callbacks.onReady(data);
                    // Send the chat request now that server is ready. A socket
                    // that reports OPEN can still refuse the write (half-open
                    // channel); failing the connect here is what surfaces that
                    // instead of leaving the user on an endless thinking state
                    // for a run the server never received.
                    if (!this.send(request)) {
                        // Reject before close(), matching the timeout path:
                        // close() settles this same promise, so closing first
                        // would let the failure resolve as a success. The socket
                        // must still be torn down — `ready` already marked the
                        // connection live, so nothing else would reclaim it.
                        finish(new AgentConnectionError(
                            'Connection closed before the request could be sent',
                            attemptEvidence(attempt, { requestNeverSent: true }),
                        ));
                        this.close(1000, 'Request could not be sent');
                        return;
                    }
                    // Resolve the connect promise
                    finish();
                },
                onError: (event: WSErrorEvent) => {
                    // Call the original error callback
                    callbacks.onError(event);
                    // If we haven't resolved yet, this is a connection-phase error
                    finish(new Error(event.message));
                }
            };

            this.callbacks = wrappedCallbacks;
            let wsInstance: WebSocket;
            try {
                wsInstance = new WebSocket(wsUrl);
                this.ws = wsInstance;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                finish(new AgentConnectionError(message || 'Could not create WebSocket', attemptEvidence(attempt, {
                    errorName: error instanceof Error ? error.name : 'UnknownError',
                })));
                return;
            }

            // Capture the WebSocket instance to avoid race conditions if connect()
            // is called again before auth completes. The second connect() would call
            // close() which sets this.ws = null, but we need the original instance.
            wsInstance.onopen = () => {
                attempt.stage = 'authenticating';
                attempt.socketOpened = true;
                attempt.openedAt = Date.now();
                logger('AgentService: Connection established, sending auth message', 1);
                logger(
                    `AgentService: WebSocket negotiated extensions="${wsInstance.extensions || '(none)'}" protocol="${wsInstance.protocol || '(none)'}"`,
                    1,
                );
                // Small delay to ensure server has completed accept() before we send
                // This prevents a race condition where messages sent immediately in onopen
                // may be dropped if the server hasn't finished accepting the connection
                setTimeout(() => {
                    // Use captured wsInstance instead of this.ws to handle case where
                    // connect() is called again during the delay (which would null this.ws)
                    if (wsInstance.readyState === WebSocket.OPEN) {
                        const authMessage: WSAuthMessage = {
                            ...authMessageBase,
                            connect_latency_ms: Math.max(
                                0,
                                Date.now() - connectStartedAtMs,
                            ),
                        };
                        wsInstance.send(JSON.stringify(authMessage));
                        attempt.stage = 'awaiting_ready';
                        logger('AgentService: Auth message sent', 1);
                    } else {
                        logger(`AgentService: WebSocket not open for auth (state=${wsInstance.readyState}), connection may have been superseded`, 1);
                    }
                }, 50); // 50ms delay to allow server to complete accept()
                callbacks.onOpen?.();
                // Note: Don't resolve here - wait for ready event
            };

            const connId = this.connectionId;
            wsInstance.onmessage = (event) => {
                // A frame buffered on a socket that close() has already
                // replaced must not be acked, counted or queued against the
                // new connection.
                if (this.connectionId !== connId || this.ws !== wsInstance) return;
                const receivedAt = Date.now();
                attempt.lastMessageAt = receivedAt;
                const parsed = this.parseMessage(event.data);
                if (parsed === null) return;
                // Ack and start keepalives here, before the message enters the
                // queue: the queue awaits UI callbacks (item loads for streamed
                // parts), so anything sent from inside it would say nothing
                // about whether the request arrived — only about whether the
                // queue was moving. Until the dispatcher picks the request up
                // its keepalives report the `queued` phase.
                this.maybeAckRequest(parsed, receivedAt);
                this.maybeStartKeepalive(parsed, receivedAt);
                this.maybeStartQuestionKeepalive(parsed);
                // Chain onto the queue so async callbacks are processed in order.
                // Captured per message: a reset swaps in a fresh array, and a
                // handler from the old connection that settles afterwards must
                // shift its own array, not the new connection's.
                const arrivals = this.queuedMessageArrivals;
                arrivals.push(receivedAt);
                this.messageQueue = this.messageQueue.then(() => {
                    if (this.connectionId !== connId) return;
                    return this.handleMessage(parsed, receivedAt);
                }).catch(err => {
                    logger(`AgentService: Unhandled error in message queue: ${err}`, 1);
                }).finally(() => {
                    // Entries stay until their handler settles, so the count
                    // includes the message currently being handled.
                    arrivals.shift();
                });
            };

            // Note: onerror carries no useful info in browsers. Per the WebSocket
            // spec, onclose always fires after onerror, so we defer rejection to
            // onclose to capture the close code (useful for distinguishing proxy
            // blocks, TLS failures, and server-side rejects).
            wsInstance.onerror = () => {
                logger(`AgentService: WebSocket error event (close will follow)`, 1);
            };

            wsInstance.onclose = (event) => {
                if (this.ws !== wsInstance || this.connectionId !== connId) {
                    logger('AgentService: Ignoring stale close event from superseded connection', 1);
                    return;
                }
                logger(`AgentService: Connection closed - code=${event.code}, reason=${event.reason}, clean=${event.wasClean}`, 1);
                // Notify before resetConnectionState() so the callback can
                // still read connection-scoped state.
                const evidence = attemptEvidence(attempt, {
                    stage: attempt.readyReceived ? 'mid_run' : attempt.stage,
                    closeCode: event.code,
                    closeReason: event.reason,
                    wasClean: event.wasClean,
                });
                callbacks.onClose?.(event.code, event.reason, event.wasClean, evidence);
                this.resetConnectionState();
                // If we haven't resolved yet, the connection closed before
                // ready. Close-code details for the error UI travel via the
                // onClose callback above, not the rejection.
                if (!hasResolved) {
                    finish(new AgentConnectionError(
                        event.reason
                            ? `Connection closed: ${event.reason}`
                            : `Connection closed before ready (code ${event.code})`,
                        evidence,
                    ));
                }
            };
        });
    }

    /**
     * Send a message to the server.
     *
     * Returns false when the socket is not open, so callers whose message
     * carries a user decision can recover locally instead of assuming it went
     * out. Most callers can ignore the result.
     */
    send(data: AgentRunRequest | Record<string, any> | PreparedJsonMessage): boolean {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            logger('AgentService: Cannot send - WebSocket not connected', 1);
            return false;
        }

        // Attach a completion-time busy-context snapshot to request responses
        // (backend response models carry `timing: Dict[str, Any]` and ignore
        // extra fields, so this is safe against any backend version). Shallow
        // copy to avoid mutating the caller's object.
        if (isPreparedJsonMessage(data)) {
            const envelope = preparedJsonEnvelope(data);
            if (
                'request_id' in envelope
                && 'type' in envelope
                && !isRequestSignal(envelope.type)
            ) {
                try {
                    data = withPreparedJsonEnvelope(data, (current) => ({
                        ...current,
                        timing: { ...current.timing, ...resolveBusyContext() },
                    }));
                } catch (error) {
                    logger(`AgentService: Failed to attach busy context: ${error}`, 1);
                }
            }
        } else if (
            'request_id' in data
            && 'type' in data
            && !isRequestSignal((data as any).type)
        ) {
            try {
                data = {
                    ...data,
                    timing: { ...(data as any).timing, ...resolveBusyContext() },
                };
            } catch (error) {
                logger(`AgentService: Failed to attach busy context: ${error}`, 1);
            }
        }

        const message = isPreparedJsonMessage(data)
            ? materializePreparedJsonMessage(data)
            : JSON.stringify(data);
        
        // Sanitize sensitive data for logging
        const sanitizedData: Record<string, any> = isPreparedJsonMessage(data)
            ? { ...preparedJsonEnvelope(data), result: '[stripped document result for log]' }
            : { ...data };
        if ('api_key' in sanitizedData) {
            sanitizedData.api_key = '[REDACTED]';
        }
        if ('custom_model' in sanitizedData && typeof sanitizedData.custom_model === 'object') {
            sanitizedData.custom_model = {
                ...sanitizedData.custom_model,
                api_key: sanitizedData.custom_model.api_key ? '[REDACTED]' : undefined
            };
        }
        // Strip large payloads from the LOG copy only. The wire payload at
        // line :311 uses the original `data`
        if ('type' in sanitizedData && sanitizedData.type === 'zotero_attachment_page_images' && 'pages' in sanitizedData) {
            const n = Array.isArray((sanitizedData as any).pages) ? (sanitizedData as any).pages.length : 0;
            sanitizedData.pages = `[stripped ${n} page image(s) for log]`;
        }
        if ('type' in sanitizedData && sanitizedData.type === 'zotero_document' && 'result' in sanitizedData) {
            sanitizedData.result = '[stripped document result for log]';
        }
        // Log the sanitized and stripped data
        logger(`AgentService: Sending "${sanitizedData.type}"`, sanitizedData, 1);

        try {
            this.ws.send(message);
        } catch (error) {
            logger(`AgentService: Send failed: ${error}`, 1);
            return false;
        }
        return true;
    }

    /** Busy snapshot plus transport state, shared by acks and keepalives. */
    private transportBusyContext(receivedAt: number): Record<string, number> {
        const now = Date.now();
        const oldest = this.queuedMessageArrivals[0];
        return {
            ...resolveBusyContext(),
            dispatch_lag_ms: Math.max(0, now - receivedAt),
            queue_depth: this.queuedMessageArrivals.length,
            queue_oldest_ms: oldest === undefined ? 0 : Math.max(0, now - oldest),
        };
    }

    /**
     * Acknowledge a backend→frontend request as received. Called from the
     * socket's message handler before the message enters the queue. Gated on
     * the backend's `supports_request_acks` capability (older backends would
     * route the ack to the pending request as its response). Best-effort:
     * never blocks or fails request dispatch.
     */
    private maybeAckRequest(event: WSEvent, receivedAt: number): void {
        if (!this.serverSupportsRequestAcks) return;
        const requestId = (event as any).request_id;
        if (typeof requestId !== 'string' || !isBackendRequestEvent(event.event)) return;
        try {
            const ack: WSRequestReceivedAck = {
                type: 'request_received',
                request_id: requestId,
                busy: this.transportBusyContext(receivedAt),
            };
            this.send(ack);
        } catch (error) {
            logger(`AgentService: Failed to send request_received ack: ${error}`, 1);
        }
    }

    /**
     * Start `request_keepalive` for a backend request as soon as it arrives.
     * The backend keeps waiting on slow work while these arrive and treats
     * silence after the first one as a frozen client. The controller is parked
     * under the request id until the dispatcher takes it over (see
     * `takeKeepalive`); it reports `queued` until then.
     */
    private maybeStartKeepalive(event: WSEvent, receivedAt: number): void {
        if (!this.serverSupportsRequestKeepalive) return;
        const requestId = (event as any).request_id;
        if (typeof requestId !== 'string' || !isBackendRequestEvent(event.event)) return;
        this.pendingKeepalives.set(requestId, this.startKeepalive(requestId, receivedAt, 'queued'));
    }

    /** Hand a parked keepalive to the dispatcher; a no-op controller when none was started. */
    private takeKeepalive(requestId: string | null): RequestKeepalive {
        if (requestId === null) return NOOP_KEEPALIVE;
        const keepalive = this.pendingKeepalives.get(requestId);
        if (!keepalive) return NOOP_KEEPALIVE;
        this.pendingKeepalives.delete(requestId);
        return keepalive;
    }

    private startKeepalive(requestId: string, receivedAt: number, initialPhase: string): RequestKeepalive {
        const connId = this.connectionId;
        let phase = initialPhase;
        const controller: RequestKeepalive = {
            setPhase: (next: string) => { phase = next; },
            stop: () => {
                clearInterval(timer);
                this.activeKeepalives.delete(controller);
                this.pendingKeepalives.delete(requestId);
            },
        };
        const tick = () => {
            // The connection was replaced under a still-running handler:
            // the new socket must not carry this request's keepalives.
            if (this.connectionId !== connId) {
                controller.stop();
                return;
            }
            try {
                const keepalive: WSRequestKeepalive = {
                    type: 'request_keepalive',
                    request_id: requestId,
                    phase,
                    elapsed_ms: Math.max(0, Date.now() - receivedAt),
                    busy: this.transportBusyContext(receivedAt),
                };
                this.send(keepalive);
            } catch (error) {
                logger(`AgentService: Failed to send request_keepalive: ${error}`, 1);
            }
        };
        const timer = setInterval(tick, REQUEST_KEEPALIVE_INTERVAL_MS);
        this.activeKeepalives.add(controller);
        return controller;
    }

    private stopAllKeepalives(): void {
        for (const keepalive of Array.from(this.activeKeepalives)) {
            keepalive.stop();
        }
        this.activeKeepalives.clear();
        this.pendingKeepalives.clear();
        for (const stop of Array.from(this.questionKeepalives.values())) stop();
        this.questionKeepalives.clear();
    }

    /**
     * Start reporting that this client can still answer a question card.
     *
     * The backend waits a long time for a card that paces itself, so silence is
     * what tells it the client cannot answer — the plugin's single JS thread
     * frozen — and lets the run continue instead of parking for the whole
     * window. Started at socket receipt, like the request keepalive, so the
     * first one is on the wire before the card renders and a blocked message
     * queue does not look like a dead client.
     *
     * Deliberately NOT owned by the card: it unmounts whenever the Beaver pane
     * is closed or collapsed (the sidebars render null), and a question the
     * user can still come back to must not be reclaimed for that.
     */
    private maybeStartQuestionKeepalive(event: WSEvent): void {
        if (!this.serverSupportsQuestionKeepalive) return;
        if (event.event !== 'ask_user_question_request') return;
        const questionId = event.question_id;
        if (typeof questionId !== 'string' || this.questionKeepalives.has(questionId)) return;

        const connId = this.connectionId;
        // The backend stops listening at the end of its own window, which it
        // states in the request. Self-limiting here is what retires a timer for
        // a card the backend gave up on: no response is ever sent for one, so
        // there is nothing else to stop it.
        //
        // Counted in ticks rather than against a wall-clock deadline: a clock
        // step (NTP, resume) would otherwise stop the pings while the backend —
        // which measures monotonically — is still waiting, and be reported as a
        // frozen client. Overrunning the window instead is harmless; the frames
        // are simply unroutable.
        const windowMs = typeof event.timeout_seconds === 'number' && event.timeout_seconds > 0
            ? event.timeout_seconds * 1000
            : DEFAULT_BACKEND_TIMEOUT_MS;
        let ticksLeft = Math.ceil(windowMs / QUESTION_KEEPALIVE_INTERVAL_MS);

        const tick = () => {
            // The connection was replaced under a card that is still up: the
            // new socket knows nothing about this question id.
            if (this.connectionId !== connId || ticksLeft-- <= 0) {
                this.stopQuestionKeepalive(questionId);
                return;
            }
            try {
                const keepalive: WSQuestionKeepalive = {
                    type: 'question_keepalive',
                    question_id: questionId,
                };
                this.send(keepalive);
            } catch (error) {
                logger(`AgentService: Failed to send question_keepalive: ${error}`, 1);
            }
        };

        const timer = setInterval(tick, QUESTION_KEEPALIVE_INTERVAL_MS);
        this.questionKeepalives.set(questionId, () => clearInterval(timer));
        tick();
    }

    /** Stop reporting on a question (its answer went out, or its window closed). */
    private stopQuestionKeepalive(questionId: string): void {
        const stop = this.questionKeepalives.get(questionId);
        if (!stop) return;
        this.questionKeepalives.delete(questionId);
        stop();
    }

    /** Parse a raw socket frame; null (after reporting) when it is not a usable event. */
    private parseMessage(rawData: unknown): WSEvent | null {
        if (!this.callbacks) return null;
        // Guard against invalid data during close handshake
        if (typeof rawData !== 'string' || !rawData) {
            logger('AgentService: Received invalid message data (likely during close)', 1);
            return null;
        }
        try {
            return JSON.parse(rawData) as WSEvent;
        } catch (error) {
            logger(`AgentService: Failed to parse message: ${error}`, 1);
            this.callbacks.onError({
                event: 'error',
                type: 'parse_error',
                message: 'Failed to parse server message',
            });
            return null;
        }
    }

    /**
     * Handle a parsed WebSocket message.
     * Async to support callbacks that load item data before updating state.
     * Messages are serialized via messageQueue to preserve processing order;
     * the request ack has already been sent by the time this runs.
     */
    private async handleMessage(event: WSEvent, receivedAt: number = Date.now()): Promise<void> {
        if (!this.callbacks) return;

        try {
            switch (event.event) {
                case 'ready': {
                    this.serverSupportsRequestAcks = event.supports_request_acks === true;
                    this.serverSupportsRequestKeepalive = event.supports_request_keepalive === true;
                    this.serverSupportsQuestionKeepalive = event.supports_question_keepalive === true;
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
                    await this.callbacks.onPart(event);
                    break;

                case 'tool_return':
                    await this.callbacks.onToolReturn(event);
                    break;
                
                case 'tool_call_progress':
                    this.callbacks.onToolCallProgress(event);
                    break;

                case 'tool_call_args_stream':
                    this.callbacks.onToolCallArgsStream(event);
                    break;

                case 'run_complete':
                    await this.callbacks.onRunComplete(event);
                    break;

                case 'run_citations':
                    await this.callbacks.onRunCitations?.(event);
                    break;

                case 'streaming_done':
                    this.callbacks.onStreamingDone?.(event);
                    break;

                case 'done':
                    this.callbacks.onDone();
                    break;

                case 'thread':
                    this.callbacks.onThread(event.thread_id, event.retry_truncation);
                    break;

                case 'thread_name':
                    this.callbacks.onThreadName?.(event);
                    break;

                case 'error': {
                    // Call onError callback
                    this.callbacks.onError(event);
                    // Backend behavior: some errors close connection (auth, internal), 
                    // others keep it open (LLM errors, rate limits, invalid_request).
                    // Since each connect() is for a single run (for now), close on any error.
                    // Use a small delay to avoid race with server-initiated close.
                    const errorSocket = this.ws;
                    const errorConnectionId = this.connectionId;
                    setTimeout(() => {
                        if (
                            this.connectionId === errorConnectionId &&
                            this.ws === errorSocket &&
                            this.ws &&
                            this.ws.readyState !== WebSocket.CLOSED
                        ) {
                            // Firefox/Zotero only allows code 1000 or 3000-4999 for close()
                            // 1011 causes InvalidAccessError, so we use 1000 (Normal Closure)
                            this.close(1000, `Client closing after error: ${event.type}`);
                        }
                    }, 100);
                    break;
                }

                case 'warning':
                    this.callbacks.onWarning(event);
                    break;

                case 'agent_actions':
                    await this.callbacks.onAgentActions?.(event);
                    break;

                case 'retry':
                    this.callbacks.onRetry?.(event);
                    break;

                case 'missing_zotero_data':
                    this.callbacks.onMissingZoteroData?.(event);
                    break;

                case 'deferred_approval_request':
                    logger("AgentService: Received deferred_approval_request", event, 1);
                    // This event is handled by the UI via callback
                    if (this.callbacks?.onDeferredApprovalRequest) {
                        this.callbacks.onDeferredApprovalRequest(event);
                    } else {
                        // No handler - auto-reject to avoid blocking the agent
                        logger("AgentService: No deferred approval handler, auto-rejecting", 1);
                        this.send({
                            type: 'deferred_approval_response',
                            action_id: event.action_id,
                            approved: false,
                        });
                    }
                    break;

                case 'deferred_approval_stale':
                    logger("AgentService: Received deferred_approval_stale", event, 1);
                    this.callbacks?.onDeferredApprovalStale?.(event);
                    break;

                case 'credit_confirmation_request':
                    logger("AgentService: Received credit_confirmation_request", event, 1);
                    // This event is handled by the UI via callback
                    if (this.callbacks?.onCreditConfirmationRequest) {
                        this.callbacks.onCreditConfirmationRequest(event);
                    } else {
                        // No handler - decline so the run wraps up now instead of
                        // spending credits or waiting out the confirmation timeout.
                        logger("AgentService: No credit confirmation handler, auto-declining", 1);
                        this.send({
                            type: 'credit_confirmation_response',
                            confirmation_id: event.confirmation_id,
                            approved: false,
                        });
                    }
                    break;

                case 'credit_confirmation_stale':
                    logger("AgentService: Received credit_confirmation_stale", event, 1);
                    this.callbacks?.onCreditConfirmationStale?.(event);
                    break;

                case 'batch_approval_request':
                    logger("AgentService: Received batch_approval_request", event, 1);
                    // This event is handled by the UI via callback
                    if (this.callbacks?.onBatchApprovalRequest) {
                        this.callbacks.onBatchApprovalRequest(event);
                    } else {
                        // No handler - decline. Declining cancels the batch, which
                        // is the safe outcome for a client that cannot show the
                        // card: dropping the event would stall the run for the
                        // whole approval timeout, and approving would grant
                        // coverage the user was never shown.
                        logger("AgentService: No batch approval handler, auto-declining", 1);
                        this.send({
                            type: 'batch_approval_response',
                            approval_id: event.approval_id,
                            approved: false,
                            // A response is only well-formed with a mode. Echo the
                            // mode the card would have preselected.
                            mode: event.default_mode ?? 'full_access',
                        });
                    }
                    break;

                case 'batch_approval_stale':
                    logger("AgentService: Received batch_approval_stale", event, 1);
                    this.callbacks?.onBatchApprovalStale?.(event);
                    break;

                case 'ask_user_question_request':
                    logger("AgentService: Received ask_user_question_request", event, 1);
                    // This event is handled by the UI via callback
                    if (this.callbacks?.onAskUserQuestionRequest) {
                        this.callbacks.onAskUserQuestionRequest(event);
                    } else {
                        // No handler - auto-cancel so the agent never hangs.
                        // Through the sender, not `send`: it is what stops this
                        // question's keepalive, which would otherwise keep
                        // firing at a backend that has already moved on.
                        logger("AgentService: No ask_user_question handler, auto-cancelling", 1);
                        this.sendAskUserQuestionResponse(event.question_id, [], true);
                    }
                    break;

                default: {
                    // Data-request events are dispatched through the injectable
                    // data-provider map rather than hardcoded cases. The handler
                    // resolves with the response to send; on failure — or when
                    // the map has no entry — an error reply is sent so the
                    // backend doesn't time out.
                    const eventName = (event as any).event;
                    const dataEvent = event as any;
                    const requestId = typeof dataEvent.request_id === 'string' ? dataEvent.request_id : null;
                    // Started on receipt (see onmessage), so time spent in the
                    // message queue or behind other executes is reported as
                    // `queued` rather than as silence.
                    const keepalive = this.takeKeepalive(requestId);
                    const entry = this.getDataProvider()[eventName];
                    if (!entry) {
                        keepalive.stop();
                        logger(`AgentService: Unknown event type: ${eventName}`, 1);
                        const errorResponse = unknownDataRequestErrorResponse(event);
                        if (errorResponse) {
                            this.send(errorResponse);
                        }
                        break;
                    }
                    logger(`AgentService: Received ${eventName}`, dataEvent, 1);
                    const context: AgentDataRequestContext = {
                        receivedAt,
                        reportPhase: (phase) => keepalive.setPhase(phase),
                    };
                    const runRequest = (): Promise<void> => {
                        keepalive.setPhase('running');
                        return entry.handle(dataEvent, context)
                            .then(res => { keepalive.stop(); this.send(res); })
                            .catch(err => {
                                keepalive.stop();
                                logger(`AgentService: ${eventName} failed: ${err}`, 1);
                                this.send(entry.errorResponse(dataEvent, err));
                            });
                    };
                    if (entry.serialize) {
                        // Chain onto actionExecutionQueue to serialize mutating
                        // actions. Capture connectionId so stale queued actions
                        // are skipped after a close/reconnect (same guard as
                        // messageQueue).
                        const actionConnId = this.connectionId;
                        this.actionExecutionQueue = this.actionExecutionQueue.then(() => {
                            if (this.connectionId !== actionConnId) {
                                keepalive.stop();
                                return;
                            }
                            return runRequest();
                        });
                    } else {
                        runRequest();
                    }
                    break;
                }
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
    close(
        code: number = 1000,
        reason: string = 'Client closing',
        options: { notifyClose?: boolean; onlyIfConnectionId?: number } = {},
    ): void {
        const { notifyClose = true, onlyIfConnectionId } = options;

        // A caller that captured its connection generation up front (e.g. a
        // deferred close inside cancel()) must not tear down a newer
        // connection that superseded it in the meantime.
        if (onlyIfConnectionId !== undefined && onlyIfConnectionId !== this.connectionId) {
            logger('AgentService: Skipping close for superseded connection', 1);
            return;
        }

        const wsToClose = this.ws;
        const callbacks = this.callbacks;
        const finishConnect = this.activeConnectFinish;

        if (wsToClose) {
            // Only attempt to close if not already closing/closed
            // CLOSING = 2, CLOSED = 3
            if (wsToClose.readyState === WebSocket.OPEN || wsToClose.readyState === WebSocket.CONNECTING) {
                logger(`AgentService: Closing connection - code=${code}, reason=${reason}`, 1);
                try {
                    wsToClose.close(code, reason);
                } catch (error) {
                    // Log but don't throw - the connection may already be closing from server side
                    logger(`AgentService: Error closing WebSocket (state=${wsToClose.readyState}): ${error}`, 1);
                }
            } else {
                logger(`AgentService: WebSocket already closing/closed (state=${wsToClose.readyState})`, 1);
            }
        }
        this.resetConnectionState();
        // Clear the in-progress flag even when the attempt has not created
        // its settle handle yet (i.e. it is still awaiting the auth token),
        // so a new connect() is not silently swallowed by the overlap guard.
        this.connecting = false;
        if (notifyClose) {
            callbacks?.onClose?.(code, reason, true);
        }
        // Resolve (not reject) a pending connect: an intentional client close
        // is not a transport failure, and the closing caller has already
        // updated any run/UI state itself.
        finishConnect?.();
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

        // Capture the generation being cancelled: if a new run connects
        // during the flush wait below, the deferred close must not tear it down.
        const connectionIdToCancel = this.connectionId;

        // Send cancel message to backend
        logger('AgentService: Sending cancel message', 1);
        this.ws.send(JSON.stringify({ type: 'cancel' }));

        // Wait briefly to allow the message to be flushed
        await new Promise(resolve => setTimeout(resolve, waitMs));

        // Close the connection (no-op if a newer connection superseded it)
        this.close(1000, 'User cancelled', { onlyIfConnectionId: connectionIdToCancel });
    }

    /**
     * Send a response to a deferred approval request.
     * Called by the UI when the user approves or rejects an action.
     * @param actionId The action ID from the approval request
     * @param approved Whether the user approved the action
     * @param userInstructions Optional additional instructions from the user
     * @returns false if the socket was not open, so the decision never left the
     *   client. The caller must recover the card rather than wait for a reply
     *   that cannot come.
     */
    sendApprovalResponse(actionId: string, approved: boolean, userInstructions?: string | null): boolean {
        logger(`AgentService: Sending approval response for ${actionId}: ${approved}${userInstructions ? ' (with instructions)' : ''}`, 1);
        return this.send({
            type: 'deferred_approval_response',
            action_id: actionId,
            approved,
            user_instructions: userInstructions,
        });
    }

    /**
     * Send a response to a run-level credit confirmation request.
     * Called by the UI when the user lets the run continue or declines.
     * @param confirmationId The confirmation ID from the request
     * @param approved Whether the user let the run continue
     * @param userInstructions Optional additional instructions from the user
     * @returns false if the socket was not open, so the decision never left the
     *   client. The caller must recover the card rather than wait for a reply
     *   that cannot come.
     */
    sendCreditConfirmationResponse(
        confirmationId: string,
        approved: boolean,
        userInstructions?: string | null,
    ): boolean {
        logger(`AgentService: Sending credit confirmation response for ${confirmationId}: ${approved}${userInstructions ? ' (with instructions)' : ''}`, 1);
        return this.send({
            type: 'credit_confirmation_response',
            confirmation_id: confirmationId,
            approved,
            user_instructions: userInstructions,
        });
    }

    /**
     * Send a response to a batch approval request.
     * Called by the UI when the user approves or declines the batch.
     * @param approvalId The approval ID from the request
     * @param approved Whether the user approved the batch
     * @param mode Coverage the decision grants for the life of the batch
     * @param userInstructions Optional instructions from the user. Meaningful on
     *   both paths: they constrain an approved batch and say what to do instead
     *   when the batch is declined.
     * @returns false if the socket was not open, so the decision never left the
     *   client. The caller must recover the card rather than wait for a reply
     *   that cannot come.
     */
    sendBatchApprovalResponse(
        approvalId: string,
        approved: boolean,
        mode: BatchApprovalMode,
        userInstructions?: string | null,
    ): boolean {
        logger(`AgentService: Sending batch approval response for ${approvalId}: ${approved} (${mode})${userInstructions ? ' (with instructions)' : ''}`, 1);
        return this.send({
            type: 'batch_approval_response',
            approval_id: approvalId,
            approved,
            mode,
            user_instructions: userInstructions,
        });
    }

    /**
     * Send a response to an ask_user_question request.
     * Called by the UI when the user submits their answers or skips the card.
     * Note: like deferred_approval_response, this carries no request_id — the
     * backend correlates by question_id.
     * @param questionId The question ID from the request
     * @param answers The user's answers (empty when cancelled)
     * @param cancelled Whether the user skipped the question(s)
     * @returns false if the socket was not open, so the response never left the
     *   client. The caller must recover the card rather than wait for a reply
     *   that cannot come.
     */
    sendAskUserQuestionResponse(
        questionId: string,
        answers: AskUserQuestionAnswer[],
        cancelled: boolean = false,
        timedOut: boolean = false,
    ): boolean {
        const outcome = timedOut ? 'timed out' : cancelled ? 'cancelled' : `${answers.length} answer(s)`;
        logger(`AgentService: Sending ask_user_question response for ${questionId}: ${outcome}`, 1);
        this.stopQuestionKeepalive(questionId);
        return this.send({
            type: 'ask_user_question_response',
            question_id: questionId,
            answers,
            cancelled,
            ...(timedOut ? { timed_out: true } : {}),
        });
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
    constructor(baseUrl?: string) {
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

export const agentService = new AgentService();
export const agentRunService = new AgentRunService();
