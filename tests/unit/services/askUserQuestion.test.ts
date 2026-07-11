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
    handleResolveSearchFiltersRequest: vi.fn(),
    handleAgentActionValidateRequest: vi.fn(),
    handleAgentActionExecuteRequest: vi.fn(),
    handleReadNoteRequest: vi.fn(),
}));

import { createStore } from 'jotai';
import { AgentService } from '../../../src/services/agentService';
import type {
    AgentRunRequest,
    WSAskUserQuestionRequest,
    WSCallbacks,
} from '../../../src/services/agentProtocol';
import {
    addPendingQuestionAtom,
    clearAllPendingQuestionsAtom,
    pendingQuestionsAtom,
    removePendingQuestionAtom,
} from '../../../react/agents/pendingQuestions';

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
        onOpen: vi.fn(),
        onClose: vi.fn(),
        ...overrides,
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

function questionEvent(overrides: Partial<WSAskUserQuestionRequest> = {}): WSAskUserQuestionRequest {
    return {
        event: 'ask_user_question_request',
        question_id: 'qid-1',
        toolcall_id: 'call-1',
        title: 'Scope',
        questions: [
            {
                id: 'q0',
                question: 'Which topic?',
                options: [
                    { id: 'q0-o0', label: 'Alpha' },
                    { id: 'q0-o1', label: 'Beta' },
                ],
                allow_multiple: false,
                allow_custom: true,
            },
        ],
        ...overrides,
    };
}

describe('AgentService ask_user_question transport', () => {
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

    it('dispatches ask_user_question_request to the registered handler', async () => {
        const service = new AgentService('https://api.example.com');
        const onAskUserQuestionRequest = vi.fn();
        const callbacks = createCallbacks({ onAskUserQuestionRequest });
        const socket = await completeConnect(service, callbacks, { type: 'q' } as AgentRunRequest);

        const event = questionEvent();
        socket.emitMessage(event);
        await flushMicrotasks();

        expect(onAskUserQuestionRequest).toHaveBeenCalledTimes(1);
        expect(onAskUserQuestionRequest).toHaveBeenCalledWith(event);
        // No response is auto-sent when a handler owns the card
        const responses = socket.sentMessages().filter(
            (m) => m.type === 'ask_user_question_response',
        );
        expect(responses).toHaveLength(0);
    });

    it('auto-cancels ask_user_question_request when no handler is registered', async () => {
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks();
        delete (callbacks as Partial<WSCallbacks>).onAskUserQuestionRequest;
        const socket = await completeConnect(service, callbacks, { type: 'q' } as AgentRunRequest);

        socket.emitMessage(questionEvent());
        await flushMicrotasks();

        const responses = socket.sentMessages().filter(
            (m) => m.type === 'ask_user_question_response',
        );
        expect(responses).toHaveLength(1);
        expect(responses[0]).toMatchObject({
            question_id: 'qid-1',
            answers: [],
            cancelled: true,
        });
    });

    it('sendAskUserQuestionResponse sends answers with the correlation id', async () => {
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks({ onAskUserQuestionRequest: vi.fn() });
        const socket = await completeConnect(service, callbacks, { type: 'q' } as AgentRunRequest);

        service.sendAskUserQuestionResponse('qid-1', [
            { item_id: 'q0', selected_option_ids: ['q0-o1'], custom_text: null },
        ]);

        const responses = socket.sentMessages().filter(
            (m) => m.type === 'ask_user_question_response',
        );
        expect(responses).toHaveLength(1);
        expect(responses[0]).toMatchObject({
            question_id: 'qid-1',
            answers: [{ item_id: 'q0', selected_option_ids: ['q0-o1'] }],
            cancelled: false,
        });
    });

    it('sendAskUserQuestionResponse sends a skip as cancelled with no answers', async () => {
        const service = new AgentService('https://api.example.com');
        const callbacks = createCallbacks({ onAskUserQuestionRequest: vi.fn() });
        const socket = await completeConnect(service, callbacks, { type: 'q' } as AgentRunRequest);

        service.sendAskUserQuestionResponse('qid-1', [], true);

        const responses = socket.sentMessages().filter(
            (m) => m.type === 'ask_user_question_response',
        );
        expect(responses).toHaveLength(1);
        expect(responses[0]).toMatchObject({
            question_id: 'qid-1',
            answers: [],
            cancelled: true,
        });
    });
});

describe('pendingQuestions atoms', () => {
    it('adds a pending question keyed by toolcallId', () => {
        const store = createStore();
        store.set(addPendingQuestionAtom, questionEvent());

        const map = store.get(pendingQuestionsAtom);
        expect(map.size).toBe(1);
        const pending = map.get('call-1');
        expect(pending).toMatchObject({
            questionId: 'qid-1',
            toolcallId: 'call-1',
            title: 'Scope',
        });
        expect(pending?.questions).toHaveLength(1);
        expect(map.get('other-call')).toBeUndefined();
    });

    it('removes a pending question by toolcallId (the tool-return path)', () => {
        const store = createStore();
        store.set(addPendingQuestionAtom, questionEvent());
        store.set(addPendingQuestionAtom, questionEvent({
            question_id: 'qid-2',
            toolcall_id: 'call-2',
        }));

        store.set(removePendingQuestionAtom, 'call-1');

        const map = store.get(pendingQuestionsAtom);
        expect(map.has('call-1')).toBe(false);
        expect(map.has('call-2')).toBe(true);
    });

    it('remove is a no-op for an unknown toolcallId (backend-timeout after user answered)', () => {
        const store = createStore();
        store.set(addPendingQuestionAtom, questionEvent());
        const before = store.get(pendingQuestionsAtom);

        store.set(removePendingQuestionAtom, 'unknown-call');

        // Same Map reference — no state churn for unrelated tool returns
        expect(store.get(pendingQuestionsAtom)).toBe(before);
    });

    it('clears all pending questions (run complete / disconnect / thread switch)', () => {
        const store = createStore();
        store.set(addPendingQuestionAtom, questionEvent());
        store.set(addPendingQuestionAtom, questionEvent({
            question_id: 'qid-2',
            toolcall_id: 'call-2',
        }));

        store.set(clearAllPendingQuestionsAtom);

        expect(store.get(pendingQuestionsAtom).size).toBe(0);
    });
});
