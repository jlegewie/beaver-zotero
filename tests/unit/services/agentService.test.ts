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
    handleZoteroAttachmentPagesRequest: vi.fn(),
    handleZoteroAttachmentPageImagesRequest: vi.fn(),
    handleZoteroAttachmentSearchRequest: vi.fn(),
    handleItemSearchByMetadataRequest: vi.fn(),
    handleItemSearchByTopicRequest: vi.fn(),
    handleZoteroSearchRequest: vi.fn(),
    handleListItemsRequest: vi.fn(),
    handleListCollectionsRequest: vi.fn(),
    handleListTagsRequest: vi.fn(),
    handleListLibrariesRequest: vi.fn(),
    handleGetMetadataRequest: vi.fn(),
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
});
