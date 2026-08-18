/**
 * Batch approval: transport.
 *
 * The backend asks once per batch — not per mutating tool call — before a
 * batch starts changing the library, and composes the card copy itself. These
 * tests pin the parts that keep a batch from hanging or from being covered
 * silently: the request has to reach the handler that owns the card, a client
 * with no such surface has to decline in a shape the backend can read, and a
 * decision has to leave the socket with the correlation id and coverage mode
 * the backend answers on.
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

vi.mock('../../../src/utils/zoteroUtils', () => ({
    loadFullItemDataWithAllTypes: vi.fn(),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test' })),
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

import { AgentService } from '@beaver/agent-core/transport/agentService';
import type {
    AgentRunRequest,
    WSBatchApprovalRequest,
    WSCallbacks,
} from '@beaver/agent-core/protocol/agentProtocol';

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
    close = vi.fn(() => {
        this.readyState = MockWebSocket.CLOSING;
    });

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

    sentMessages(): Record<string, any>[] {
        return this.send.mock.calls.map(([raw]) => JSON.parse(raw as string));
    }
}

function createCallbacks(overrides: Partial<WSCallbacks> = {}): WSCallbacks {
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
        onBatchApprovalRequest: vi.fn(),
        onBatchApprovalStale: vi.fn(),
        onOpen: vi.fn(),
        onClose: vi.fn(),
        ...overrides,
    };
}

const request: AgentRunRequest = {
    thread_id: 'thread-1',
    user_prompt: { content: 'hello' },
} as unknown as AgentRunRequest;

async function completeConnect(
    service: AgentService,
    callbacks: WSCallbacks,
): Promise<MockWebSocket> {
    const initialCount = MockWebSocket.instances.length;
    const connectPromise = service.connect(request, callbacks);

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

function approvalEvent(
    overrides: Partial<WSBatchApprovalRequest> = {},
): WSBatchApprovalRequest {
    return {
        event: 'batch_approval_request',
        approval_id: 'appr-1',
        run_id: 'run-1',
        thread_id: 'thread-1',
        toolcall_id: 'call-1',
        batch_id: 'b1',
        title: 'Approve batch operation',
        message: 'Assign one broad topic tag to every item and remove all prior tags',
        destructive_warning: 'Removes every existing tag from these items',
        credit_note: 'Approving raises the confirmation limit for this thread to 12 credits.',
        default_mode: 'full_access',
        approve_label: 'Approve',
        decline_label: 'Reject',
        learn_more_label: '',
        learn_more_path: '',
        timeout_seconds: 180,
        ...overrides,
    };
}

describe('AgentService batch approval transport', () => {
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

    it('dispatches batch_approval_request to the registered handler', async () => {
        const service = new AgentService('https://api.example.com');
        const onBatchApprovalRequest = vi.fn();
        const callbacks = createCallbacks({ onBatchApprovalRequest });
        const socket = await completeConnect(service, callbacks);

        const event = approvalEvent();
        socket.emitMessage(event);
        await vi.advanceTimersByTimeAsync(0);

        expect(onBatchApprovalRequest).toHaveBeenCalledWith(event);
        // Nothing is auto-sent while a handler owns the card.
        expect(
            socket.sentMessages().filter((m) => m.type === 'batch_approval_response'),
        ).toHaveLength(0);
    });

    it('auto-declines with a well-formed response when no handler is registered', async () => {
        // Declining cancels the batch. Dropping the event would stall the run
        // for the whole approval timeout, and the response is only readable
        // with a mode, so the card's preselected mode is echoed back.
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks();
        delete (callbacks as Partial<WSCallbacks>).onBatchApprovalRequest;
        const socket = await completeConnect(service, callbacks);

        socket.emitMessage(approvalEvent({ default_mode: 'ask_each_time' }));
        await vi.advanceTimersByTimeAsync(0);

        const responses = socket
            .sentMessages()
            .filter((m) => m.type === 'batch_approval_response');
        expect(responses).toHaveLength(1);
        expect(responses[0]).toEqual({
            type: 'batch_approval_response',
            approval_id: 'appr-1',
            approved: false,
            mode: 'ask_each_time',
        });
    });

    it('auto-declines with full_access when the request carries no default mode', async () => {
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks();
        delete (callbacks as Partial<WSCallbacks>).onBatchApprovalRequest;
        const socket = await completeConnect(service, callbacks);

        const { default_mode: _omitted, ...withoutMode } = approvalEvent();
        socket.emitMessage(withoutMode);
        await vi.advanceTimersByTimeAsync(0);

        const responses = socket
            .sentMessages()
            .filter((m) => m.type === 'batch_approval_response');
        expect(responses).toHaveLength(1);
        expect(responses[0]).toMatchObject({ approved: false, mode: 'full_access' });
    });

    it('forwards batch_approval_stale to the registered handler', async () => {
        const service = new AgentService('https://api.example.com');
        const onBatchApprovalStale = vi.fn();
        const socket = await completeConnect(
            service,
            createCallbacks({ onBatchApprovalStale }),
        );

        socket.emitMessage({
            event: 'batch_approval_stale',
            approval_id: 'appr-1',
            reason: 'timed_out',
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(onBatchApprovalStale).toHaveBeenCalledWith(
            expect.objectContaining({ approval_id: 'appr-1', reason: 'timed_out' }),
        );
    });

    it('tolerates batch_approval_stale with no handler registered', async () => {
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks();
        delete (callbacks as Partial<WSCallbacks>).onBatchApprovalStale;
        const socket = await completeConnect(service, callbacks);

        socket.emitMessage({
            event: 'batch_approval_stale',
            approval_id: 'appr-1',
            reason: 'unknown',
        });
        await vi.advanceTimersByTimeAsync(0);

        // Nothing to apply locally and nothing to answer.
        expect(socket.sentMessages().filter((m) => m.type === 'batch_approval_response'))
            .toHaveLength(0);
    });

    it('sends the decision with the correlation id and mode the backend answers on', async () => {
        const service = new AgentService('https://api.example.com');
        const socket = await completeConnect(service, createCallbacks());

        expect(
            service.sendBatchApprovalResponse('appr-1', true, 'full_access', 'keep CD4/CD8'),
        ).toBe(true);

        const responses = socket
            .sentMessages()
            .filter((m) => m.type === 'batch_approval_response');
        expect(responses).toHaveLength(1);
        expect(responses[0]).toMatchObject({
            type: 'batch_approval_response',
            approval_id: 'appr-1',
            approved: true,
            mode: 'full_access',
            user_instructions: 'keep CD4/CD8',
        });
    });

    it('reports a decision that never left the client', () => {
        const service = new AgentService('https://api.example.com');

        expect(service.sendBatchApprovalResponse('appr-1', false, 'ask_each_time')).toBe(false);
    });
});
