/**
 * Recovering an approval decision the run never acted on.
 *
 * A deferred tool waits a bounded time for the user; when that expires the tool
 * returns `pending` and the run continues. A click that lands afterwards — or
 * one made while the socket is down — cannot reach the agent. Both cases used
 * to be indistinguishable from "still processing", which left the card spinning
 * on a reply that would never arrive.
 *
 * These tests cover the two signals that close that gap: the transport
 * reporting an undelivered send, and the backend's `deferred_approval_stale`.
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
import { AgentConnectionError, AgentService, agentService } from '@beaver/agent-core/transport/agentService';
import { isRetryablePreReadyConnectFailure } from '@beaver/agent-core/transport/connectionFailure';
import type {
    AgentRunRequest,
    WSCallbacks,
    WSDeferredApprovalStale,
} from '@beaver/agent-core/protocol/agentProtocol';
import {
    approvalResponseIntentsAtom,
    clearStaleApprovalsAtom,
    markApprovalStaleAtom,
    sendApprovalResponseAtom,
    staleApprovalActionIdsAtom,
} from '../../../react/atoms/agentRunAtoms';
import { shouldRecoverApproval } from '../../../react/host/zotero/components/useApprovalRecovery';

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

describe('approval response delivery', () => {
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

    it('reports a delivered approval response', async () => {
        const service = new AgentService('https://api.example.com');
        const socket = await completeConnect(service, createCallbacks());

        expect(service.sendApprovalResponse('action-1', true)).toBe(true);

        const sent = JSON.parse(socket.send.mock.calls.at(-1)![0] as string);
        expect(sent).toMatchObject({
            type: 'deferred_approval_response',
            action_id: 'action-1',
            approved: true,
        });
    });

    it('reports an approval response that never left the client', () => {
        // No connection at all: the decision cannot reach the run, and the
        // caller has to recover the card rather than wait for a reply.
        const service = new AgentService('https://api.example.com');

        expect(service.sendApprovalResponse('action-1', true)).toBe(false);
    });

    it('reports a send that throws on a socket that looks open', async () => {
        const service = new AgentService('https://api.example.com');
        const socket = await completeConnect(service, createCallbacks());
        socket.send.mockImplementationOnce(() => {
            throw new Error('InvalidStateError');
        });

        expect(service.sendApprovalResponse('action-1', true)).toBe(false);
    });

    it('fails the connect when the run request itself cannot be sent', async () => {
        // A half-open socket reports OPEN but refuses the write. Swallowing
        // that would leave the user waiting on a run the server never got.
        const service = new AgentService('https://api.example.com');
        const initialCount = MockWebSocket.instances.length;
        const connectPromise = service.connect(request, createCallbacks());
        for (let i = 0; i < 20 && MockWebSocket.instances.length === initialCount; i++) {
            await Promise.resolve();
        }
        const socket = MockWebSocket.instances[initialCount];
        socket.emitOpen();
        await vi.advanceTimersByTimeAsync(50);
        socket.send.mockImplementation(() => {
            throw new Error('InvalidStateError');
        });

        socket.emitMessage({
            event: 'ready',
            subscription_status: 'active',
            processing_mode: 'fast',
            indexing_complete: true,
        });

        const error = await connectPromise.catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AgentConnectionError);
        expect((error as AgentConnectionError).message).toMatch(/before the request could be sent/);
        // The socket must not be left live: `ready` already marked the
        // connection up, so nothing downstream would reclaim it.
        expect(socket.close).toHaveBeenCalled();
        // Flagged so the retry orchestrator treats it as retryable: nothing
        // reached the server, so a transient half-open socket must not cost
        // the user their run.
        expect((error as AgentConnectionError).evidence.requestNeverSent).toBe(true);
        expect(isRetryablePreReadyConnectFailure((error as AgentConnectionError).evidence)).toBe(true);
    });
});

describe('deferred_approval_stale transport', () => {
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

    it('dispatches the event to the registered handler', async () => {
        const service = new AgentService('https://api.example.com');
        const onDeferredApprovalStale = vi.fn();
        const socket = await completeConnect(
            service,
            createCallbacks({ onDeferredApprovalStale }),
        );

        const event: WSDeferredApprovalStale = {
            event: 'deferred_approval_stale',
            action_id: 'action-1',
            reason: 'timed_out',
        };
        socket.emitMessage(event);
        await vi.advanceTimersByTimeAsync(0);

        expect(onDeferredApprovalStale).toHaveBeenCalledWith(
            expect.objectContaining({ action_id: 'action-1', reason: 'timed_out' }),
        );
    });

    it('degrades quietly on a client that does not implement recovery', async () => {
        // Not a test of the dispatch itself (an unhandled event is also a
        // no-op) — it pins the contract that a client without the handler is
        // left working rather than answering a notice that expects no reply.
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks();
        delete (callbacks as Partial<WSCallbacks>).onDeferredApprovalStale;
        const socket = await completeConnect(service, callbacks);
        const sendCountBefore = socket.send.mock.calls.length;

        socket.emitMessage({
            event: 'deferred_approval_stale',
            action_id: 'action-1',
            reason: 'unknown',
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(socket.send.mock.calls.length).toBe(sendCountBefore);
        expect(callbacks.onError).not.toHaveBeenCalled();
    });
});

describe('shouldRecoverApproval', () => {
    const live = {
        isStale: false,
        hasToolReturn: false,
        actionStatus: 'pending' as const,
        decisionWasReject: false,
        isRunPending: true,
    };

    it('waits while the decision is still in play', () => {
        expect(shouldRecoverApproval(live)).toBe(false);
    });

    it('recovers once the backend reports the channel closed', () => {
        expect(shouldRecoverApproval({ ...live, isStale: true })).toBe(true);
    });

    it('recovers when the tool returned with the action still pending', () => {
        // What a backend-side approval timeout looks like on the wire.
        expect(shouldRecoverApproval({ ...live, hasToolReturn: true })).toBe(true);
    });

    it('does not recover when the tool returned having settled the action', () => {
        expect(
            shouldRecoverApproval({ ...live, hasToolReturn: true, actionStatus: 'applied' }),
        ).toBe(false);
    });

    it('NEVER abandons an approval just because the run stopped', () => {
        // The load-bearing invariant. An approved action is executed by this
        // client on the backend's request, and only turns `applied` locally
        // when the follow-up frame lands — so cancelling mid-execution looks
        // identical to a decision that never arrived. Restoring Apply here
        // would offer to repeat a change already being made.
        expect(shouldRecoverApproval({ ...live, isRunPending: false })).toBe(false);
    });

    it('abandons a rejection when the run stops, which executes nothing', () => {
        expect(
            shouldRecoverApproval({ ...live, isRunPending: false, decisionWasReject: true }),
        ).toBe(true);
    });

    it('still recovers an approval on a positive signal after the run stops', () => {
        expect(
            shouldRecoverApproval({ ...live, isRunPending: false, isStale: true }),
        ).toBe(true);
    });

    it('recovers a decision made from another surface on the same signals', () => {
        // Approve All, the composer and the diff-preview banner respond on a
        // card's behalf; the card is left waiting just the same, so the
        // predicate must not depend on who clicked.
        expect(shouldRecoverApproval({ ...live, isStale: true })).toBe(true);
        expect(shouldRecoverApproval({ ...live, hasToolReturn: true })).toBe(true);
    });
});

describe('sendApprovalResponseAtom delivery handling', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('marks the approval stale when the decision never left the client', () => {
        // The backend cannot answer a message it never received, so the card
        // has to be told to recover rather than wait for a reply.
        const store = createStore();
        vi.spyOn(agentService, 'sendApprovalResponse').mockReturnValue(false);

        store.set(sendApprovalResponseAtom, { actionId: 'action-1', approved: true });

        expect(store.get(staleApprovalActionIdsAtom).has('action-1')).toBe(true);
    });

    it('leaves a delivered approval alone so the run can resolve it', () => {
        const store = createStore();
        vi.spyOn(agentService, 'sendApprovalResponse').mockReturnValue(true);

        store.set(sendApprovalResponseAtom, { actionId: 'action-1', approved: true });

        expect(store.get(staleApprovalActionIdsAtom).has('action-1')).toBe(false);
        expect(store.get(approvalResponseIntentsAtom).get('action-1')).toBe(true);
    });
});

describe('stale approval state', () => {
    it('accumulates stale action ids', () => {
        const store = createStore();

        store.set(markApprovalStaleAtom, 'action-1');
        store.set(markApprovalStaleAtom, 'action-2');

        expect(store.get(staleApprovalActionIdsAtom)).toEqual(
            new Set(['action-1', 'action-2']),
        );
    });

    it('keeps the same set when re-marking an id, so views do not re-render', () => {
        const store = createStore();
        store.set(markApprovalStaleAtom, 'action-1');
        const before = store.get(staleApprovalActionIdsAtom);

        store.set(markApprovalStaleAtom, 'action-1');

        expect(store.get(staleApprovalActionIdsAtom)).toBe(before);
    });

    it('clears the set when a new run starts', () => {
        const store = createStore();
        store.set(markApprovalStaleAtom, 'action-1');

        store.set(clearStaleApprovalsAtom);

        expect(store.get(staleApprovalActionIdsAtom).size).toBe(0);
    });
});
