/**
 * Run-level credit confirmation: transport and pending state.
 *
 * The backend asks once per run — not per tool call — before a run spends
 * credits, and composes the card copy itself. These tests pin the parts that
 * keep a run from hanging: the request has to reach the pending map, a decision
 * has to leave the socket in the shape the backend correlates on, and every way
 * the decision can fail to arrive has to retire the card instead of leaving it
 * waiting on a reply that cannot come.
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

import { createStore } from 'jotai';
import { AgentService, agentService } from '@beaver/agent-core/transport/agentService';
import type {
    AgentRunRequest,
    WSCallbacks,
    WSCreditConfirmationRequest,
} from '@beaver/agent-core/protocol/agentProtocol';
import {
    addPendingCreditConfirmationAtom,
    clearAllPendingCreditConfirmationsAtom,
    pendingCreditConfirmationsAtom,
    removePendingCreditConfirmationAtom,
} from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import { sendCreditConfirmationResponseAtom } from '../../../react/atoms/agentRunAtoms';

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
        onCreditConfirmationRequest: vi.fn(),
        onCreditConfirmationStale: vi.fn(),
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

function confirmationEvent(
    overrides: Partial<WSCreditConfirmationRequest> = {},
): WSCreditConfirmationRequest {
    return {
        event: 'credit_confirmation_request',
        confirmation_id: 'conf-1',
        run_id: 'run-1',
        thread_id: 'thread-1',
        title: 'Continue this run?',
        message: 'This run is projected to use 6 credits.',
        details: ['Deep search: 5 credits'],
        approve_label: 'Continue',
        decline_label: 'Stop here',
        pending_credits: 5,
        projected_total_credits: 6,
        threshold: 5,
        timeout_seconds: 300,
        ...overrides,
    };
}

describe('AgentService credit confirmation transport', () => {
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

    it('dispatches credit_confirmation_request to the registered handler', async () => {
        const service = new AgentService('https://api.example.com');
        const onCreditConfirmationRequest = vi.fn();
        const callbacks = createCallbacks({ onCreditConfirmationRequest });
        const socket = await completeConnect(service, callbacks);

        const event = confirmationEvent();
        socket.emitMessage(event);
        await vi.advanceTimersByTimeAsync(0);

        expect(onCreditConfirmationRequest).toHaveBeenCalledWith(event);
        // Nothing is auto-sent while a handler owns the card.
        expect(
            socket.sentMessages().filter((m) => m.type === 'credit_confirmation_response'),
        ).toHaveLength(0);
    });

    it('auto-declines when no handler is registered', async () => {
        // Declining wraps the run up now; dropping the event would stall it for
        // the whole confirmation timeout.
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks();
        delete (callbacks as Partial<WSCallbacks>).onCreditConfirmationRequest;
        const socket = await completeConnect(service, callbacks);

        socket.emitMessage(confirmationEvent());
        await vi.advanceTimersByTimeAsync(0);

        const responses = socket
            .sentMessages()
            .filter((m) => m.type === 'credit_confirmation_response');
        expect(responses).toHaveLength(1);
        expect(responses[0]).toMatchObject({
            confirmation_id: 'conf-1',
            approved: false,
        });
    });

    it('forwards credit_confirmation_stale to the registered handler', async () => {
        const service = new AgentService('https://api.example.com');
        const onCreditConfirmationStale = vi.fn();
        const socket = await completeConnect(
            service,
            createCallbacks({ onCreditConfirmationStale }),
        );

        socket.emitMessage({
            event: 'credit_confirmation_stale',
            confirmation_id: 'conf-1',
            reason: 'timed_out',
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(onCreditConfirmationStale).toHaveBeenCalledWith(
            expect.objectContaining({ confirmation_id: 'conf-1', reason: 'timed_out' }),
        );
    });

    it('sends the decision with the correlation id the backend answers on', async () => {
        const service = new AgentService('https://api.example.com');
        const socket = await completeConnect(service, createCallbacks());

        expect(service.sendCreditConfirmationResponse('conf-1', true, 'stop after ten')).toBe(true);

        const responses = socket
            .sentMessages()
            .filter((m) => m.type === 'credit_confirmation_response');
        expect(responses).toHaveLength(1);
        expect(responses[0]).toMatchObject({
            type: 'credit_confirmation_response',
            confirmation_id: 'conf-1',
            approved: true,
            user_instructions: 'stop after ten',
        });
    });

    it('reports a decision that never left the client', () => {
        const service = new AgentService('https://api.example.com');

        expect(service.sendCreditConfirmationResponse('conf-1', true)).toBe(false);
    });
});

describe('pendingCreditConfirmations atoms', () => {
    it('adds a pending confirmation keyed by confirmationId', () => {
        const store = createStore();
        store.set(addPendingCreditConfirmationAtom, confirmationEvent());

        const map = store.get(pendingCreditConfirmationsAtom);
        expect(map.size).toBe(1);
        expect(map.get('conf-1')).toEqual({
            confirmationId: 'conf-1',
            runId: 'run-1',
            threadId: 'thread-1',
            title: 'Continue this run?',
            message: 'This run is projected to use 6 credits.',
            details: ['Deep search: 5 credits'],
            approveLabel: 'Continue',
            declineLabel: 'Stop here',
            pendingCredits: 5,
            projectedTotalCredits: 6,
            threshold: 5,
            timeoutSeconds: 300,
        });
    });

    it('removes a pending confirmation by id (the stale-notice path)', () => {
        const store = createStore();
        store.set(addPendingCreditConfirmationAtom, confirmationEvent());
        store.set(addPendingCreditConfirmationAtom, confirmationEvent({ confirmation_id: 'conf-2' }));

        store.set(removePendingCreditConfirmationAtom, 'conf-1');

        const map = store.get(pendingCreditConfirmationsAtom);
        expect(map.has('conf-1')).toBe(false);
        expect(map.has('conf-2')).toBe(true);
    });

    it('remove is a no-op for an unknown confirmationId', () => {
        const store = createStore();
        store.set(addPendingCreditConfirmationAtom, confirmationEvent());
        const before = store.get(pendingCreditConfirmationsAtom);

        store.set(removePendingCreditConfirmationAtom, 'conf-unknown');

        // Same Map reference — no state churn for a confirmation we never held.
        expect(store.get(pendingCreditConfirmationsAtom)).toBe(before);
    });

    it('clears all pending confirmations (run end / disconnect / thread switch)', () => {
        const store = createStore();
        store.set(addPendingCreditConfirmationAtom, confirmationEvent());
        store.set(addPendingCreditConfirmationAtom, confirmationEvent({ confirmation_id: 'conf-2' }));

        store.set(clearAllPendingCreditConfirmationsAtom);

        expect(store.get(pendingCreditConfirmationsAtom).size).toBe(0);
    });
});

describe('sendCreditConfirmationResponseAtom', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('sends the decision and retires the card', () => {
        const store = createStore();
        const send = vi
            .spyOn(agentService, 'sendCreditConfirmationResponse')
            .mockReturnValue(true);
        store.set(addPendingCreditConfirmationAtom, confirmationEvent());

        store.set(sendCreditConfirmationResponseAtom, {
            confirmationId: 'conf-1',
            approved: true,
        });

        expect(send).toHaveBeenCalledWith('conf-1', true, undefined);
        expect(store.get(pendingCreditConfirmationsAtom).has('conf-1')).toBe(false);
    });

    it('retires the card even when the decision never left the client', () => {
        // The run can no longer be told, so keeping the card up would strand the
        // user on an unanswerable prompt.
        const store = createStore();
        vi.spyOn(agentService, 'sendCreditConfirmationResponse').mockReturnValue(false);
        store.set(addPendingCreditConfirmationAtom, confirmationEvent());

        store.set(sendCreditConfirmationResponseAtom, {
            confirmationId: 'conf-1',
            approved: false,
        });

        expect(store.get(pendingCreditConfirmationsAtom).has('conf-1')).toBe(false);
    });
});
