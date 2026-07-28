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

import {
    AgentConnectionError,
    AgentService,
    ConnectTimeoutError,
    TERMINAL_SETTLE_TIMEOUT_MS,
} from '../../../src/services/agentService';
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
        onRunCitations: vi.fn(),
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
        expect(callbacks.onClose).toHaveBeenCalledWith(
            1011,
            'transport lost',
            false,
            expect.objectContaining({
                stage: 'mid_run',
                socketOpened: true,
                readyReceived: true,
                closeCode: 1011,
                // The socket opened and received the ready message, so both
                // timing measurements are available for diagnostics.
                wsUptimeMs: expect.any(Number),
                msSinceLastWsMessageMs: expect.any(Number),
            }),
        );
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
        expect(callbacks.onClose).toHaveBeenCalledWith(
            1008,
            'invalid token',
            false,
            expect.objectContaining({
                stage: 'awaiting_ready',
                socketOpened: true,
                readyReceived: false,
                closeCode: 1008,
            }),
        );
    });

    it('distinguishes a 1006 opening failure from a socket that opened', async () => {
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks();
        const initialCount = MockWebSocket.instances.length;
        const outcomePromise = service.connect(
            { type: 'refused-connection-test' } as AgentRunRequest,
            callbacks,
        ).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
        );

        await flushMicrotasks();
        const socket = MockWebSocket.instances[initialCount];
        expect(socket).toBeDefined();
        socket.emitClose({ code: 1006, reason: '', wasClean: false });

        const outcome = await outcomePromise;
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
            expect(outcome.error).toBeInstanceOf(AgentConnectionError);
            expect((outcome.error as AgentConnectionError).evidence).toMatchObject({
                stage: 'opening',
                socketOpened: false,
                readyReceived: false,
                closeCode: 1006,
                // Never opened, never received a message — no timing evidence.
                wsUptimeMs: null,
                msSinceLastWsMessageMs: null,
            });
        }
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

    it('releases cancel() on the backend acknowledgement, not on a timer', async () => {
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks();
        const socket = await completeConnect(service, callbacks, {
            type: 'cancel-ack',
        } as AgentRunRequest);

        let settled = false;
        const cancelPromise = service.cancel().then(() => { settled = true; });

        // The cancel message goes out immediately...
        expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'cancel' }));

        // ...but the caller stays blocked. This is exactly the window in which
        // a new message would read a thread whose stopped run has no messages.
        await vi.advanceTimersByTimeAsync(1_000);
        await flushMicrotasks();
        expect(settled).toBe(false);
        expect(socket.close).not.toHaveBeenCalled();

        // The backend answers once the run's content is durable.
        socket.emitMessage({
            event: 'error',
            type: 'canceled',
            message: 'Canceled by client',
            run_id: 'run-1',
        });
        await flushMicrotasks();
        await cancelPromise;
        expect(settled).toBe(true);

        // And the socket is still open: the partial answer's citations are
        // resolved over it, and `done` is what closes it.
        expect(socket.close).not.toHaveBeenCalled();
    });

    it('lets cancel() proceed when the backend never acknowledges', async () => {
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks();
        const socket = await completeConnect(service, callbacks, {
            type: 'cancel-timeout',
        } as AgentRunRequest);

        let settled = false;
        const cancelPromise = service.cancel(500).then(() => { settled = true; });

        await vi.advanceTimersByTimeAsync(499);
        await flushMicrotasks();
        expect(settled).toBe(false);

        // Expiring degrades to the behaviour that preceded the handshake —
        // proceeding without proof — rather than hanging the composer.
        await vi.advanceTimersByTimeAsync(2);
        await cancelPromise;
        expect(settled).toBe(true);
        expect(socket.close).not.toHaveBeenCalled();
    });

    it('resolves cancel() immediately once run_complete has already arrived', async () => {
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks();
        const socket = await completeConnect(service, callbacks, {
            type: 'cancel-after-complete',
        } as AgentRunRequest);

        // The run finishes. The backend writes it, sends this, and only then
        // goes off to resolve the citations — which can run for seconds, with
        // the footer (and its Retry button) live the whole time.
        socket.emitMessage({
            event: 'run_complete',
            run_id: 'run-1',
            usage: null,
            cost: null,
            citations: null,
        });
        await flushMicrotasks();

        const sendCallsBefore = socket.send.mock.calls.length;

        // Retry pressed during the lookup. No `canceled` frame is coming for a
        // run that already finished, so waiting could only end at `done` or at
        // the 5s cap — the dead click this latch exists to remove.
        let settled = false;
        const cancelPromise = service.cancel().then(() => { settled = true; });
        await flushMicrotasks();
        expect(settled).toBe(true);
        await cancelPromise;

        // Nothing was asked of the backend: cancelling a finished run would
        // record a CLIENT_CANCEL cause on it that is simply untrue.
        expect(socket.send.mock.calls.length).toBe(sendCallsBefore);
        expect(socket.close).not.toHaveBeenCalled();
    });

    it('resolves cancel() immediately once an error frame has already arrived', async () => {
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks();
        const socket = await completeConnect(service, callbacks, {
            type: 'cancel-after-error',
        } as AgentRunRequest);

        socket.emitMessage({
            event: 'error',
            type: 'llm_timeout',
            message: 'The model timed out',
            run_id: 'run-1',
        });
        await flushMicrotasks();

        const sendCallsBefore = socket.send.mock.calls.length;

        // This is Retry in RunErrorDisplay: the user reads the error, then
        // clicks. The run was durable before the banner rendered.
        let settled = false;
        const cancelPromise = service.cancel().then(() => { settled = true; });
        await flushMicrotasks();
        expect(settled).toBe(true);
        await cancelPromise;

        expect(socket.send.mock.calls.length).toBe(sendCallsBefore);
    });

    it('re-arms the wait for the next run on a fresh connection', async () => {
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks();
        const firstSocket = await completeConnect(service, callbacks, {
            type: 'durable-run',
        } as AgentRunRequest);

        firstSocket.emitMessage({
            event: 'run_complete',
            run_id: 'run-1',
            usage: null,
            cost: null,
            citations: null,
        });
        await flushMicrotasks();

        // The retry opens a new connection, which supersedes the old socket.
        const secondSocket = await completeConnect(service, callbacks, {
            type: 'next-run',
        } as AgentRunRequest);

        // The new run has not been written, so a stop on it must wait for the
        // acknowledgement exactly as before — the latch describes one run, not
        // the service.
        let settled = false;
        const cancelPromise = service.cancel().then(() => { settled = true; });
        await flushMicrotasks();

        expect(secondSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'cancel' }));
        expect(settled).toBe(false);

        secondSocket.emitMessage({
            event: 'error',
            type: 'canceled',
            message: 'Canceled by client',
            run_id: 'run-2',
        });
        await flushMicrotasks();
        await cancelPromise;
        expect(settled).toBe(true);
    });

    it('does not close on a terminal frame, so the citations after it arrive', async () => {
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks();
        const socket = await completeConnect(service, callbacks, {
            type: 'error-then-citations',
        } as AgentRunRequest);

        socket.emitMessage({
            event: 'error',
            type: 'llm_timeout',
            message: 'Provider timed out',
            run_id: 'run-1',
        });
        await flushMicrotasks();

        // This used to close 100ms after the error frame, which cut off the
        // lookup the backend now runs after it.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(socket.close).not.toHaveBeenCalled();

        socket.emitMessage({ event: 'run_citations', run_id: 'run-1', citations: [] });
        await flushMicrotasks();
        expect(callbacks.onRunCitations).toHaveBeenCalledTimes(1);
    });

    it('closes a socket whose done never arrives', async () => {
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks();
        const socket = await completeConnect(service, callbacks, {
            type: 'no-done',
        } as AgentRunRequest);

        socket.emitMessage({
            event: 'error',
            type: 'llm_timeout',
            message: 'Provider timed out',
            run_id: 'run-1',
        });
        await flushMicrotasks();

        await vi.advanceTimersByTimeAsync(TERMINAL_SETTLE_TIMEOUT_MS + 100);
        expect(socket.close).toHaveBeenCalled();
    });

    it('does not let a stale terminal backstop tear down a newer connection', async () => {
        const service = new AgentService('https://api.example.com');
        const firstCallbacks = createCallbacks();
        const firstSocket = await completeConnect(service, firstCallbacks, {
            type: 'first',
        } as AgentRunRequest);

        firstSocket.emitMessage({
            event: 'error',
            type: 'llm_timeout',
            message: 'Provider timed out',
            run_id: 'run-1',
        });
        await flushMicrotasks();

        // A retry connects while the first connection's backstop is still armed.
        const secondCallbacks = createCallbacks();
        const secondSocket = await completeConnect(service, secondCallbacks, {
            type: 'second',
        } as AgentRunRequest);
        expect(secondSocket).not.toBe(firstSocket);

        await vi.advanceTimersByTimeAsync(TERMINAL_SETTLE_TIMEOUT_MS + 100);

        expect(secondSocket.close).not.toHaveBeenCalled();
        expect(secondCallbacks.onClose).not.toHaveBeenCalled();

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
            // The error type is the only signal a timeout leaves behind: the
            // attempt is torn down with close code 1000, so callers cannot
            // tell it apart from a network outage by close code alone.
            expect(outcome.error).toBeInstanceOf(ConnectTimeoutError);
            expect((outcome.error as Error).message).toContain('timed out');
        }
        expect(callbacks.onClose).toHaveBeenCalledWith(1000, 'Connection attempt timed out', true);

        // The service recovered its state: a new connect succeeds.
        const secondCallbacks = createCallbacks();
        const secondSocket = await completeConnect(service, secondCallbacks, request);
        expect(secondSocket).not.toBe(socket);
        expect(secondCallbacks.onReady).toHaveBeenCalledTimes(1);
    });

    it('identifies a timeout that occurs while checking the auth session', async () => {
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks();
        const request = { type: 'auth-timeout-test' } as AgentRunRequest;
        mockSupabase.auth.getSession.mockReturnValueOnce(new Promise(() => {}));

        const outcomePromise = service.connect(request, callbacks).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
        );
        await vi.advanceTimersByTimeAsync(20_000);

        const outcome = await outcomePromise;
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
            expect(outcome.error).toBeInstanceOf(ConnectTimeoutError);
            expect((outcome.error as ConnectTimeoutError).evidence).toMatchObject({
                stage: 'auth',
                socketOpened: false,
                readyReceived: false,
                timedOut: true,
            });
        }
    });

    it('drops a queued done when the socket closes while run_complete is processing', async () => {
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks();
        const request = { type: 'queued-done-test' } as AgentRunRequest;

        // Hold the run_complete handler open so the queued `done` message
        // stays behind it in the message queue.
        let releaseRunComplete: () => void = () => {};
        const runCompleteGate = new Promise<void>((resolve) => {
            releaseRunComplete = resolve;
        });
        (callbacks.onRunComplete as ReturnType<typeof vi.fn>).mockImplementation(() => runCompleteGate);

        const socket = await completeConnect(service, callbacks, request);

        socket.emitMessage({
            event: 'run_complete',
            run_id: 'run-1',
            usage: null,
            cost: null,
            citations: null,
            agent_actions: null,
        });
        socket.emitMessage({ event: 'done' });
        await flushMicrotasks();

        // run_complete's handler is suspended awaiting onRunComplete, so the
        // queued `done` has not been dispatched yet.
        expect(callbacks.onRunComplete).toHaveBeenCalledTimes(1);
        expect(callbacks.onDone).not.toHaveBeenCalled();

        // The socket closes while that handler is still suspended. This
        // bumps the connection id via resetConnectionState().
        socket.emitClose({ code: 1000, reason: '', wasClean: true });

        // Now let the suspended run_complete handler resume. The queued
        // `done` handler runs next, but its stale-connection-id guard makes
        // it a no-op because the id no longer matches.
        releaseRunComplete();
        await flushMicrotasks();

        expect(callbacks.onRunComplete).toHaveBeenCalledTimes(1);
        expect(callbacks.onClose).toHaveBeenCalledTimes(1);
        // A `done` that was queued behind a still-processing run_complete is
        // silently dropped once the socket has closed in the meantime. The
        // React layer's onClose handler finalizes the run itself and relies
        // on this behavior rather than expecting a late `done` event.
        expect(callbacks.onDone).not.toHaveBeenCalled();
    });

    it('includes close evidence only for a real socket close, not a client-initiated one', async () => {
        // A real transport close carries a `ConnectionFailureEvidence` object
        // as the 4th onClose argument.
        const serverCloseService = new AgentService('https://api.example.com');
        const serverCloseCallbacks = createCallbacks();
        await completeConnect(
            serverCloseService,
            serverCloseCallbacks,
            { type: 'server-close-test' } as AgentRunRequest,
        );
        const serverSocket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
        serverSocket.emitClose({ code: 1011, reason: 'transport lost', wasClean: false });

        expect(serverCloseCallbacks.onClose).toHaveBeenCalledTimes(1);
        const serverCloseArgs = (serverCloseCallbacks.onClose as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(serverCloseArgs).toHaveLength(4);
        expect(serverCloseArgs[3]).toEqual(expect.objectContaining({ closeCode: 1011 }));

        // A client-initiated close (service.close(), including the deferred
        // close inside cancel()) reports wasClean=true unconditionally and
        // omits the evidence argument entirely, since there is no transport
        // failure to characterize. This is the contract the React layer's
        // onClose guard uses to tell a server close from a client close.
        const clientCloseService = new AgentService('https://api.example.com');
        const clientCloseCallbacks = createCallbacks();
        await completeConnect(
            clientCloseService,
            clientCloseCallbacks,
            { type: 'client-close-test' } as AgentRunRequest,
        );
        clientCloseService.close(1000, 'User cancelled');

        expect(clientCloseCallbacks.onClose).toHaveBeenCalledTimes(1);
        const clientCloseArgs = (clientCloseCallbacks.onClose as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(clientCloseArgs).toHaveLength(3);
        expect(clientCloseArgs[2]).toBe(true);
        expect(clientCloseArgs[3]).toBeUndefined();
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
