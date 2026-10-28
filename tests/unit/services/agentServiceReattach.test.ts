/**
 * Picking a run back up after its socket was lost.
 *
 * A backend that advertises `supports_run_reattach` keeps a run going when its
 * socket drops abnormally. The client opens a new socket, sends `reattach`, and
 * the server replays the events it missed and re-sends every request and prompt
 * still waiting on it, with their original ids. These tests drive the real
 * `AgentService` and the real reattach loop against scripted sockets and check
 * what the run's callbacks and the server see: every event handled once, no
 * request run twice, no prompt shown twice, and the run ending as it always has
 * whenever the reattach cannot happen.
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

import {
    AgentService,
    CONNECT_TIMEOUT_MS,
    REACHABILITY_PROBE_TIMEOUT_MS,
    REATTACH_OPEN_TIMEOUT_MS,
} from '@beaver/agent-core/transport/agentService';
import { reattachWithRetry } from '@beaver/agent-core/transport/connectWithRetry';
import { setClientIdentityProvider } from '@beaver/agent-core/transport/clientIdentity';
import type { AgentDataProviderMap } from '@beaver/agent-core/transport/agentDataDispatch';
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

/** Run the reattach loop the way the client does, up to the server's `ready`. */
async function reattach(
    service: AgentService,
    ready: Record<string, unknown> = READY_WITH_REATTACH,
): Promise<{ socket: MockWebSocket; loop: Promise<'connected' | 'stopped'> }> {
    const loop = reattachWithRetry({
        service,
        runId: RUN_ID,
        isStillWanted: () => true,
        sleep: () => Promise.resolve(),
    });
    const socket = await acceptNextSocket(ready);
    return { socket, loop };
}

function part(seq: number, text: string): Record<string, unknown> {
    return {
        event: 'part',
        run_id: RUN_ID,
        message_index: 0,
        part_index: 0,
        part: { part_kind: 'text', content: text },
        seq,
    };
}

describe('AgentService run reattach', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        MockWebSocket.instances = [];
        vi.stubGlobal('WebSocket', MockWebSocket);
        // The reattach loop probes the server between attempts.
        vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
        setClientIdentityProvider(() => ({
            frontendVersion: '0.99.0',
            clientType: 'zotero-plugin',
            clientFeatures: ['run_reattach'],
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

    it('picks a streaming run up on a new socket and handles every event once', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);

        first.emitMessage(part(2, 'Hello'));
        first.emitMessage({
            event: 'tool_return',
            run_id: RUN_ID,
            message_index: 1,
            part: { part_kind: 'tool-return', tool_call_id: 'call-1', tool_name: 'search' },
            seq: 3,
        });
        await flush();

        // The heartbeat tells the server how far the client got.
        await vi.advanceTimersByTimeAsync(15_000);
        expect(first.sentOfType('ping').at(-1)).toEqual({ type: 'ping', last_seq: 3 });

        first.emitClose(1006);

        // The loss is not the end of the run.
        expect(callbacks.onClose).not.toHaveBeenCalled();
        expect(callbacks.onReattaching).toHaveBeenCalledWith(
            expect.objectContaining({ runId: RUN_ID, cancelRequested: false, graceMs: expect.any(Number), detachedAt: expect.any(Number) }),
        );
        expect(service.isReattaching(RUN_ID)).toBe(true);

        const { socket: second, loop } = await reattach(service);
        await expect(loop).resolves.toBe('connected');
        expect(second.sentOfType('reattach')).toEqual([
            { type: 'reattach', run_id: RUN_ID, reattach_token: TOKEN, last_seq: 3 },
        ]);

        second.emitMessage({ event: 'reattached', run_id: RUN_ID, last_seq: 6, replayed: 3 });
        // The server replays from the client's last_seq; an event that crossed
        // with the reattach is ignored all the same.
        second.emitMessage({
            event: 'tool_return',
            run_id: RUN_ID,
            message_index: 1,
            part: { part_kind: 'tool-return', tool_call_id: 'call-1', tool_name: 'search' },
            seq: 3,
        });
        second.emitMessage(part(4, 'Hello world'));
        second.emitMessage({ event: 'run_complete', run_id: RUN_ID, usage: null, cost: null, citations: null, agent_actions: null, seq: 5 });
        second.emitMessage({ event: 'run_citations', run_id: RUN_ID, citations: [], seq: 6 });
        second.emitMessage({ event: 'run_citations', run_id: RUN_ID, citations: [], seq: 6 });
        second.emitMessage({ event: 'done', seq: 7 });
        await flush();

        expect(callbacks.onReattached).toHaveBeenCalledWith(
            expect.objectContaining({ runId: RUN_ID, replayed: 3 }),
        );
        expect(callbacks.onPart).toHaveBeenCalledTimes(2);
        expect(callbacks.onToolReturn).toHaveBeenCalledTimes(1);
        expect(callbacks.onRunComplete).toHaveBeenCalledTimes(1);
        expect(callbacks.onRunCitations).toHaveBeenCalledTimes(1);
        expect(callbacks.onDone).toHaveBeenCalledTimes(1);
        expect(callbacks.onReattachFailed).not.toHaveBeenCalled();
        expect(callbacks.onClose).not.toHaveBeenCalled();
    });

    it('answers a re-sent action from memory instead of applying it again', async () => {
        let finishExecute!: (value: Record<string, unknown>) => void;
        const execute = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => { finishExecute = resolve; }));
        const provider: AgentDataProviderMap = {
            agent_action_execute: {
                handle: execute,
                errorResponse: () => ({ type: 'agent_action_execute', error: 'failed' }),
                serialize: true,
            },
        };
        const service = new AgentService('https://api.example.com', provider);
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);

        first.emitMessage({ event: 'agent_action_execute', request_id: 'req-exec', action_id: 'a1' });
        await flush();
        expect(execute).toHaveBeenCalledTimes(1);

        // The socket drops while the action is still being applied, and the
        // action finishes during the gap, with nowhere to send its result.
        first.emitClose(1006);
        finishExecute({ type: 'agent_action_execute', request_id: 'req-exec', status: 'applied' });
        await flush();
        expect(first.sentOfType('agent_action_execute')).toHaveLength(0);

        const { socket: second } = await reattach(service);
        second.emitMessage({ event: 'reattached', run_id: RUN_ID, last_seq: 1, replayed: 0 });
        // The server never saw the result, so it asks again with the same id.
        second.emitMessage({ event: 'agent_action_execute', request_id: 'req-exec', action_id: 'a1' });
        await flush();
        // And a duplicate of that re-send changes nothing either.
        second.emitMessage({ event: 'agent_action_execute', request_id: 'req-exec', action_id: 'a1' });
        await flush();

        expect(execute).toHaveBeenCalledTimes(1);
        const replies = second.sentOfType('agent_action_execute');
        expect(replies).toHaveLength(1);
        expect(replies[0]).toMatchObject({ request_id: 'req-exec', status: 'applied' });
    });

    it('sends the result of an action still running at the reattach once, on the new socket', async () => {
        let finishExecute!: (value: Record<string, unknown>) => void;
        const execute = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => { finishExecute = resolve; }));
        const service = new AgentService('https://api.example.com', {
            agent_action_execute: {
                handle: execute,
                errorResponse: () => ({ type: 'agent_action_execute', error: 'failed' }),
                serialize: true,
            },
        });
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);
        first.emitMessage({ event: 'agent_action_execute', request_id: 'req-exec', action_id: 'a1' });
        await flush();

        first.emitClose(1006);
        const { socket: second } = await reattach(service);
        second.emitMessage({ event: 'reattached', run_id: RUN_ID, last_seq: 1, replayed: 0 });
        second.emitMessage({ event: 'agent_action_execute', request_id: 'req-exec', action_id: 'a1' });
        await flush();
        expect(second.sentOfType('agent_action_execute')).toHaveLength(0);

        finishExecute({ type: 'agent_action_execute', request_id: 'req-exec', status: 'applied' });
        await flush();

        expect(execute).toHaveBeenCalledTimes(1);
        expect(second.sentOfType('agent_action_execute')).toHaveLength(1);
    });

    it('keeps an approval card through the drop and delivers the answer given meanwhile', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);
        const approval = {
            event: 'deferred_approval_request',
            action_id: 'action-1',
            toolcall_id: 'call-1',
            action_type: 'edit_metadata',
            action_data: {},
        };
        first.emitMessage(approval);
        await flush();
        expect(callbacks.onDeferredApprovalRequest).toHaveBeenCalledTimes(1);

        first.emitClose(1006);
        expect(service.isApprovalAnswerHeld('action-1')).toBe(false);
        // The user answers while there is no socket: held, not lost.
        expect(service.sendApprovalResponse('action-1', true)).toBe(true);
        expect(service.isApprovalAnswerHeld('action-1')).toBe(true);

        const { socket: second } = await reattach(service);
        // Nothing goes out before the server confirms the run is carried here.
        expect(second.sentOfType('deferred_approval_response')).toHaveLength(0);

        second.emitMessage({ event: 'reattached', run_id: RUN_ID, last_seq: 1, replayed: 0 });
        second.emitMessage(approval);
        await flush();

        expect(second.sentOfType('deferred_approval_response')).toEqual([
            expect.objectContaining({ action_id: 'action-1', approved: true }),
        ]);
        expect(service.isApprovalAnswerHeld('action-1')).toBe(false);
        // The re-sent prompt is not shown a second time.
        expect(callbacks.onDeferredApprovalRequest).toHaveBeenCalledTimes(1);
    });

    it('does not count an answer sent before the drop as held', async () => {
        const service = new AgentService('https://api.example.com', {});
        const first = await startRun(service, createCallbacks());
        first.emitMessage({
            event: 'deferred_approval_request',
            action_id: 'action-1',
            toolcall_id: 'call-1',
            action_type: 'edit_metadata',
            action_data: {},
        });
        await flush();
        expect(service.sendApprovalResponse('action-1', true)).toBe(true);

        first.emitClose(1006);

        expect(service.isReattaching(RUN_ID)).toBe(true);
        expect(service.isApprovalAnswerHeld('action-1')).toBe(false);
    });

    it('keeps a decision the dying socket refused and delivers it once after the reattach', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);
        const approval = {
            event: 'deferred_approval_request',
            action_id: 'action-1',
            toolcall_id: 'call-1',
            action_type: 'edit_metadata',
            action_data: {},
        };
        first.emitMessage(approval);
        await flush();

        // The socket is already closing, but its close event has not arrived.
        first.readyState = MockWebSocket.CLOSING;
        expect(service.sendApprovalResponse('action-1', true)).toBe(true);
        first.emitClose(1006);

        const { socket: second } = await reattach(service);
        second.emitMessage({ event: 'reattached', run_id: RUN_ID, last_seq: 1, replayed: 0 });
        second.emitMessage(approval);
        await flush();

        expect(second.sentOfType('deferred_approval_response')).toHaveLength(1);
    });

    it('never replays a decision it reported as undelivered', async () => {
        const service = new AgentService('https://api.example.com', {});
        // A client that cannot reattach owns no decision it failed to send.
        const callbacks = createCallbacks({ onReattaching: undefined });
        const first = await startRun(service, callbacks);
        first.emitMessage({
            event: 'deferred_approval_request',
            action_id: 'action-1',
            toolcall_id: 'call-1',
            action_type: 'edit_metadata',
            action_data: {},
        });
        await flush();

        first.readyState = MockWebSocket.CLOSING;
        expect(service.sendApprovalResponse('action-1', true)).toBe(false);
        expect((service as any).run.notePrompt('deferred_approval_request:action-1')?.answer).toBeNull();
    });

    it('re-sends an answer the lost socket swallowed when the server asks again', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);
        const question = {
            event: 'ask_user_question_request',
            question_id: 'q-1',
            toolcall_id: 'call-q',
            questions: [],
        };
        first.emitMessage(question);
        await flush();
        service.sendAskUserQuestionResponse('q-1', [], true);
        expect(first.sentOfType('ask_user_question_response')).toHaveLength(1);

        first.emitClose(1006);
        const { socket: second } = await reattach(service);
        second.emitMessage({ event: 'reattached', run_id: RUN_ID, last_seq: 1, replayed: 0 });
        second.emitMessage(question);
        await flush();

        expect(callbacks.onAskUserQuestionRequest).toHaveBeenCalledTimes(1);
        expect(second.sentOfType('ask_user_question_response')).toEqual([
            expect.objectContaining({ question_id: 'q-1', cancelled: true }),
        ]);
    });

    it('falls back to the usual error when the server cannot reattach the run', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);
        first.emitClose(1006);

        const { socket: second } = await reattach(service);
        second.emitMessage({ event: 'reattach_unavailable', run_id: RUN_ID, reason: 'expired' });
        await flush();

        expect(callbacks.onReattachFailed).toHaveBeenCalledWith(
            expect.objectContaining({
                runId: RUN_ID,
                reason: 'expired',
                evidence: expect.objectContaining({ stage: 'mid_run', closeCode: 1006 }),
                attempts: 1,
                losses: 1,
            }),
        );
        expect(second.close).toHaveBeenCalledWith(1000, 'Reattach failed');
        expect(service.isReattaching(RUN_ID)).toBe(false);
        expect(callbacks.onClose).not.toHaveBeenCalled();
    });

    it('gives up when the grace period runs out without a reattach', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);
        first.emitClose(1006);

        await vi.advanceTimersByTimeAsync(120_000);

        expect(callbacks.onReattachFailed).toHaveBeenCalledWith(
            expect.objectContaining({ reason: 'gave_up' }),
        );
        expect(service.isReattaching(RUN_ID)).toBe(false);
    });

    it('delivers a stop pressed while reconnecting once the run is reattached', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);
        first.emitClose(1006);

        await service.cancel();
        // Still waiting to reach the server with it.
        expect(service.isReattaching(RUN_ID)).toBe(true);

        const { socket: second } = await reattach(service);
        expect(second.sentOfType('cancel')).toHaveLength(0);
        second.emitMessage({ event: 'reattached', run_id: RUN_ID, last_seq: 1, replayed: 0 });
        await flush();

        expect(second.sentOfType('cancel')).toHaveLength(1);
        // The recovered connection is still reported.
        expect(callbacks.onReattached).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(250);
        expect(second.close).toHaveBeenCalledWith(1000, 'User cancelled');
    });

    function serializedExecute() {
        const finishes: Array<(value: Record<string, unknown>) => void> = [];
        const execute = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => { finishes.push(resolve); }));
        const provider: AgentDataProviderMap = {
            agent_action_execute: {
                handle: execute,
                errorResponse: () => ({ type: 'agent_action_execute', error: 'failed' }),
                serialize: true,
            },
        };
        return { execute, finishes, provider };
    }

    function applied(requestId: string, resultData: Record<string, unknown> = {}): Record<string, unknown> {
        return { type: 'agent_action_execute_response', request_id: requestId, success: true, result_data: resultData };
    }

    describe('actions applied whose results the server never read', () => {
        it('reports an action applied just before the drop when the reattach is refused', async () => {
            const { finishes, provider } = serializedExecute();
            const service = new AgentService('https://api.example.com', provider);
            const callbacks = createCallbacks({ onUndeliveredActions: vi.fn() });
            const first = await startRun(service, callbacks);
            first.emitMessage({
                event: 'agent_action_execute',
                request_id: 'req-1',
                action_id: 'a1',
                action_type: 'create_collection',
                action_data: { name: 'Reading' },
                toolcall_id: 'call-1',
            });
            await flush();
            first.emitClose(1006);
            finishes[0](applied('req-1', { collection_key: 'ABCD1234' }));
            await flush();

            const { socket: second } = await reattach(service);
            second.emitMessage({ event: 'reattach_unavailable', run_id: RUN_ID, reason: 'bad_token' });
            await flush();

            expect(callbacks.onReattachFailed).toHaveBeenCalled();
            expect(callbacks.onUndeliveredActions).toHaveBeenCalledWith({
                runId: RUN_ID,
                actions: [{
                    actionId: 'a1',
                    resultData: { collection_key: 'ABCD1234' },
                    // What the client needs to show an action it never received.
                    executed: {
                        actionId: 'a1',
                        actionType: 'create_collection',
                        actionData: { name: 'Reading' },
                        toolcallId: 'call-1',
                    },
                }],
            });
        });

        it('waits for an action still being applied when the run is given up', async () => {
            const { finishes, provider } = serializedExecute();
            const service = new AgentService('https://api.example.com', provider);
            const callbacks = createCallbacks({ onUndeliveredActions: vi.fn() });
            const first = await startRun(service, callbacks);
            first.emitMessage({ event: 'agent_action_execute', request_id: 'req-1', action_id: 'a1' });
            await flush();
            first.emitClose(1006);
            await vi.advanceTimersByTimeAsync(120_000);
            expect(callbacks.onReattachFailed).toHaveBeenCalledWith(expect.objectContaining({ reason: 'gave_up' }));
            expect(callbacks.onUndeliveredActions).not.toHaveBeenCalled();

            finishes[0](applied('req-1'));
            await flush();

            expect(callbacks.onUndeliveredActions).toHaveBeenCalledWith({
                runId: RUN_ID,
                actions: [{ actionId: 'a1', resultData: {}, executed: expect.objectContaining({ actionId: 'a1' }) }],
            });
        });

        it('reports an applied action of a run the user left while it reconnected', async () => {
            const { finishes, provider } = serializedExecute();
            const service = new AgentService('https://api.example.com', provider);
            const callbacks = createCallbacks({ onUndeliveredActions: vi.fn() });
            const first = await startRun(service, callbacks);
            first.emitMessage({ event: 'agent_action_execute', request_id: 'req-1', action_id: 'a1' });
            await flush();
            first.emitClose(1006);
            finishes[0](applied('req-1'));
            await flush();

            expect(service.leaveRun(RUN_ID)).toBe(true);
            await flush();

            expect(callbacks.onUndeliveredActions).toHaveBeenCalledWith({
                runId: RUN_ID,
                actions: [{ actionId: 'a1', resultData: {}, executed: expect.objectContaining({ actionId: 'a1' }) }],
            });
        });

        it('reports the applied action without waiting on one queued behind it that never ran', async () => {
            const { execute, finishes, provider } = serializedExecute();
            const service = new AgentService('https://api.example.com', provider);
            const callbacks = createCallbacks({ onUndeliveredActions: vi.fn() });
            const first = await startRun(service, callbacks);
            first.emitMessage({ event: 'agent_action_execute', request_id: 'req-1', action_id: 'a1' });
            first.emitMessage({ event: 'agent_action_execute', request_id: 'req-2', action_id: 'a2' });
            await flush();
            first.emitClose(1006);
            const { socket: second } = await reattach(service);
            second.emitMessage({ event: 'reattach_unavailable', run_id: RUN_ID, reason: 'bad_token' });
            await flush();

            finishes[0](applied('req-1'));
            await flush();

            expect(execute).toHaveBeenCalledTimes(1);
            expect(callbacks.onUndeliveredActions).toHaveBeenCalledWith({
                runId: RUN_ID,
                actions: [{ actionId: 'a1', resultData: {}, executed: expect.objectContaining({ actionId: 'a1' }) }],
            });
        });

        it('reports an applied action when the socket opened to reattach fails with an error', async () => {
            const { finishes, provider } = serializedExecute();
            const service = new AgentService('https://api.example.com', provider);
            const callbacks = createCallbacks({ onUndeliveredActions: vi.fn() });
            const first = await startRun(service, callbacks);
            first.emitMessage({ event: 'agent_action_execute', request_id: 'req-1', action_id: 'a1' });
            await flush();
            first.emitClose(1006);
            finishes[0](applied('req-1'));
            await flush();

            const { socket: second } = await reattach(service);
            second.emitMessage({ event: 'error', type: 'auth_failed', message: 'Authentication failed' });
            await flush();

            expect(callbacks.onUndeliveredActions).toHaveBeenCalledWith({
                runId: RUN_ID,
                actions: [{ actionId: 'a1', resultData: {}, executed: expect.objectContaining({ actionId: 'a1' }) }],
            });
        });

        it('does not report an applied action when the client closes on purpose', async () => {
            const { finishes, provider } = serializedExecute();
            const service = new AgentService('https://api.example.com', provider);
            const callbacks = createCallbacks({ onUndeliveredActions: vi.fn() });
            const first = await startRun(service, callbacks);
            first.emitMessage({ event: 'agent_action_execute', request_id: 'req-1', action_id: 'a1' });
            await flush();
            first.emitClose(1006);
            finishes[0](applied('req-1'));
            await flush();

            // E.g. sign-out or a library exclusion.
            service.close();
            await flush();

            expect(callbacks.onUndeliveredActions).not.toHaveBeenCalled();
        });

        it('does not report an action whose result the server confirmed', async () => {
            const { finishes, provider } = serializedExecute();
            const service = new AgentService('https://api.example.com', provider);
            const callbacks = createCallbacks({ onUndeliveredActions: vi.fn() });
            const first = await startRun(service, callbacks);
            first.emitMessage({ event: 'agent_action_execute', request_id: 'req-1', action_id: 'a1' });
            await flush();
            finishes[0](applied('req-1'));
            await flush();
            expect(first.sentOfType('agent_action_execute_response')).toHaveLength(1);
            // A pong after the reply was written: the server has read it.
            await vi.advanceTimersByTimeAsync(15_000);
            first.emitMessage({ event: 'pong' });
            await flush();

            first.emitClose(1006);
            const { socket: second } = await reattach(service);
            second.emitMessage({ event: 'reattach_unavailable', run_id: RUN_ID, reason: 'bad_token' });
            await flush();

            expect(callbacks.onReattachFailed).toHaveBeenCalled();
            expect(callbacks.onUndeliveredActions).not.toHaveBeenCalled();
        });

        it('does not report an action that failed or a run that finished', async () => {
            const { finishes, provider } = serializedExecute();
            const service = new AgentService('https://api.example.com', provider);
            const callbacks = createCallbacks({ onUndeliveredActions: vi.fn() });
            const first = await startRun(service, callbacks);
            first.emitMessage({ event: 'agent_action_execute', request_id: 'req-1', action_id: 'a1' });
            first.emitMessage({ event: 'agent_action_execute', request_id: 'req-2', action_id: 'a2' });
            await flush();
            finishes[0]({ type: 'agent_action_execute_response', request_id: 'req-1', success: false });
            await flush();
            finishes[1](applied('req-2'));
            first.emitMessage({ event: 'done', seq: 2 });
            await flush();

            service.close();
            await flush();

            expect(callbacks.onDone).toHaveBeenCalled();
            expect(callbacks.onUndeliveredActions).not.toHaveBeenCalled();
        });
    });

    it('runs no queued action once the socket closes for good', async () => {
        const { execute, finishes, provider } = serializedExecute();
        const service = new AgentService('https://api.example.com', provider);
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);
        first.emitMessage({ event: 'agent_action_execute', request_id: 'req-1', action_id: 'a1' });
        first.emitMessage({ event: 'agent_action_execute', request_id: 'req-2', action_id: 'a2' });
        await flush();
        expect(execute).toHaveBeenCalledTimes(1);

        // A normal close ends the run while the first action is still running.
        first.emitClose(1000);
        finishes[0]({ type: 'agent_action_execute', request_id: 'req-1', status: 'applied' });
        await flush();

        expect(callbacks.onClose).toHaveBeenCalledTimes(1);
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it('runs no queued action after Stop while reconnecting', async () => {
        const { execute, finishes, provider } = serializedExecute();
        const service = new AgentService('https://api.example.com', provider);
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);
        first.emitMessage({ event: 'agent_action_execute', request_id: 'req-1', action_id: 'a1' });
        first.emitMessage({ event: 'agent_action_execute', request_id: 'req-2', action_id: 'a2' });
        await flush();

        first.emitClose(1006);
        await service.cancel();
        finishes[0]({ type: 'agent_action_execute', request_id: 'req-1', status: 'applied' });
        await flush();

        // The run is still being reattached to deliver the cancel, but the
        // action queued behind the first never starts.
        expect(service.isReattaching(RUN_ID)).toBe(true);
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it('never runs a request again whose confirmed reply was dropped while its re-send waited', async () => {
        const { execute, finishes, provider } = serializedExecute();
        const service = new AgentService('https://api.example.com', provider);
        let releasePart!: () => void;
        const callbacks = createCallbacks({
            onPart: vi.fn(() => new Promise<void>((resolve) => { releasePart = resolve; })),
        });
        const first = await startRun(service, callbacks);
        first.emitMessage({ event: 'agent_action_execute', request_id: 'req-1', action_id: 'a1' });
        await flush();
        first.emitClose(1006);

        const { socket: second } = await reattach(service);
        second.emitMessage({ event: 'reattached', run_id: RUN_ID, last_seq: 1, replayed: 1 });
        // A replayed part blocks the queue; the server's re-send waits behind it.
        second.emitMessage(part(2, 'Hello'));
        second.emitMessage({ event: 'agent_action_execute', request_id: 'req-1', action_id: 'a1' });
        await flush();

        // The action finishes meanwhile, its reply goes out and a pong confirms it.
        finishes[0]({ type: 'agent_action_execute', request_id: 'req-1', status: 'applied' });
        await flush();
        expect(second.sentOfType('agent_action_execute')).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(15_000);
        second.emitMessage({ event: 'pong' });
        await flush();

        releasePart();
        await flush();

        expect(execute).toHaveBeenCalledTimes(1);
        expect(second.sentOfType('agent_action_execute')).toHaveLength(1);
    });

    it('stops the keepalives of a re-sent request once its reply is out', async () => {
        const { finishes, provider } = serializedExecute();
        const service = new AgentService('https://api.example.com', provider);
        let releasePart!: () => void;
        const callbacks = createCallbacks({
            onPart: vi.fn(() => new Promise<void>((resolve) => { releasePart = resolve; })),
        });
        const first = await startRun(service, callbacks);
        first.emitMessage({ event: 'agent_action_execute', request_id: 'req-1', action_id: 'a1' });
        await flush();
        first.emitClose(1006);

        const { socket: second } = await reattach(service);
        second.emitMessage({ event: 'reattached', run_id: RUN_ID, last_seq: 1, replayed: 1 });
        // A replayed part blocks the queue; the server's re-send waits behind it.
        second.emitMessage(part(2, 'Hello'));
        second.emitMessage({ event: 'agent_action_execute', request_id: 'req-1', action_id: 'a1' });
        await flush();

        // The original action finishes while the re-send still waits.
        finishes[0]({ type: 'agent_action_execute', request_id: 'req-1', status: 'applied' });
        await flush();
        releasePart();
        await flush();
        expect(second.sentOfType('agent_action_execute')).toHaveLength(1);

        const keepalives = () => second.sentOfType('request_keepalive').filter((m) => m.request_id === 'req-1');
        const sentSoFar = keepalives().length;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(keepalives()).toHaveLength(sentSoFar);
    });

    it('lets a stopped run deliver its cancel before a new chat replaces it', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);
        first.emitClose(1006);
        await service.cancel();

        // The user starts another chat while the stopped run is still reconnecting.
        const nextCallbacks = createCallbacks();
        const next = service.connect({ ...CHAT_REQUEST, run_id: 'run-2' } as AgentRunRequest, nextCallbacks);

        const { socket: second } = await reattach(service);
        second.emitMessage({ event: 'reattached', run_id: RUN_ID, last_seq: 1, replayed: 0 });
        await flush();
        expect(second.sentOfType('cancel')).toHaveLength(1);
        const socketsBeforeCancelClose = MockWebSocket.instances.length;
        expect(socketsBeforeCancelClose).toBe(2);

        // Only once the cancel has gone out does the new chat open its socket.
        await vi.advanceTimersByTimeAsync(250);
        expect(second.close).toHaveBeenCalledWith(1000, 'User cancelled');
        const third = MockWebSocket.instances[2];
        expect(third).toBeDefined();
        third.emitOpen();
        await vi.advanceTimersByTimeAsync(50);
        third.emitMessage(READY_WITH_REATTACH);
        await flush();
        await next;
        expect(third.sentOfType('chat')).toEqual([expect.objectContaining({ run_id: 'run-2' })]);
    });

    it('abandons a chat waiting on a stopped run once the client closes on purpose', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);
        first.emitClose(1006);
        await service.cancel();

        const next = service.connect({ ...CHAT_REQUEST, run_id: 'run-2' } as AgentRunRequest, createCallbacks());
        await flush();
        // The window closes (or library access changes) while the chat waits.
        service.close(1000, 'Window shutdown');
        await next;
        await vi.advanceTimersByTimeAsync(15_000);

        // Nothing was opened for the waiting chat, so nothing was sent.
        expect(MockWebSocket.instances).toHaveLength(1);
        expect(service.isConnected()).toBe(false);
    });

    it('leaves a reconnecting run to the server without cancelling it', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);
        first.emitClose(1006);
        expect(service.canLeaveRun(RUN_ID)).toBe(true);

        // A reattach socket is already open when the user leaves the chat.
        const loop = reattachWithRetry({
            service,
            runId: RUN_ID,
            isStillWanted: () => true,
            sleep: () => Promise.resolve(),
        });
        const second = await acceptNextSocket(READY_WITH_REATTACH);

        expect(service.leaveRun(RUN_ID)).toBe(true);
        await loop;

        // Closed as a lost connection, so the server holds the run instead of
        // ending it, and no cancel is sent.
        expect(second.close).toHaveBeenCalledWith(4000, expect.any(String));
        expect(second.sentOfType('cancel')).toHaveLength(0);
        expect(service.isReattaching(RUN_ID)).toBe(false);
        expect(callbacks.onReattachFailed).not.toHaveBeenCalled();
        // Nothing is waited for by the next chat.
        expect(service.cancelHandoff()).toBeNull();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(callbacks.onReattachFailed).not.toHaveBeenCalled();
    });

    it('does not leave a run the user stopped while it reconnects', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);
        first.emitClose(1006);
        await service.cancel();

        expect(service.canLeaveRun(RUN_ID)).toBe(false);
        expect(service.leaveRun(RUN_ID)).toBe(false);
        expect(service.isReattaching(RUN_ID)).toBe(true);
    });

    it('lets go of a run reattached after the user chose to leave it', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);
        first.emitClose(1006);
        const { socket: second } = await reattach(service);
        second.emitMessage({ event: 'reattached', run_id: RUN_ID, last_seq: 1, replayed: 0 });
        await flush();
        expect(service.canLeaveRun(RUN_ID)).toBe(false);

        expect(service.leaveRun(RUN_ID)).toBe(true);
        expect(second.close).toHaveBeenCalledWith(4000, expect.any(String));
        expect(second.sentOfType('cancel')).toHaveLength(0);
    });

    it('waits a bounded time for a stopped run, then warns the run that replaced it', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);
        expect(service.cancelHandoff()).toBeNull();
        first.emitClose(1006);
        expect(service.cancelHandoff()).toBeNull();
        await service.cancel();

        let waited = false;
        void service.cancelHandoff()!.then(() => { waited = true; });
        const nextCallbacks = createCallbacks({ onPreviousRunNotStopped: vi.fn() });
        void service.connect({ ...CHAT_REQUEST, run_id: 'run-2' } as AgentRunRequest, nextCallbacks);
        await vi.advanceTimersByTimeAsync(9_999);
        expect(waited).toBe(false);
        expect(nextCallbacks.onPreviousRunNotStopped).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(waited).toBe(true);
        // The cancel never went out, and the new run took its place.
        expect(nextCallbacks.onPreviousRunNotStopped).toHaveBeenCalledWith(RUN_ID);
        expect(MockWebSocket.instances[0].sentOfType('cancel')).toHaveLength(0);
    });

    it('warns the next run when a stopped run could not be reattached to deliver its stop', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);
        first.emitClose(1006);
        await service.cancel();

        const nextCallbacks = createCallbacks({ onPreviousRunNotStopped: vi.fn() });
        void service.connect({ ...CHAT_REQUEST, run_id: 'run-2' } as AgentRunRequest, nextCallbacks);
        // The server refuses the reattach; the run is dropped, not stopped.
        service.failReattach(RUN_ID, 'bad_token');
        await flush();
        expect(nextCallbacks.onPreviousRunNotStopped).toHaveBeenCalledWith(RUN_ID);
    });

    it('does not warn when the server had already ended the stopped run', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);
        first.emitClose(1006);
        await service.cancel();

        const nextCallbacks = createCallbacks({ onPreviousRunNotStopped: vi.fn() });
        void service.connect({ ...CHAT_REQUEST, run_id: 'run-2' } as AgentRunRequest, nextCallbacks);
        service.failReattach(RUN_ID, 'expired');
        await flush();
        expect(nextCallbacks.onPreviousRunNotStopped).not.toHaveBeenCalled();
    });

    it('does not warn once the stop was delivered', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);
        first.emitClose(1006);
        await service.cancel();

        const nextCallbacks = createCallbacks({ onPreviousRunNotStopped: vi.fn() });
        void service.connect({ ...CHAT_REQUEST, run_id: 'run-2' } as AgentRunRequest, nextCallbacks);
        const { socket: second } = await reattach(service);
        second.emitMessage({ event: 'reattached', run_id: RUN_ID, last_seq: 1, replayed: 0 });
        await flush();
        expect(second.sentOfType('cancel')).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(250);
        await flush();
        expect(nextCallbacks.onPreviousRunNotStopped).not.toHaveBeenCalled();
    });

    it('does not warn when the waiting request is abandoned', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);
        first.emitClose(1006);
        await service.cancel();

        const nextCallbacks = createCallbacks({ onPreviousRunNotStopped: vi.fn() });
        const next = service.connect({ ...CHAT_REQUEST, run_id: 'run-2' } as AgentRunRequest, nextCallbacks);
        await flush();
        // The user stops the new message while it waits.
        await service.cancel();
        await vi.advanceTimersByTimeAsync(10_000);
        await next;
        expect(nextCallbacks.onPreviousRunNotStopped).not.toHaveBeenCalled();
        // The stopped run is still being reached to deliver its cancel.
        expect(service.isReattaching(RUN_ID)).toBe(true);
    });

    it('does not leave a run holding an answer the user gave while it reconnects', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);
        first.emitClose(1006);
        expect(service.sendApprovalResponse('action-1', true)).toBe(true);

        expect(service.canLeaveRun(RUN_ID)).toBe(false);
        expect(service.leaveRun(RUN_ID)).toBe(false);
        expect(service.isReattaching(RUN_ID)).toBe(true);
    });

    it('ends the run as before against a backend that does not reattach', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks, READY);
        await vi.advanceTimersByTimeAsync(15_000);
        // No last_seq for a backend that never asked for one.
        expect(first.sentOfType('ping').at(-1)).toEqual({ type: 'ping' });

        first.emitClose(1006);

        expect(callbacks.onReattaching).not.toHaveBeenCalled();
        expect(callbacks.onClose).toHaveBeenCalledWith(1006, '', false, expect.objectContaining({ stage: 'mid_run' }));
    });

    it('ends the run on a normal close, which means nobody is coming back', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);

        first.emitClose(1000);

        expect(callbacks.onReattaching).not.toHaveBeenCalled();
        expect(callbacks.onClose).toHaveBeenCalledTimes(1);
    });

    it('ends the run as before when the socket drops before the reattach token arrived', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const connecting = service.connect(CHAT_REQUEST, callbacks);
        const socket = await acceptNextSocket(READY_WITH_REATTACH);
        await connecting;

        socket.emitClose(1006);

        expect(callbacks.onReattaching).not.toHaveBeenCalled();
        expect(callbacks.onClose).toHaveBeenCalledTimes(1);
    });

    it('retries a reattach attempt that fails before ready without ending the run', async () => {
        const service = new AgentService('https://api.example.com', {});
        const callbacks = createCallbacks();
        const first = await startRun(service, callbacks);
        first.emitClose(1006);

        const loop = reattachWithRetry({
            service,
            runId: RUN_ID,
            isStillWanted: () => true,
            sleep: () => Promise.resolve(),
            random: () => 0,
        });
        const count = MockWebSocket.instances.length;
        for (let i = 0; i < 50 && MockWebSocket.instances.length === count; i++) await Promise.resolve();
        // The first attempt never gets through.
        MockWebSocket.instances[count].emitClose(1006);
        const second = await acceptNextSocket(READY_WITH_REATTACH);
        await expect(loop).resolves.toBe('connected');

        expect(callbacks.onClose).not.toHaveBeenCalled();
        expect(callbacks.onReattachFailed).not.toHaveBeenCalled();
        expect(second.sentOfType('reattach')).toHaveLength(1);
    });

    describe('losing a socket opened to reattach', () => {
        /** Lose the run's socket, then reattach on a new one that also dies after sending the reattach. */
        async function loseTheReattachSocket(service: AgentService, callbacks: WSCallbacks): Promise<MockWebSocket> {
            const first = await startRun(service, callbacks);
            first.emitMessage(part(2, 'Hello'));
            await flush();
            first.emitClose(1006);

            const { socket: second, loop } = await reattach(service);
            await expect(loop).resolves.toBe('connected');
            expect(second.sentOfType('reattach')).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(2_000);
            second.emitClose(1006);
            return second;
        }

        it('reattaches again, and the run goes on once the server confirms', async () => {
            const service = new AgentService('https://api.example.com', {});
            const callbacks = createCallbacks();
            const second = await loseTheReattachSocket(service, callbacks);

            // The same loss goes on: a new reattach starts from the first loss.
            const reattaching = vi.mocked(callbacks.onReattaching!);
            expect(reattaching).toHaveBeenCalledTimes(2);
            expect(reattaching.mock.calls[1][0]).toEqual(reattaching.mock.calls[0][0]);
            expect(service.isReattaching(RUN_ID)).toBe(true);
            expect(callbacks.onClose).not.toHaveBeenCalled();

            // The server's answer on the lost socket never counts.
            second.emitMessage({ event: 'reattached', run_id: RUN_ID, last_seq: 3, replayed: 1 });
            await flush();
            expect(callbacks.onReattached).not.toHaveBeenCalled();

            // One attempt fails before its socket opens; the next gets through.
            const loop = reattachWithRetry({
                service,
                runId: RUN_ID,
                isStillWanted: () => true,
                sleep: () => Promise.resolve(),
                random: () => 0,
            });
            const count = MockWebSocket.instances.length;
            for (let i = 0; i < 50 && MockWebSocket.instances.length === count; i++) await Promise.resolve();
            MockWebSocket.instances[count].emitClose(1006);
            const third = await acceptNextSocket(READY_WITH_REATTACH);
            await expect(loop).resolves.toBe('connected');
            expect(third.sentOfType('reattach')).toEqual([
                { type: 'reattach', run_id: RUN_ID, reattach_token: TOKEN, last_seq: 2 },
            ]);

            third.emitMessage({ event: 'reattached', run_id: RUN_ID, last_seq: 3, replayed: 1 });
            third.emitMessage({ event: 'done', seq: 3 });
            await flush();

            expect(callbacks.onReattached).toHaveBeenCalledTimes(1);
            expect(callbacks.onReattached).toHaveBeenCalledWith(
                expect.objectContaining({ runId: RUN_ID, replayed: 1, attempts: 3, losses: 2 }),
            );
            expect(callbacks.onDone).toHaveBeenCalledTimes(1);
            expect(callbacks.onReattachFailed).not.toHaveBeenCalled();
            expect(callbacks.onClose).not.toHaveBeenCalled();
        });

        it('keeps the grace period of the first loss', async () => {
            const service = new AgentService('https://api.example.com', {});
            const callbacks = createCallbacks();
            await loseTheReattachSocket(service, callbacks);

            const { detachedAt, graceMs } = vi.mocked(callbacks.onReattaching!).mock.calls[0][0];
            expect(Date.now() - detachedAt).toBeGreaterThanOrEqual(2_000);
            await vi.advanceTimersByTimeAsync(detachedAt + graceMs - Date.now() - 1);
            expect(callbacks.onReattachFailed).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);

            expect(callbacks.onReattachFailed).toHaveBeenCalledWith(
                expect.objectContaining({ runId: RUN_ID, reason: 'gave_up', attempts: 1, losses: 2 }),
            );
            expect(service.isReattaching(RUN_ID)).toBe(false);
        });

        it('counts a later loss of a reattached run from scratch', async () => {
            const service = new AgentService('https://api.example.com', {});
            const callbacks = createCallbacks();
            const first = await startRun(service, callbacks);
            first.emitClose(1006);
            const { socket: second } = await reattach(service);
            second.emitMessage({ event: 'reattached', run_id: RUN_ID, last_seq: 1, replayed: 0 });
            await flush();
            expect(callbacks.onReattached).toHaveBeenLastCalledWith(
                expect.objectContaining({ attempts: 1, losses: 1 }),
            );

            second.emitClose(1006);
            const { socket: third } = await reattach(service);
            third.emitMessage({ event: 'reattached', run_id: RUN_ID, last_seq: 1, replayed: 0 });
            await flush();

            expect(callbacks.onReattached).toHaveBeenCalledTimes(2);
            expect(callbacks.onReattached).toHaveBeenLastCalledWith(
                expect.objectContaining({ attempts: 1, losses: 1 }),
            );
        });
    });

    describe('reaching the server again after an outage', () => {
        /** The reattach loop with real (fake-timer) waits, so time can be stepped. */
        function reattachLoop(service: AgentService) {
            return reattachWithRetry({
                service,
                runId: RUN_ID,
                isStillWanted: () => true,
                sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
                random: () => 0,
            });
        }

        async function accept(socket: MockWebSocket): Promise<MockWebSocket> {
            socket.emitOpen();
            await vi.advanceTimersByTimeAsync(50);
            socket.emitMessage(READY_WITH_REATTACH);
            await flush();
            return socket;
        }

        async function nextSocket(count: number): Promise<MockWebSocket | undefined> {
            for (let i = 0; i < 50 && MockWebSocket.instances.length === count; i++) await Promise.resolve();
            return MockWebSocket.instances[count];
        }

        it('opens no socket while the server cannot be reached, and one as soon as it can', async () => {
            let serverUp = false;
            const fetchMock = vi.fn(async () => {
                if (!serverUp) throw new TypeError('NetworkError when attempting to fetch resource.');
                return { status: 200 };
            });
            vi.stubGlobal('fetch', fetchMock);
            const service = new AgentService('https://api.example.com/api', {});
            const callbacks = createCallbacks();
            const first = await startRun(service, callbacks);
            first.emitClose(1006);

            const loop = reattachLoop(service);
            const count = MockWebSocket.instances.length;
            // The first attempt goes straight out, and fails.
            (await nextSocket(count))!.emitClose(1006);

            await vi.advanceTimersByTimeAsync(10_000);
            expect(MockWebSocket.instances).toHaveLength(count + 1);
            expect(fetchMock.mock.calls.length).toBeGreaterThan(5);
            expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/health', expect.anything());

            serverUp = true;
            await vi.advanceTimersByTimeAsync(1_000);
            expect(MockWebSocket.instances).toHaveLength(count + 2);
            const second = await accept(MockWebSocket.instances[count + 1]);
            await expect(loop).resolves.toBe('connected');
            expect(second.sentOfType('reattach')).toHaveLength(1);
            expect(callbacks.onClose).not.toHaveBeenCalled();
        });

        it('replaces a reattach socket that does not open in time', async () => {
            const service = new AgentService('https://api.example.com', {});
            const callbacks = createCallbacks();
            const first = await startRun(service, callbacks);
            first.emitClose(1006);

            const loop = reattachLoop(service);
            const count = MockWebSocket.instances.length;
            const stuck = (await nextSocket(count))!;

            await vi.advanceTimersByTimeAsync(REATTACH_OPEN_TIMEOUT_MS - 1);
            expect(stuck.close).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(stuck.close).toHaveBeenCalledWith(1000, 'Connection attempt timed out');
            expect(service.isReattaching(RUN_ID)).toBe(true);

            await vi.advanceTimersByTimeAsync(1_000);
            expect(MockWebSocket.instances).toHaveLength(count + 2);
            const second = await accept(MockWebSocket.instances[count + 1]);
            await expect(loop).resolves.toBe('connected');
            expect(second.sentOfType('reattach')).toHaveLength(1);
            expect(callbacks.onClose).not.toHaveBeenCalled();
            expect(callbacks.onReattachFailed).not.toHaveBeenCalled();
        });

        it('leaves a reattach socket that opened to wait for ready', async () => {
            const service = new AgentService('https://api.example.com', {});
            const first = await startRun(service, createCallbacks());
            first.emitClose(1006);

            const loop = reattachLoop(service);
            const socket = (await nextSocket(MockWebSocket.instances.length))!;
            socket.emitOpen();
            await vi.advanceTimersByTimeAsync(REATTACH_OPEN_TIMEOUT_MS + 1_000);
            expect(socket.close).not.toHaveBeenCalled();

            socket.emitMessage(READY_WITH_REATTACH);
            await flush();
            await expect(loop).resolves.toBe('connected');
            expect(socket.sentOfType('reattach')).toHaveLength(1);
        });

        it('gives a new run the full connect timeout to open its socket', async () => {
            const service = new AgentService('https://api.example.com', {});
            const connecting = service.connect(CHAT_REQUEST, createCallbacks());
            const outcome = connecting.then(() => null, (error: Error) => error);
            const socket = (await nextSocket(0))!;

            await vi.advanceTimersByTimeAsync(REATTACH_OPEN_TIMEOUT_MS + 1_000);
            expect(socket.close).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
            await expect(outcome).resolves.toMatchObject({ name: 'ConnectTimeoutError' });
        });

        it('probes reachability over HTTP, counting any answer below 500', async () => {
            const service = new AgentService('https://api.example.com/api/v1', {});
            const fetchMock = vi.fn();
            vi.stubGlobal('fetch', fetchMock);

            fetchMock.mockResolvedValueOnce({ status: 200 });
            await expect(service.probeReachable()).resolves.toBe(true);
            expect(fetchMock).toHaveBeenLastCalledWith('https://api.example.com/health', expect.anything());

            fetchMock.mockResolvedValueOnce({ status: 404 });
            await expect(service.probeReachable()).resolves.toBe(true);

            fetchMock.mockResolvedValueOnce({ status: 503 });
            await expect(service.probeReachable()).resolves.toBe(false);

            fetchMock.mockRejectedValueOnce(new TypeError('NetworkError'));
            await expect(service.probeReachable()).resolves.toBe(false);
        });

        it('gives up on a probe that gets no answer', async () => {
            const service = new AgentService('https://api.example.com', {});
            vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
                init.signal.addEventListener('abort', () => reject(new Error('aborted')));
            })));

            const probe = service.probeReachable();
            await vi.advanceTimersByTimeAsync(REACHABILITY_PROBE_TIMEOUT_MS);
            await expect(probe).resolves.toBe(false);
        });
    });

    it('keeps a connection started from inside onClose', async () => {
        const service = new AgentService('https://api.example.com', {});
        let nextConnect: Promise<void> | null = null;
        const callbacks = createCallbacks({
            onClose: vi.fn(() => {
                nextConnect = service.connect({ ...CHAT_REQUEST, run_id: 'run-2' } as AgentRunRequest, createCallbacks());
            }),
        });
        const first = await startRun(service, callbacks, READY);
        first.emitClose(1006);

        // The close handler's own reset must not strand the connect it started.
        const second = await acceptNextSocket(READY);
        await nextConnect;
        expect(second.sentOfType('chat')).toEqual([expect.objectContaining({ run_id: 'run-2' })]);
        expect(service.isConnected()).toBe(true);
    });
});
