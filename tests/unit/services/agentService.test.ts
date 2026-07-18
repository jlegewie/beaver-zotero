import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSupabase } = vi.hoisted(() => ({
    mockSupabase: {
        auth: {
            getSession: vi.fn(),
            refreshSession: vi.fn(),
        },
    },
}));

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: mockSupabase,
}));

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

vi.mock('../../../src/services/agentDataProvider', () => ({
    handleZoteroDataRequest: vi.fn(),
    handleExternalReferenceCheckRequest: vi.fn(),
    handleZoteroDocumentRequest: vi.fn(),
    handleZoteroAttachmentPageImagesRequest: vi.fn(),
    handleZoteroAttachmentImageRequest: vi.fn(),
    handleZoteroViewImagesRequest: vi.fn(),
    handleZoteroAttachmentSearchRequest: vi.fn(),
    handleItemSearchByMetadataRequest: vi.fn(),
    handleItemSearchByTopicRequest: vi.fn(),
    handleZoteroSearchRequest: vi.fn(),
    handleListItemsRequest: vi.fn(),
    handleListCollectionsRequest: vi.fn(),
    handleListTagsRequest: vi.fn(),
    handleListLibrariesRequest: vi.fn(),
    handleGetMetadataRequest: vi.fn(),
    handleGetAnnotationsRequest: vi.fn(),
    handleFindAnnotationsRequest: vi.fn(),
    handleAgentActionValidateRequest: vi.fn(),
    handleAgentActionExecuteRequest: vi.fn(),
    handleReadNoteRequest: vi.fn(),
}));

vi.mock('../../../react/agents/agentActions', () => ({
    toAgentAction: vi.fn((action) => action),
}));

import { AgentService } from '../../../src/services/agentService';
import type { AgentRunRequest, WSCallbacks } from '../../../src/services/agentProtocol';

class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readonly url: string;
    readyState = MockWebSocket.CONNECTING;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    send = vi.fn();
    close = vi.fn((code?: number, reason?: string) => {
        this.readyState = MockWebSocket.CLOSING;
        this.closeCode = code;
        this.closeReason = reason;
    });
    closeCode?: number;
    closeReason?: string;

    constructor(url: string) {
        this.url = url;
        MockWebSocket.instances.push(this);
    }

    emitOpen(): void {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.(new Event('open'));
    }

    emitMessage(data: unknown): void {
        this.onmessage?.({
            data: JSON.stringify(data),
        } as MessageEvent);
    }

    emitClose(init: { code?: number; reason?: string; wasClean?: boolean } = {}): void {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.({
            code: init.code ?? 1000,
            reason: init.reason ?? '',
            wasClean: init.wasClean ?? true,
        } as CloseEvent);
    }
}

function createCallbacks(): WSCallbacks {
    return {
        onReady: vi.fn(),
        onRequestAck: vi.fn(),
        onPart: vi.fn().mockResolvedValue(undefined),
        onToolReturn: vi.fn().mockResolvedValue(undefined),
        onToolCallProgress: vi.fn(),
        onToolCallArgsStream: vi.fn(),
        onRunComplete: vi.fn().mockResolvedValue(undefined),
        onStreamingDone: vi.fn(),
        onDone: vi.fn(),
        onThread: vi.fn(),
        onThreadName: vi.fn(),
        onError: vi.fn(),
        onWarning: vi.fn(),
        onAgentActions: vi.fn().mockResolvedValue(undefined),
        onRetry: vi.fn(),
        onMissingZoteroData: vi.fn(),
        onDeferredApprovalRequest: vi.fn(),
        onOpen: vi.fn(),
        onClose: vi.fn(),
    };
}

async function flushMicrotasks(ticks = 10): Promise<void> {
    for (let i = 0; i < ticks; i++) {
        await Promise.resolve();
    }
}

async function completeConnect(
    service: AgentService,
    callbacks: WSCallbacks,
    request: AgentRunRequest,
    frontendVersion?: string,
): Promise<MockWebSocket> {
    const initialCount = MockWebSocket.instances.length;
    const connectPromise = service.connect(request, callbacks, frontendVersion);

    // connect() awaits getAuthToken() (which awaits the mocked supabase
    // session) before `new WebSocket(...)` runs, so we need to flush the
    // microtask queue before the new socket instance appears.
    for (let i = 0; i < 20 && MockWebSocket.instances.length === initialCount; i++) {
        await Promise.resolve();
    }

    const socket = MockWebSocket.instances[initialCount];
    if (!socket) {
        throw new Error('Expected AgentService.connect() to create a WebSocket');
    }

    socket.emitOpen();
    await vi.advanceTimersByTimeAsync(50);
    socket.emitMessage({
        event: 'ready',
        subscription_status: 'active',
        processing_mode: 'fast',
        indexing_complete: true,
    });
    await connectPromise;

    return socket;
}

describe('AgentService reconnect handling', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        MockWebSocket.instances = [];
        vi.stubGlobal('WebSocket', MockWebSocket);

        mockSupabase.auth.getSession.mockReset();
        mockSupabase.auth.refreshSession.mockReset();
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

    it('silently supersedes the old socket on reconnect and ignores its later close event', async () => {
        const service = new AgentService('https://api.example.com');
        const firstCallbacks = createCallbacks();
        const secondCallbacks = createCallbacks();
        const firstRequest = { type: 'first' } as AgentRunRequest;
        const secondRequest = { type: 'second' } as AgentRunRequest;

        const firstSocket = await completeConnect(service, firstCallbacks, firstRequest);
        const secondSocket = await completeConnect(service, secondCallbacks, secondRequest);

        expect(firstSocket.close).toHaveBeenCalledTimes(1);
        expect(firstSocket.close).toHaveBeenCalledWith(1000, 'Client closing');
        expect(firstCallbacks.onClose).not.toHaveBeenCalled();

        firstSocket.emitClose({
            code: 1011,
            reason: 'stale socket',
            wasClean: false,
        });

        secondSocket.emitMessage({
            event: 'part',
            run_id: 'run-2',
            message_index: 0,
            part_index: 0,
            part: { type: 'text', text: 'still streaming' },
        });
        await flushMicrotasks();

        expect(firstCallbacks.onClose).not.toHaveBeenCalled();
        expect(secondCallbacks.onClose).not.toHaveBeenCalled();
        expect(secondCallbacks.onPart).toHaveBeenCalledTimes(1);
    });

    it('notifies close once for an explicit client close and ignores the later socket event', async () => {
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks();
        const request = { type: 'close-test' } as AgentRunRequest;

        const socket = await completeConnect(service, callbacks, request);

        service.close(1000, 'User cancelled');
        socket.emitClose({
            code: 1000,
            reason: 'User cancelled',
            wasClean: true,
        });

        expect(callbacks.onClose).toHaveBeenCalledTimes(1);
        expect(callbacks.onClose).toHaveBeenCalledWith(1000, 'User cancelled', true);
    });

    it('notifies onClose for an unexpected transport close on the active socket', async () => {
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks();
        const request = { type: 'close-test' } as AgentRunRequest;

        const socket = await completeConnect(service, callbacks, request);

        socket.emitClose({
            code: 1011,
            reason: 'transport lost',
            wasClean: false,
        });

        expect(callbacks.onClose).toHaveBeenCalledTimes(1);
        expect(callbacks.onClose).toHaveBeenCalledWith(1011, 'transport lost', false);
    });

    it('rejects connect() and notifies onClose when the socket closes before ready', async () => {
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks();
        const request = { type: 'pre-ready-close-test' } as AgentRunRequest;

        const initialCount = MockWebSocket.instances.length;
        const connectPromise = service.connect(request, callbacks);
        // Attach a handler immediately so the eventual rejection (triggered
        // further down, once the mock socket exists) is never left unhandled.
        const connectOutcome = connectPromise.then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
        );

        for (let i = 0; i < 20 && MockWebSocket.instances.length === initialCount; i++) {
            await Promise.resolve();
        }
        const socket = MockWebSocket.instances[initialCount];
        if (!socket) {
            throw new Error('Expected AgentService.connect() to create a WebSocket');
        }

        // The transport opens (so auth is sent) but the server rejects the
        // connection before the "ready" event — e.g. an invalid/expired token.
        socket.emitOpen();
        await vi.advanceTimersByTimeAsync(50);
        socket.emitClose({ code: 1008, reason: 'invalid token', wasClean: false });

        const outcome = await connectOutcome;
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
            expect(outcome.error).toBeInstanceOf(Error);
            expect((outcome.error as Error).message).toContain('invalid token');
        }

        // The close details reach callers through onClose, not the rejection.
        expect(callbacks.onClose).toHaveBeenCalledTimes(1);
        expect(callbacks.onClose).toHaveBeenCalledWith(1008, 'invalid token', false);
    });

    it('resolves a canceled pre-ready connect and allows the next run to connect', async () => {
        const service = new AgentService('https://api.example.com');
        const firstCallbacks = createCallbacks();
        const request = { type: 'cancel-handshake-test' } as AgentRunRequest;

        const initialCount = MockWebSocket.instances.length;
        const firstConnect = service.connect(request, firstCallbacks);
        const firstOutcome = firstConnect.then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
        );

        for (let i = 0; i < 20 && MockWebSocket.instances.length === initialCount; i++) {
            await Promise.resolve();
        }
        const firstSocket = MockWebSocket.instances[initialCount];
        if (!firstSocket) {
            throw new Error('Expected AgentService.connect() to create a WebSocket');
        }

        // The transport is open and auth was sent, but the backend has not
        // emitted ready yet — cancelling in this handshake window must settle
        // the pending connect() instead of leaving it hanging.
        firstSocket.emitOpen();
        await vi.advanceTimersByTimeAsync(50);
        const cancelPromise = service.cancel(0);
        await vi.advanceTimersByTimeAsync(0);
        await cancelPromise;

        // An intentional client close is not a transport failure: the
        // pending connect resolves quietly.
        const outcome = await firstOutcome;
        expect(outcome.ok).toBe(true);

        const secondCallbacks = createCallbacks();
        const secondSocket = await completeConnect(service, secondCallbacks, request);
        expect(secondSocket).not.toBe(firstSocket);
        expect(secondCallbacks.onReady).toHaveBeenCalledTimes(1);
    });

    it('ignores a deferred cancel close when a newer connection has taken over', async () => {
        const service = new AgentService('https://api.example.com');
        const firstCallbacks = createCallbacks();
        const firstRequest = { type: 'first' } as AgentRunRequest;

        const firstSocket = await completeConnect(service, firstCallbacks, firstRequest);

        // cancel() sends the cancel message, then waits before closing.
        const cancelPromise = service.cancel(250);

        // A new run connects during that wait and supersedes the first
        // connection (bumping the connection generation).
        const secondCallbacks = createCallbacks();
        const secondRequest = { type: 'second' } as AgentRunRequest;
        const secondSocket = await completeConnect(service, secondCallbacks, secondRequest);
        expect(secondSocket).not.toBe(firstSocket);

        // When the deferred close finally fires, it must not tear down the
        // newer connection.
        await vi.advanceTimersByTimeAsync(300);
        await cancelPromise;

        expect(secondSocket.close).not.toHaveBeenCalled();
        expect(secondCallbacks.onClose).not.toHaveBeenCalled();

        // The newer connection is still fully functional.
        secondSocket.emitMessage({
            event: 'part',
            run_id: 'run-2',
            message_index: 0,
            part_index: 0,
            part: { type: 'text', text: 'still streaming' },
        });
        await flushMicrotasks();
        expect(secondCallbacks.onPart).toHaveBeenCalledTimes(1);
    });

    it('fails a connect attempt that never reaches ready via the backstop timeout', async () => {
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks();
        const request = { type: 'timeout-test' } as AgentRunRequest;

        const initialCount = MockWebSocket.instances.length;
        const connectPromise = service.connect(request, callbacks);
        const connectOutcome = connectPromise.then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
        );

        for (let i = 0; i < 20 && MockWebSocket.instances.length === initialCount; i++) {
            await Promise.resolve();
        }
        const socket = MockWebSocket.instances[initialCount];
        if (!socket) {
            throw new Error('Expected AgentService.connect() to create a WebSocket');
        }

        // The transport opens and auth is sent, but the server never responds
        // with ready, an error event, or a close.
        socket.emitOpen();
        await vi.advanceTimersByTimeAsync(50);
        await vi.advanceTimersByTimeAsync(20_000);

        const outcome = await connectOutcome;
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
            expect((outcome.error as Error).message).toContain('timed out');
        }
        expect(callbacks.onClose).toHaveBeenCalledWith(1000, 'Connection attempt timed out', true);

        // The service recovered its state: a new connect succeeds.
        const secondCallbacks = createCallbacks();
        const secondSocket = await completeConnect(service, secondCallbacks, request);
        expect(secondSocket).not.toBe(socket);
        expect(secondCallbacks.onReady).toHaveBeenCalledTimes(1);
    });

    it('does not let a stale backstop timeout tear down a newer connection', async () => {
        const service = new AgentService('https://api.example.com');
        const firstCallbacks = createCallbacks();
        const request = { type: 'stale-timeout-test' } as AgentRunRequest;

        // The first attempt's auth-token lookup hangs indefinitely.
        mockSupabase.auth.getSession.mockReturnValueOnce(new Promise(() => {}));
        const initialCount = MockWebSocket.instances.length;
        const firstConnect = service.connect(request, firstCallbacks);
        const firstOutcome = firstConnect.then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
        );
        await flushMicrotasks();
        expect(MockWebSocket.instances.length).toBe(initialCount);

        // The user cancels while the token lookup is pending, then starts a
        // new run that connects normally.
        const cancelPromise = service.cancel(0);
        await vi.advanceTimersByTimeAsync(0);
        await cancelPromise;

        const secondCallbacks = createCallbacks();
        const secondSocket = await completeConnect(service, secondCallbacks, request);

        // When the abandoned attempt's backstop fires, it must not close the
        // newer connection or reject anything.
        await vi.advanceTimersByTimeAsync(20_000);
        expect(secondSocket.close).not.toHaveBeenCalled();
        expect(secondCallbacks.onClose).not.toHaveBeenCalled();

        // The abandoned attempt settles quietly rather than as a failure.
        const outcome = await firstOutcome;
        expect(outcome.ok).toBe(true);
    });
});
