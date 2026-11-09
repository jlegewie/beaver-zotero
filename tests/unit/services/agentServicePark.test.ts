/**
 * Leaving a run that waits only on cards: the client asks the server to park
 * it (`park` frame) instead of stopping it, and stops it only when the server
 * refuses. These tests drive the real `AgentService` against scripted sockets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSupabase } = vi.hoisted(() => ({
    mockSupabase: {
        auth: {
            getSession: vi.fn(),
            refreshSession: vi.fn(),
        },
    },
}));

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: mockSupabase,
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));

import { AgentService } from '@beaver/agent-core/transport/agentService';
import { setClientIdentityProvider } from '@beaver/agent-core/transport/clientIdentity';
import type { AgentRunRequest, WSCallbacks } from '@beaver/agent-core/protocol/agentProtocol';

class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readonly url: string;
    readyState = MockWebSocket.CONNECTING;
    bufferedAmount = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    send = vi.fn();
    close = vi.fn((code?: number) => {
        this.readyState = MockWebSocket.CLOSING;
        this.closeCode = code;
    });
    closeCode?: number;

    constructor(url: string) {
        this.url = url;
        MockWebSocket.instances.push(this);
    }

    emitOpen(): void {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.(new Event('open'));
    }

    emitMessage(data: unknown): void {
        this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
    }

    emitClose(code: number, reason = ''): void {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.({ code, reason, wasClean: code === 1000 } as CloseEvent);
    }

    sent(): Record<string, any>[] {
        return this.send.mock.calls.map(([raw]) => JSON.parse(raw as string));
    }

    sentOfType(type: string): Record<string, any>[] {
        return this.sent().filter((message) => message.type === type);
    }
}

const RUN_ID = 'run-1';
const TOKEN = 'reattach-token';

const READY = {
    event: 'ready',
    subscription_status: 'active',
    processing_mode: 'fast',
    indexing_complete: true,
    supports_heartbeat: true,
    supports_request_acks: true,
    supports_request_keepalive: true,
};
const READY_WITH_REATTACH = { ...READY, supports_run_reattach: true, reattach_grace_s: 120 };

const CHAT_REQUEST = {
    type: 'chat',
    run_id: RUN_ID,
    thread_id: null,
    user_prompt: { content: 'hello' },
} as unknown as AgentRunRequest;

function createCallbacks(overrides: Partial<WSCallbacks> = {}): WSCallbacks {
    return {
        onReady: vi.fn(),
        onRequestAck: vi.fn(),
        onPart: vi.fn().mockResolvedValue(undefined),
        onToolReturn: vi.fn().mockResolvedValue(undefined),
        onToolCallProgress: vi.fn(),
        onToolCallArgsStream: vi.fn(),
        onRunComplete: vi.fn().mockResolvedValue(undefined),
        onRunCitations: vi.fn().mockResolvedValue(undefined),
        onStreamingDone: vi.fn(),
        onDone: vi.fn(),
        onThread: vi.fn(),
        onError: vi.fn(),
        onWarning: vi.fn(),
        onDeferredApprovalRequest: vi.fn(),
        onAskUserQuestionRequest: vi.fn(),
        onOpen: vi.fn(),
        onClose: vi.fn(),
        onReattaching: vi.fn(),
        onReattached: vi.fn(),
        onReattachFailed: vi.fn(),
        ...overrides,
    };
}

async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
}

/** Wait for the next socket the service opens, then open it and say `ready`. */
async function acceptNextSocket(ready: Record<string, unknown>): Promise<MockWebSocket> {
    const count = MockWebSocket.instances.length;
    for (let i = 0; i < 50 && MockWebSocket.instances.length === count; i++) {
        await Promise.resolve();
    }
    const socket = MockWebSocket.instances[count];
    if (!socket) throw new Error('Expected a new WebSocket');
    socket.emitOpen();
    await vi.advanceTimersByTimeAsync(50);
    socket.emitMessage(ready);
    await flush();
    return socket;
}

/** Start a run against a backend that reattaches runs, up to its `request_ack`. */
async function startRun(
    service: AgentService,
    callbacks: WSCallbacks,
    ready: Record<string, unknown> = READY_WITH_REATTACH,
): Promise<MockWebSocket> {
    const connecting = service.connect(CHAT_REQUEST, callbacks);
    const socket = await acceptNextSocket(ready);
    await connecting;
    socket.emitMessage({
        event: 'request_ack',
        run_id: RUN_ID,
        model_id: null,
        model_name: null,
        charge_type: 'credits',
        reattach_token: TOKEN,
        seq: 1,
    });
    await flush();
    return socket;
}

describe('AgentService.parkRun', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        MockWebSocket.instances = [];
        vi.stubGlobal('WebSocket', MockWebSocket);
        vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
        setClientIdentityProvider(() => ({
            frontendVersion: '0.99.0',
            clientType: 'zotero-plugin',
            clientFeatures: ['parked_runs'],
        }));
        mockSupabase.auth.getSession.mockReset();
        mockSupabase.auth.getSession.mockResolvedValue({
            data: {
                session: {
                    access_token: 'token',
                    expires_at: Math.floor(Date.now() / 1000) + 3600,
                },
            },
            error: null,
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('sends park and closes quietly once the server has ended the run', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const socket = await startRun(service, callbacks, READY);

        const parking = service.parkRun(RUN_ID);
        expect(socket.sentOfType('park')).toEqual([{ type: 'park', run_id: RUN_ID }]);
        socket.emitMessage({
            event: 'run_complete',
            run_id: RUN_ID,
            usage: null,
            cost: null,
            citations: null,
            agent_actions: null,
            parked: { version: 1, parked_at: '2026-11-08T10:00:00Z', reason: 'client_left', requests: [] },
            seq: 2,
        });
        socket.emitMessage({ event: 'done', seq: 3 });
        await flush();

        await expect(parking).resolves.toBe('ended');
        expect(socket.sentOfType('cancel')).toHaveLength(0);
        expect(socket.close).toHaveBeenCalledWith(1000, 'Run parked');
        expect(callbacks.onClose).not.toHaveBeenCalled();
    });

    it('stops the run when the server refuses to park it', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const socket = await startRun(service, callbacks, READY);

        const parking = service.parkRun(RUN_ID);
        socket.emitMessage({ event: 'park_refused', run_id: RUN_ID, reason: 'not_parkable', seq: 2 });
        await flush();
        await vi.advanceTimersByTimeAsync(300);

        await expect(parking).resolves.toBe('refused');
        expect(socket.sentOfType('cancel')).toHaveLength(1);
    });

    it('closes without a cancel when the server does not answer in time', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const socket = await startRun(service, callbacks, READY);

        const parking = service.parkRun(RUN_ID, 1000);
        await vi.advanceTimersByTimeAsync(1000);

        // The server keeps a park it has received even when the socket closes.
        await expect(parking).resolves.toBe('sent');
        expect(socket.sentOfType('cancel')).toHaveLength(0);
        expect(socket.close).toHaveBeenCalledWith(1000, 'Run parked');
    });

    it('does nothing for a run it does not have', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const socket = await startRun(service, callbacks, READY);

        await expect(service.parkRun('another-run')).resolves.toBe('unavailable');
        expect(service.sendPark('another-run')).toBe(false);
        expect(socket.sentOfType('park')).toHaveLength(0);
    });
});
