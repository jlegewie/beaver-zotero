/**
 * Provider-mode WebSocket connection.
 *
 * A provider connection serves the backend's Zotero data requests for agent
 * runs that were started on another client (e.g. the Word add-in), using the
 * exact same data handlers as a regular chat connection. It never starts runs.
 *
 * Lifecycle:
 * - Opened on demand — normally in response to a `provider-wake` Supabase
 *   broadcast, or manually from a dev/test trigger.
 * - Authenticates with the same first-message handshake as the chat
 *   connection, plus an echo of the wake's `wake_id`/`instance_id` so the
 *   backend can correlate the connection with the wake that requested it.
 * - The backend closes the connection after an inactivity timeout; the plugin
 *   does not keep it alive. If the socket drops abnormally (not a normal
 *   server close), one reconnect attempt is made so an in-flight agent run is
 *   not stranded; beyond that, the next wake reopens it.
 */

import API_BASE_URL from '../utils/getAPIBaseURL';
import { logger } from '../utils/logger';
import { buildZoteroInstanceWire } from './zoteroInstanceWire';
import { store } from '../../react/store';
import { searchableLibraryIdsAtom } from '../../react/atoms/profile';
import {
    AgentDataProviderMap,
    createZoteroDataProvider,
} from './agentDataDispatch';
import { getWSAuthToken } from './agentService';
import {
    WSAuthMessage,
    WSRequestReceivedAck,
    ZOTERO_PLUGIN_CLIENT_TYPE,
    ZOTERO_PLUGIN_FEATURES,
    ZoteroInstanceWire,
} from './agentProtocol';
import { getBusyContext } from './busyContext';
import {
    isPreparedJsonMessage,
    materializePreparedJsonMessage,
    preparedJsonEnvelope,
    withPreparedJsonEnvelope,
    type PreparedJsonMessage,
} from './preparedJsonMessage';
import {
    PROVIDER_MUTATING_RUN_SYNC_PAUSE_OWNER,
    scheduleResumeAfterRun,
} from './syncPause';

/** Options for opening a provider connection. */
export interface ProviderConnectOptions {
    /** wake_id from the provider-wake broadcast (echoed to the backend). */
    wakeId?: string;
    /** Originating backend instance_id from the wake broadcast (echoed). */
    wakeInstanceId?: string;
}

/** Status snapshot for diagnostics / dev test endpoints. */
export interface ProviderConnectionStatus {
    state: 'disconnected' | 'connecting' | 'connected';
    connectedAt: number | null;
    lastWakeId: string | null;
    requestsServed: number;
    lastRequestAt: number | null;
    lastCloseCode: number | null;
    lastCloseReason: string | null;
    reconnectAttempts: number;
}

function getZoteroInstanceWire(): ZoteroInstanceWire {
    return buildZoteroInstanceWire(store.get(searchableLibraryIdsAtom));
}

export class ProviderConnection {
    private baseUrl: string;
    private ws: WebSocket | null = null;
    private connecting: boolean = false;
    /** Monotonic counter incremented on close to invalidate stale queued messages */
    private connectionId: number = 0;
    /** Queue to serialize async message processing */
    private messageQueue: Promise<void> = Promise.resolve();
    /** Queue to serialize mutating action execution */
    private actionExecutionQueue: Promise<void> = Promise.resolve();
    private serverSupportsRequestAcks: boolean = false;
    private dataProvider: AgentDataProviderMap;
    /** Settles the in-flight connect promise; set for the duration of connect(). */
    private activeFinish: ((err?: Error) => void) | null = null;
    /** Set by close() so a connect() still fetching its token aborts cleanly. */
    private connectAborted: boolean = false;

    // Diagnostics
    private connectedAt: number | null = null;
    private lastWakeId: string | null = null;
    private requestsServed: number = 0;
    private lastRequestAt: number | null = null;
    private lastCloseCode: number | null = null;
    private lastCloseReason: string | null = null;
    private reconnectAttempts: number = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(baseUrl: string, dataProvider?: AgentDataProviderMap) {
        this.baseUrl = baseUrl;
        this.dataProvider = dataProvider ?? createZoteroDataProvider({
            syncPauseOwner: PROVIDER_MUTATING_RUN_SYNC_PAUSE_OWNER,
        });
    }

    private getWebSocketUrl(): string {
        const wsProtocol = this.baseUrl.startsWith('https') ? 'wss' : 'ws';
        const httpUrl = new URL(this.baseUrl);
        return `${wsProtocol}://${httpUrl.host}/api/v1/agents/beaver/provider`;
    }

    isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    getStatus(): ProviderConnectionStatus {
        return {
            state: this.isConnected()
                ? 'connected'
                : this.connecting
                    ? 'connecting'
                    : 'disconnected',
            connectedAt: this.connectedAt,
            lastWakeId: this.lastWakeId,
            requestsServed: this.requestsServed,
            lastRequestAt: this.lastRequestAt,
            lastCloseCode: this.lastCloseCode,
            lastCloseReason: this.lastCloseReason,
            reconnectAttempts: this.reconnectAttempts,
        };
    }

    /**
     * Open the provider connection and resolve once the backend sends `ready`.
     * No-op if already connected or a connect is in progress.
     */
    async connect(options: ProviderConnectOptions = {}): Promise<void> {
        if (this.isConnected()) {
            logger('ProviderConnection: Already connected, ignoring connect()', 1);
            return;
        }
        if (this.connecting) {
            logger('ProviderConnection: connect() already in progress, ignoring duplicate call', 1);
            return;
        }
        this.connecting = true;
        this.connectAborted = false;
        this.cancelScheduledReconnect();
        this.lastWakeId = options.wakeId ?? null;
        const connectStartedAtMs = Date.now();

        try {
            const token = await getWSAuthToken();

            // close() may have been called while the token fetch was in
            // flight; don't open a socket the caller already tore down.
            if (this.connectAborted) {
                throw new Error('Provider connection closed during setup');
            }

            const authMessageBase: Omit<WSAuthMessage, 'connect_latency_ms'> = {
                type: 'auth',
                token,
                frontend_version: Zotero.Beaver?.pluginVersion || '',
                client_type: ZOTERO_PLUGIN_CLIENT_TYPE,
                client_features: ZOTERO_PLUGIN_FEATURES,
                zotero_instance: getZoteroInstanceWire(),
                connect_attempts: 1,
                ...(options.wakeId ? { wake_id: options.wakeId } : {}),
                ...(options.wakeInstanceId ? { wake_instance_id: options.wakeInstanceId } : {}),
            };

            const wsUrl = this.getWebSocketUrl();
            logger(`ProviderConnection: Connecting to ${wsUrl}`, 1);

            return await new Promise<void>((resolve, reject) => {
                let hasResolved = false;
                const finish = (err?: Error) => {
                    if (hasResolved) return;
                    hasResolved = true;
                    this.connecting = false;
                    if (this.activeFinish === finish) this.activeFinish = null;
                    if (err) reject(err); else resolve();
                };
                // Exposed so close() can settle an in-flight connect — its
                // onclose handler is skipped once resetConnectionState() has
                // detached this.ws, which would otherwise leave `connecting`
                // stuck true and block all future wakes.
                this.activeFinish = finish;

                this.ws = new WebSocket(wsUrl);
                const wsInstance = this.ws;
                const connId = ++this.connectionId;

                wsInstance.onopen = () => {
                    logger('ProviderConnection: Connection established, sending auth message', 1);
                    // Small delay so the server completes accept() before we send
                    // (same race guard as the chat connection).
                    setTimeout(() => {
                        if (wsInstance.readyState === WebSocket.OPEN) {
                            const authMessage: WSAuthMessage = {
                                ...authMessageBase,
                                connect_latency_ms: Math.max(0, Date.now() - connectStartedAtMs),
                            };
                            wsInstance.send(JSON.stringify(authMessage));
                        }
                    }, 50);
                };

                wsInstance.onmessage = (event) => {
                    const receivedAt = Date.now();
                    this.messageQueue = this.messageQueue.then(() => {
                        if (this.connectionId !== connId || this.ws !== wsInstance) return;
                        return this.handleMessage(event.data, receivedAt, () => finish());
                    }).catch(err => {
                        logger(`ProviderConnection: Unhandled error in message queue: ${err}`, 1);
                    });
                };

                wsInstance.onerror = () => {
                    logger('ProviderConnection: Connection error', 1);
                    finish(new Error('Provider connection failed'));
                };

                wsInstance.onclose = (event) => {
                    if (this.ws !== wsInstance) return;
                    logger(`ProviderConnection: Closed - code=${event.code}, reason=${event.reason}, clean=${event.wasClean}`, 1);
                    const wasConnected = this.connectedAt !== null;
                    this.lastCloseCode = event.code;
                    this.lastCloseReason = event.reason || null;
                    this.resetConnectionState();
                    finish(new Error(`Provider connection closed: ${event.reason || 'unknown reason'}`));
                    // A normal close (code 1000) is the backend's idle-close —
                    // expected; the next wake reopens. An abnormal drop after a
                    // successful connect gets one reconnect attempt so requests
                    // for an in-flight run are not stranded.
                    if (wasConnected && event.code !== 1000) {
                        this.scheduleReconnect();
                    }
                };
            });
        } catch (error) {
            this.connecting = false;
            logger(`ProviderConnection: Connection setup error: ${error}`, 1);
            throw error;
        }
    }

    /** Close the provider connection (e.g. on logout or pref toggle off). */
    close(code: number = 1000, reason: string = 'Client closing'): void {
        this.cancelScheduledReconnect();
        this.reconnectAttempts = 0;
        // Abort any connect() still in its setup phase (token fetch) and
        // settle an in-flight connect promise; once resetConnectionState()
        // detaches this.ws the socket's own onclose no longer reaches finish.
        this.connectAborted = true;
        const finish = this.activeFinish;
        const wsToClose = this.ws;
        if (wsToClose) {
            if (wsToClose.readyState === WebSocket.OPEN || wsToClose.readyState === WebSocket.CONNECTING) {
                logger(`ProviderConnection: Closing - code=${code}, reason=${reason}`, 1);
                try {
                    wsToClose.close(code, reason);
                } catch (error) {
                    logger(`ProviderConnection: Error closing WebSocket: ${error}`, 1);
                }
            }
        }
        this.resetConnectionState();
        finish?.(new Error('Provider connection closed by client'));
    }

    private resetConnectionState(): void {
        this.ws = null;
        this.connectionId++;
        this.messageQueue = Promise.resolve();
        this.actionExecutionQueue = Promise.resolve();
        this.serverSupportsRequestAcks = false;
        this.connectedAt = null;
    }

    private scheduleReconnect(): void {
        if (this.reconnectAttempts >= 1) {
            logger('ProviderConnection: Abnormal close after reconnect attempt — waiting for next wake', 1);
            this.reconnectAttempts = 0;
            return;
        }
        this.reconnectAttempts++;
        const wakeId = this.lastWakeId ?? undefined;
        logger('ProviderConnection: Scheduling reconnect after abnormal close', 1);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect({ wakeId }).then(() => {
                this.reconnectAttempts = 0;
            }).catch(err => {
                logger(`ProviderConnection: Reconnect failed: ${err}`, 1);
            });
        }, 2000);
    }

    private cancelScheduledReconnect(): void {
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private send(data: Record<string, any> | PreparedJsonMessage): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            logger('ProviderConnection: Cannot send - WebSocket not connected', 1);
            return;
        }
        // Attach a completion-time busy-context snapshot to request responses
        // (mirrors the chat connection; backend response models tolerate the
        // extra `timing` field).
        if (isPreparedJsonMessage(data)) {
            const envelope = preparedJsonEnvelope(data);
            if ('request_id' in envelope && 'type' in envelope && envelope.type !== 'request_received') {
                try {
                    data = withPreparedJsonEnvelope(data, (current) => ({
                        ...current,
                        timing: { ...current.timing, ...getBusyContext() },
                    }));
                } catch (error) {
                    logger(`ProviderConnection: Failed to attach busy context: ${error}`, 1);
                }
            }
        } else if ('request_id' in data && 'type' in data && data.type !== 'request_received') {
            try {
                data = { ...data, timing: { ...(data as any).timing, ...getBusyContext() } };
            } catch (error) {
                logger(`ProviderConnection: Failed to attach busy context: ${error}`, 1);
            }
        }
        const sanitized: Record<string, any> = isPreparedJsonMessage(data)
            ? { ...preparedJsonEnvelope(data), result: '[stripped for log]' }
            : { ...data };
        if ('pages' in sanitized && sanitized.type === 'zotero_attachment_page_images') {
            sanitized.pages = '[stripped for log]';
        }
        if ('result' in sanitized && sanitized.type === 'zotero_document') {
            sanitized.result = '[stripped for log]';
        }
        logger(`ProviderConnection: Sending "${sanitized.type}"`, sanitized, 1);
        this.ws.send(
            isPreparedJsonMessage(data)
                ? materializePreparedJsonMessage(data)
                : JSON.stringify(data),
        );
    }

    /** Ack a backend request before its handler runs (mirrors AgentService). */
    private maybeAckRequest(event: any, receivedAt: number): void {
        if (!this.serverSupportsRequestAcks) return;
        const requestId = event.request_id;
        const eventName = event.event;
        if (typeof requestId !== 'string' || typeof eventName !== 'string') return;
        if (
            !eventName.endsWith('_request')
            && eventName !== 'agent_action_validate'
            && eventName !== 'agent_action_execute'
        ) return;
        try {
            const ack: WSRequestReceivedAck = {
                type: 'request_received',
                request_id: requestId,
                busy: {
                    ...getBusyContext(),
                    dispatch_lag_ms: Math.max(0, Date.now() - receivedAt),
                },
            };
            this.send(ack);
        } catch (error) {
            logger(`ProviderConnection: Failed to send request_received ack: ${error}`, 1);
        }
    }

    private async handleMessage(
        rawData: string,
        receivedAt: number,
        onReady: () => void,
    ): Promise<void> {
        if (typeof rawData !== 'string' || !rawData) return;

        let event: any;
        try {
            event = JSON.parse(rawData);
        } catch (error) {
            logger(`ProviderConnection: Failed to parse message: ${error}`, 1);
            return;
        }

        this.maybeAckRequest(event, receivedAt);

        switch (event.event) {
            case 'ready': {
                this.serverSupportsRequestAcks = event.supports_request_acks === true;
                this.connectedAt = Date.now();
                logger('ProviderConnection: Ready — registered as provider', 1);
                onReady();
                break;
            }

            case 'error': {
                logger(`ProviderConnection: Server error: ${event.type} - ${event.message}`, 1);
                break;
            }

            default: {
                const eventName = event.event;
                const entry = this.dataProvider[eventName];
                if (!entry) {
                    logger(`ProviderConnection: Unknown event type: ${eventName}`, 1);
                    break;
                }
                logger(`ProviderConnection: Received ${eventName}`, 1);
                this.requestsServed++;
                this.lastRequestAt = Date.now();
                const runRequest = () =>
                    entry.handle(event)
                        .then(res => this.send(res))
                        .catch(err => {
                            logger(`ProviderConnection: ${eventName} failed: ${err}`, 1);
                            this.send(entry.errorResponse(event, err));
                        })
                        .finally(() => {
                            if (entry.syncPauseOwner) {
                                scheduleResumeAfterRun(entry.syncPauseOwner);
                            }
                        });
                if (entry.serialize) {
                    const actionConnId = this.connectionId;
                    this.actionExecutionQueue = this.actionExecutionQueue.then(() => {
                        if (this.connectionId !== actionConnId) return;
                        return runRequest();
                    });
                } else {
                    runRequest();
                }
                break;
            }
        }
    }
}

// =============================================================================
// Singleton
// =============================================================================

export const providerConnection = new ProviderConnection(API_BASE_URL);
