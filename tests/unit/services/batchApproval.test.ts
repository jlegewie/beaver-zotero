/**
 * Batch approval: transport, pending state, and the host wiring around them.
 *
 * The backend asks once per batch — not per mutating tool call — before a
 * batch starts changing the library, and composes the card copy itself. These
 * tests pin the parts that keep a batch from hanging or from being covered
 * silently: the request has to reach the handler that owns the card, a client
 * with no such surface has to decline in a shape the backend can read, and a
 * decision has to leave the socket with the correlation id and coverage mode
 * the backend answers on.
 *
 * The host half is pinned here too: every way the decision can fail to arrive
 * has to retire the card instead of leaving it holding the composer, and Stop
 * has to abandon the run rather than answer for the user.
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
    WSBatchApprovalRequest,
    WSCallbacks,
    WSToolReturnEvent,
} from '@beaver/agent-core/protocol/agentProtocol';
import {
    addPendingBatchApprovalAtom,
    clearAllPendingBatchApprovalsAtom,
    pendingBatchApprovalsAtom,
    removePendingBatchApprovalAtom,
} from '@beaver/agent-core/run-state/pendingBatchApprovals';
import {
    clearThreadAtom,
    closeWSConnectionAtom,
    createWSCallbacks,
    prepareForNewRunAtom,
    sendBatchApprovalResponseAtom,
} from '../../../react/atoms/agentRunAtoms';
import { store } from '../../../react/store';

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
        title: 'Batch job',
        scope_primary: '184 items',
        scope_secondary: 'in Computational Social Science and its subcollections',
        message: 'Assign one broad topic tag to every item and remove all prior tags',
        destructive_warning: 'Removes every existing tag from these items',
        credit_chip: 'Asks again at 12 credits',
        credit_tooltip: 'Approving raises the confirmation limit for this thread to 12 credits.',
        default_mode: 'full_access',
        approve_label: 'Approve 184 items',
        decline_label: 'Cancel',
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

describe('pendingBatchApprovals atoms', () => {
    it('adds a pending approval keyed by approvalId', () => {
        const store = createStore();
        store.set(addPendingBatchApprovalAtom, approvalEvent());

        const map = store.get(pendingBatchApprovalsAtom);
        expect(map.size).toBe(1);
        expect(map.get('appr-1')).toMatchObject({
            approvalId: 'appr-1',
            runId: 'run-1',
            threadId: 'thread-1',
            toolcallId: 'call-1',
            batchId: 'b1',
            title: 'Batch job',
            scopePrimary: '184 items',
            scopeSecondary: 'in Computational Social Science and its subcollections',
            message: 'Assign one broad topic tag to every item and remove all prior tags',
            destructiveWarning: 'Removes every existing tag from these items',
            creditChip: 'Asks again at 12 credits',
            creditTooltip: 'Approving raises the confirmation limit for this thread to 12 credits.',
            defaultMode: 'full_access',
            approveLabel: 'Approve 184 items',
            declineLabel: 'Cancel',
            timeoutSeconds: 180,
        });
    });

    it('removes a pending approval by id (the stale-notice path)', () => {
        const store = createStore();
        store.set(addPendingBatchApprovalAtom, approvalEvent());
        store.set(addPendingBatchApprovalAtom, approvalEvent({ approval_id: 'appr-2' }));

        store.set(removePendingBatchApprovalAtom, 'appr-1');

        const map = store.get(pendingBatchApprovalsAtom);
        expect(map.has('appr-1')).toBe(false);
        expect(map.has('appr-2')).toBe(true);
    });

    it('remove is a no-op for an unknown approvalId', () => {
        const store = createStore();
        store.set(addPendingBatchApprovalAtom, approvalEvent());
        const before = store.get(pendingBatchApprovalsAtom);

        store.set(removePendingBatchApprovalAtom, 'appr-unknown');

        // Same Map reference — no state churn for an approval we never held.
        expect(store.get(pendingBatchApprovalsAtom)).toBe(before);
    });

    it('clears all pending approvals (run end / disconnect / thread switch)', () => {
        const store = createStore();
        store.set(addPendingBatchApprovalAtom, approvalEvent());
        store.set(addPendingBatchApprovalAtom, approvalEvent({ approval_id: 'appr-2' }));

        store.set(clearAllPendingBatchApprovalsAtom);

        expect(store.get(pendingBatchApprovalsAtom).size).toBe(0);
    });
});

describe('sendBatchApprovalResponseAtom', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('sends the decision and retires the card', () => {
        const store = createStore();
        const send = vi.spyOn(agentService, 'sendBatchApprovalResponse').mockReturnValue(true);
        store.set(addPendingBatchApprovalAtom, approvalEvent());

        store.set(sendBatchApprovalResponseAtom, {
            approvalId: 'appr-1',
            approved: true,
            mode: 'full_access',
            userInstructions: 'keep CD4/CD8',
        });

        expect(send).toHaveBeenCalledWith('appr-1', true, 'full_access', 'keep CD4/CD8');
        expect(store.get(pendingBatchApprovalsAtom).has('appr-1')).toBe(false);
    });

    it('retires the card even when the decision never left the client', () => {
        // The run can no longer be told, so keeping the card up would strand the
        // user on a card that can never be answered.
        const store = createStore();
        vi.spyOn(agentService, 'sendBatchApprovalResponse').mockReturnValue(false);
        store.set(addPendingBatchApprovalAtom, approvalEvent());

        store.set(sendBatchApprovalResponseAtom, {
            approvalId: 'appr-1',
            approved: false,
            mode: 'ask_each_time',
        });

        expect(store.get(pendingBatchApprovalsAtom).has('appr-1')).toBe(false);
    });
});

/** A tool return carrying a view the render layer accepts as-is. */
function toolReturnEvent(toolCallId: string): WSToolReturnEvent {
    return {
        event: 'tool_return',
        run_id: 'run-1',
        message_index: 0,
        part: {
            part_kind: 'tool-return',
            tool_name: 'batch_start',
            tool_call_id: toolCallId,
            content: {},
            metadata: { view: { view_type: 'tag_list', tags: [] } },
        },
    } as unknown as WSToolReturnEvent;
}

describe('batch approval WebSocket callbacks', () => {
    const callbacks = createWSCallbacks(store.set);

    beforeEach(() => {
        store.set(clearAllPendingBatchApprovalsAtom);
    });

    it('adds the pending approval on batch_approval_request', () => {
        callbacks.onBatchApprovalRequest?.(approvalEvent());

        expect(store.get(pendingBatchApprovalsAtom).get('appr-1')).toMatchObject({
            approvalId: 'appr-1',
            toolcallId: 'call-1',
        });
    });

    it('retires the pending approval on batch_approval_stale', () => {
        callbacks.onBatchApprovalRequest?.(approvalEvent());

        callbacks.onBatchApprovalStale?.({
            event: 'batch_approval_stale',
            approval_id: 'appr-1',
            reason: 'timed_out',
        });

        expect(store.get(pendingBatchApprovalsAtom).size).toBe(0);
    });

    it('retires the pending approval when the batch_start call that owns it returns', async () => {
        // The backend-timeout path: the wait expires, batch_start returns with
        // no coverage granted and the run continues. Without this the card
        // would hold the composer for the rest of the run.
        callbacks.onBatchApprovalRequest?.(approvalEvent());

        await callbacks.onToolReturn?.(toolReturnEvent('call-1'));

        expect(store.get(pendingBatchApprovalsAtom).size).toBe(0);
    });

    it('leaves the pending approval alone when an unrelated call returns', async () => {
        callbacks.onBatchApprovalRequest?.(approvalEvent());

        await callbacks.onToolReturn?.(toolReturnEvent('call-other'));

        expect(store.get(pendingBatchApprovalsAtom).has('appr-1')).toBe(true);
    });

    it('clears the pending approval when the run ends', () => {
        callbacks.onBatchApprovalRequest?.(approvalEvent());

        callbacks.onDone?.();

        expect(store.get(pendingBatchApprovalsAtom).size).toBe(0);
    });
});

describe('stopping a run with a batch approval pending', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('cancels the run instead of declining the batch', () => {
        // Stop is not a decline: the batch is never answered, the run is
        // abandoned, and the card goes with it.
        const send = vi.spyOn(agentService, 'sendBatchApprovalResponse');
        store.set(clearAllPendingBatchApprovalsAtom);
        store.set(addPendingBatchApprovalAtom, approvalEvent());

        store.set(closeWSConnectionAtom);

        expect(send).not.toHaveBeenCalled();
        expect(store.get(pendingBatchApprovalsAtom).size).toBe(0);
    });
});

describe('run-lifecycle clear sites', () => {
    beforeEach(() => {
        store.set(clearAllPendingBatchApprovalsAtom);
    });

    it('clears the pending approval before a replacement run starts', () => {
        store.set(addPendingBatchApprovalAtom, approvalEvent());

        store.set(prepareForNewRunAtom);

        expect(store.get(pendingBatchApprovalsAtom).size).toBe(0);
    });

    it('clears the pending approval on a thread reset', () => {
        store.set(addPendingBatchApprovalAtom, approvalEvent());

        store.set(clearThreadAtom);

        expect(store.get(pendingBatchApprovalsAtom).size).toBe(0);
    });
});
