/**
 * Answering the cards of a parked run.
 *
 * A run that ends waiting on cards (`run_complete.parked`) keeps them on
 * screen and answerable. Each answer resumes the run at once: a new request
 * carrying the answer in `deferred_results` and the parked run in
 * `resumes_run_id`. The resume shows the cards still open again and waits
 * for them live: answers to them go over its socket. Answers given before it
 * does go out as soon as it does, or together once it ends.
 *
 * The transport is a stand-in that hands back the callbacks each run was
 * started with; the atoms and the store are the real thing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connectMock, closeMock, sendApprovalResponseMock, sendQuestionResponseMock, sendCardAnswerMock, parkRunMock, isConnectedMock, transport } = vi.hoisted(() => ({
    connectMock: vi.fn(),
    // Like the real service, closing reports the close to the run's callbacks.
    transport: { callbacks: null as null | { onClose?: (code: number, reason: string, wasClean: boolean) => void } },
    closeMock: vi.fn(),
    sendApprovalResponseMock: vi.fn(() => true),
    sendQuestionResponseMock: vi.fn(() => true),
    sendCardAnswerMock: vi.fn(() => true),
    parkRunMock: vi.fn(async () => 'ended'),
    isConnectedMock: vi.fn(() => true),
}));

vi.mock('@beaver/agent-core/transport/agentService', () => ({
    agentService: {
        connect: connectMock,
        close: closeMock,
        cancel: vi.fn(),
        cancelHandoff: () => null,
        failReattach: vi.fn(),
        isReattaching: () => false,
        reattachAttempt: () => null,
        canLeaveRun: () => false,
        leaveRun: () => false,
        isConnected: isConnectedMock,
        sendApprovalResponse: sendApprovalResponseMock,
        sendAskUserQuestionResponse: sendQuestionResponseMock,
        sendPark: vi.fn(() => true),
        sendCardAnswer: sendCardAnswerMock,
        parkRun: parkRunMock,
    },
    AgentConnectionError: class AgentConnectionError extends Error {},
}));
vi.mock('@beaver/agent-core/transport/clientIdentity', () => ({
    resolveClientIdentity: vi.fn(() => ({ frontendVersion: '0.99.1-test', clientType: 'zotero-plugin', clientFeatures: [] })),
}));
vi.mock('@beaver/agent-core/transport/clients/diagnosticsService', () => ({
    reportConnectionFailure: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../react/atoms/applicationState', () => ({
    getApplicationStateProvider: vi.fn(() => async () => ({})),
}));
vi.mock('../../../src/services/systemNotifications', () => ({
    notifyApprovalRequest: vi.fn(),
    notifyRunComplete: vi.fn(),
    notifyUserQuestion: vi.fn(),
    notifyBatchApproval: vi.fn(),
    notifyCreditConfirmation: vi.fn(),
}));
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn(), refreshSession: vi.fn() } },
}));
vi.mock('../../../src/beaver-extract', () => ({ prewarmMuPDFWorker: vi.fn() }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import type { WSCallbacks } from '@beaver/agent-core/protocol/agentProtocol';
import type { ParkedDeferral, ParkedRun } from '@beaver/agent-core/agents/types';
import { activeRunAtom, currentThreadIdAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { openParkedRunAtom } from '@beaver/agent-core/run-state/parkedRun';
import { pendingQuestionsAtom } from '@beaver/agent-core/run-state/pendingQuestions';
import { pendingCreditConfirmationsAtom } from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import { pendingTableCardsAtom, tableCardDraftsAtom } from '@beaver/agent-core/run-state/pendingTableCards';
import { store } from '../../../react/store';
import {
    abandonActiveRunLocallyAtom,
    isWSChatPendingAtom,
    isWSReadyAtom,
    parkableRunId,
    sendApprovalResponseAtom,
    sendAskUserQuestionResponseAtom,
    sendTableCardResponseAtom,
    sendWSMessageAtom,
    staleApprovalActionIdsAtom,
    wsErrorAtom,
} from '../../../react/atoms/agentRunAtoms';
import { pendingApprovalsAtom, removePendingApprovalAtom } from '../../../react/agents/agentActions';
import {
    clearParkedAnswersAtom,
    isResumeWaitingAtom,
    isThreadParkedAtom,
    liveCardAnswersAtom,
    parkedAnswerQueueAtom,
    pendingParkedAnswerIdsAtom,
    resumeLiveCardsAtom,
} from '../../../react/atoms/parkedRuns';
import { threadAdmissionAtom } from '../../../react/runtime/threadAdmission';
import { threadNavigationSeqAtom } from '../../../react/atoms/threads';
import { selectedModelAtom } from '../../../react/atoms/models';
import { sessionAtom } from '../../../react/atoms/auth';

const THREAD = 'thread-1';

function approval(toolCallId: string): ParkedDeferral {
    return {
        kind: 'agent_action_approval',
        tool_call_id: toolCallId,
        tool_name: 'edit_metadata',
        correlation_id: `action-${toolCallId}`,
        request: {
            event: 'deferred_approval_request',
            action_id: `action-${toolCallId}`,
            toolcall_id: toolCallId,
            action_type: 'edit_metadata',
            action_data: {},
        },
    };
}

function question(toolCallId: string): ParkedDeferral {
    return {
        kind: 'ask_user_question',
        tool_call_id: toolCallId,
        tool_name: 'ask_user_question',
        correlation_id: `question-${toolCallId}`,
        request: {
            event: 'ask_user_question_request',
            question_id: `question-${toolCallId}`,
            toolcall_id: toolCallId,
            title: null,
            questions: [{ id: 'q0', question: 'Which?', options: [{ id: 'q0-o0', label: 'A' }] }],
        },
    };
}

function tableCard(toolCallId: string): ParkedDeferral {
    return {
        kind: 'table_card',
        tool_call_id: toolCallId,
        tool_name: 'create_table',
        correlation_id: `card-${toolCallId}`,
        request: {
            event: 'table_card_request',
            card_id: `card-${toolCallId}`,
            toolcall_id: toolCallId,
            scope: 'create',
            destination: {},
            merge: {},
            row_cap: 500,
            total: 3,
            sources: [],
            columns: [],
        },
    };
}

function parked(requests: ParkedDeferral[]): ParkedRun {
    return { version: 1, parked_at: '2026-11-08T10:00:00Z', reason: 'timeout', requests };
}

/** Capture the callbacks of the next run the client connects. */
function nextConnection(): Promise<{ request: any; callbacks: WSCallbacks }> {
    return new Promise((resolve) => {
        connectMock.mockImplementationOnce(async (request: any, callbacks: WSCallbacks) => {
            transport.callbacks = callbacks;
            resolve({ request, callbacks });
        });
    });
}

function streamToolCalls(callbacks: WSCallbacks, runId: string, toolCallIds: string[]): void {
    toolCallIds.forEach((toolCallId, index) => {
        void callbacks.onPart({
            event: 'part',
            run_id: runId,
            message_index: 0,
            part_index: index,
            part: { part_kind: 'tool-call', tool_name: 'edit_metadata', args: {}, tool_call_id: toolCallId },
        } as any);
    });
}

async function finish(callbacks: WSCallbacks, runId: string, parkedRecord?: ParkedRun): Promise<void> {
    await callbacks.onRunComplete({
        event: 'run_complete',
        run_id: runId,
        usage: null,
        cost: null,
        citations: null,
        agent_actions: null,
        ...(parkedRecord ? { parked: parkedRecord } : {}),
    });
    callbacks.onDone();
}

async function returnTool(callbacks: WSCallbacks, runId: string, toolCallId: string): Promise<void> {
    await callbacks.onToolReturn({
        event: 'tool_return',
        run_id: runId,
        message_index: 0,
        part: {
            part_kind: 'tool-return',
            tool_name: 'edit_metadata',
            tool_call_id: toolCallId,
            content: 'ok',
            metadata: { view: { kind: 'text', text: 'ok' } },
        },
    } as any);
}

/** A fresh chat on a connected client. */
function resetChat(): void {
    vi.clearAllMocks();
    connectMock.mockReset();
    closeMock.mockImplementation(() => transport.callbacks?.onClose?.(1000, 'Client closing', true));
    sendApprovalResponseMock.mockReturnValue(true);
    sendQuestionResponseMock.mockReturnValue(true);
    sendCardAnswerMock.mockReturnValue(true);
    isConnectedMock.mockReturnValue(true);
    store.set(sessionAtom, { user: { id: 'user-1' } } as any);
    store.set(selectedModelAtom, { id: 'model-1', name: 'Model', provider: 'test' } as any);
    store.set(threadRunsAtom, []);
    store.set(activeRunAtom, null);
    store.set(currentThreadIdAtom, THREAD);
    store.set(threadAdmissionAtom, { threadId: THREAD, tailRunId: null, activity: { state: 'idle', run_id: null } });
    store.set(wsErrorAtom, null);
    store.set(isWSChatPendingAtom, false);
    store.set(pendingApprovalsAtom, new Map());
    store.set(pendingQuestionsAtom, new Map());
    store.set(pendingCreditConfirmationsAtom, new Map());
    store.set(pendingTableCardsAtom, new Map());
    store.set(tableCardDraftsAtom, new Map());
    store.set(clearParkedAnswersAtom);
}

/** A live run that parks on two approvals (one never shown live) and a question. */
async function parkRun(): Promise<{ runId: string; callbacks: WSCallbacks }> {
    const connected = nextConnection();
    await store.set(sendWSMessageAtom, 'hello');
    const { callbacks } = await connected;
    store.set(isWSReadyAtom, true);
    const runId = store.get(activeRunAtom)!.id;
    streamToolCalls(callbacks, runId, ['call-1', 'call-2', 'call-3']);
    callbacks.onDeferredApprovalRequest?.(approval('call-1').request as any);
    await finish(callbacks, runId, parked([approval('call-1'), approval('call-2'), question('call-3')]));
    return { runId, callbacks };
}

describe('answering the cards of a parked run', () => {
    beforeEach(resetChat);

    it('keeps every card the run parked on, including one it never showed', async () => {
        const { runId } = await parkRun();

        // Closing the socket at the end of the run did not rebuild the cards.
        expect(closeMock).toHaveBeenCalled();

        expect(store.get(threadRunsAtom).at(-1)).toMatchObject({ id: runId, status: 'parked' });
        expect(store.get(activeRunAtom)).toBeNull();
        expect([...store.get(pendingApprovalsAtom).keys()].sort()).toEqual(['action-call-1', 'action-call-2']);
        expect([...store.get(pendingQuestionsAtom).keys()]).toEqual(['call-3']);
        expect(store.get(isThreadParkedAtom)).toBe(true);
        expect(store.get(isWSChatPendingAtom)).toBe(false);
    });

    it('resumes the run with an answer at once, keeping the other cards answerable', async () => {
        const { runId } = await parkRun();
        const questionCard = store.get(pendingQuestionsAtom).get('call-3');
        const resumed = nextConnection();

        store.set(sendApprovalResponseAtom, { actionId: 'action-call-1', approved: true });
        store.set(removePendingApprovalAtom, 'action-call-1');
        const { request } = await resumed;

        expect(sendApprovalResponseMock).not.toHaveBeenCalled();
        expect(request.user_prompt).toMatchObject({
            content: '',
            resumes_run_id: runId,
            deferred_results: {
                'call-1': { type: 'deferred_approval_response', action_id: 'action-call-1', approved: true },
            },
        });
        expect(request.user_prompt.is_resume).toBeUndefined();
        // The parked run is the thread's tail.
        expect(request.expected_tail_run_id).toBe(runId);
        expect(store.get(activeRunAtom)).toMatchObject({ status: 'in_progress' });
        expect([...store.get(pendingApprovalsAtom).keys()]).toEqual(['action-call-2']);
        expect([...store.get(pendingQuestionsAtom).keys()]).toEqual(['call-3']);
        // The same entry, not a rebuilt one: its panel and draft stay as they were.
        expect(store.get(pendingQuestionsAtom).get('call-3')).toBe(questionCard);
        expect([...store.get(pendingParkedAnswerIdsAtom)]).toEqual(['call-1']);
    });

    it('sends answers given while a resume runs together, once it parks again', async () => {
        await parkRun();
        const firstResume = nextConnection();
        store.set(sendApprovalResponseAtom, { actionId: 'action-call-1', approved: true });
        store.set(removePendingApprovalAtom, 'action-call-1');
        const { callbacks } = await firstResume;
        const resumeRunId = store.get(activeRunAtom)!.id;

        // Answered while the first resume is still running: queued, not sent.
        store.set(sendAskUserQuestionResponseAtom, {
            questionId: 'question-call-3',
            toolcallId: 'call-3',
            answers: [{ item_id: 'q0', selected_option_ids: ['q0-o0'] }],
        });
        store.set(sendApprovalResponseAtom, { actionId: 'action-call-2', approved: false });
        store.set(removePendingApprovalAtom, 'action-call-2');
        await Promise.resolve();
        expect(connectMock).toHaveBeenCalledTimes(2);
        expect(sendQuestionResponseMock).not.toHaveBeenCalled();

        const secondResume = nextConnection();
        await returnTool(callbacks, resumeRunId, 'call-1');
        await finish(callbacks, resumeRunId, parked([approval('call-2'), question('call-3')]));
        const { request } = await secondResume;

        expect(store.get(threadRunsAtom).at(-1)).toMatchObject({ id: resumeRunId, status: 'parked' });
        expect(request.user_prompt.resumes_run_id).toBe(resumeRunId);
        expect(Object.keys(request.user_prompt.deferred_results).sort()).toEqual(['call-2', 'call-3']);
        expect(request.user_prompt.deferred_results['call-3']).toMatchObject({
            type: 'ask_user_question_response',
            question_id: 'question-call-3',
            cancelled: false,
        });
        expect(request.user_prompt.deferred_results['call-2']).toMatchObject({ approved: false });
        expect(request.expected_tail_run_id).toBe(resumeRunId);
    });

    it('sends queued answers when a resume parks again but loses its connection before done', async () => {
        await parkRun();
        const firstResume = nextConnection();
        store.set(sendApprovalResponseAtom, { actionId: 'action-call-1', approved: true });
        store.set(removePendingApprovalAtom, 'action-call-1');
        const { callbacks } = await firstResume;
        const resumeRunId = store.get(activeRunAtom)!.id;
        store.set(sendApprovalResponseAtom, { actionId: 'action-call-2', approved: true });
        store.set(removePendingApprovalAtom, 'action-call-2');

        const secondResume = nextConnection();
        await returnTool(callbacks, resumeRunId, 'call-1');
        await callbacks.onRunComplete({
            event: 'run_complete', run_id: resumeRunId, usage: null, cost: null, citations: null, agent_actions: null,
            parked: parked([approval('call-2'), question('call-3')]),
        });
        callbacks.onClose?.(1006, '', false);
        const { request } = await secondResume;

        expect(store.get(threadRunsAtom).at(-1)).toMatchObject({ id: resumeRunId, status: 'parked' });
        expect(request.user_prompt.resumes_run_id).toBe(resumeRunId);
        expect(Object.keys(request.user_prompt.deferred_results)).toEqual(['call-2']);
    });

    it('brings the cards back when a resume fails, and does not retry it on its own', async () => {
        const { runId } = await parkRun();
        const resumed = nextConnection();
        store.set(sendApprovalResponseAtom, { actionId: 'action-call-1', approved: true });
        store.set(removePendingApprovalAtom, 'action-call-1');
        const { callbacks } = await resumed;

        callbacks.onError({ event: 'error', type: 'internal_error', message: 'boom', try_auto_resume: true } as any);
        await Promise.resolve();

        expect(connectMock).toHaveBeenCalledTimes(2);
        expect(store.get(activeRunAtom)).toMatchObject({ status: 'error' });
        expect(store.get(openParkedRunAtom)?.runId).toBe(runId);
        expect([...store.get(pendingApprovalsAtom).keys()].sort()).toEqual(['action-call-1', 'action-call-2']);
        expect([...store.get(pendingQuestionsAtom).keys()]).toEqual(['call-3']);
        expect(store.get(pendingParkedAnswerIdsAtom).size).toBe(0);
    });

    it('keeps the edits of a table card the run parked on, and keeps them when its resume fails', async () => {
        const connected = nextConnection();
        await store.set(sendWSMessageAtom, 'make a table');
        const { callbacks } = await connected;
        const runId = store.get(activeRunAtom)!.id;
        streamToolCalls(callbacks, runId, ['call-1']);
        callbacks.onTableCardRequest?.(tableCard('call-1').request as any);
        const draft = { title: 'Edited title' } as any;
        store.set(tableCardDraftsAtom, new Map([['card-call-1', draft]]));
        const card = store.get(pendingTableCardsAtom).get('card-call-1');

        await finish(callbacks, runId, parked([tableCard('call-1')]));

        expect(store.get(pendingTableCardsAtom).get('card-call-1')).toBe(card);
        expect(store.get(tableCardDraftsAtom).get('card-call-1')).toBe(draft);

        const resumed = nextConnection();
        store.set(sendTableCardResponseAtom, { type: 'table_card_response', card_id: 'card-call-1', approved: true } as any);
        const { callbacks: resumeCallbacks } = await resumed;
        expect(store.get(pendingTableCardsAtom).has('card-call-1')).toBe(false);

        resumeCallbacks.onError({ event: 'error', type: 'internal_error', message: 'boom' } as any);

        expect(store.get(pendingTableCardsAtom).has('card-call-1')).toBe(true);
        expect(store.get(tableCardDraftsAtom).get('card-call-1')).toBe(draft);
    });

    it('stops rather than parks a resume that has not shown its cards again', async () => {
        await parkRun();
        const resumed = nextConnection();
        store.set(sendApprovalResponseAtom, { actionId: 'action-call-1', approved: true });
        store.set(removePendingApprovalAtom, 'action-call-1');
        await resumed;

        // The parked run's other cards are on screen, but the resume waits on none of them yet.
        expect(store.get(pendingApprovalsAtom).size).toBe(1);
        expect(parkableRunId(store.get)).toBeNull();
    });

    it('closes the cards when a message is sent instead of an answer', async () => {
        await parkRun();
        const superseding = nextConnection();

        await store.set(sendWSMessageAtom, 'something else');
        const { request } = await superseding;

        expect(request.user_prompt.content).toBe('something else');
        expect(request.user_prompt.deferred_results).toBeUndefined();
        expect(store.get(pendingApprovalsAtom).size).toBe(0);
        expect(store.get(pendingQuestionsAtom).size).toBe(0);
    });

    it('answers a live card over the socket as before', async () => {
        const connected = nextConnection();
        await store.set(sendWSMessageAtom, 'hello');
        const { callbacks } = await connected;
        const runId = store.get(activeRunAtom)!.id;
        streamToolCalls(callbacks, runId, ['call-1']);
        callbacks.onDeferredApprovalRequest?.(approval('call-1').request as any);

        store.set(sendApprovalResponseAtom, { actionId: 'action-call-1', approved: true });

        expect(sendApprovalResponseMock).toHaveBeenCalledWith('action-call-1', true, undefined, undefined);
        expect(connectMock).toHaveBeenCalledTimes(1);
        expect(store.get(liveCardAnswersAtom).has('call-1')).toBe(true);
    });
});

describe('an answer given while the run parks', () => {
    beforeEach(resetChat);

    /** A live run showing an approval and a question. */
    async function liveRun(): Promise<{ runId: string; callbacks: WSCallbacks }> {
        const connected = nextConnection();
        await store.set(sendWSMessageAtom, 'hello');
        const { callbacks } = await connected;
        store.set(isWSReadyAtom, true);
        const runId = store.get(activeRunAtom)!.id;
        streamToolCalls(callbacks, runId, ['call-1', 'call-3']);
        callbacks.onDeferredApprovalRequest?.(approval('call-1').request as any);
        callbacks.onAskUserQuestionRequest?.(question('call-3').request as any);
        return { runId, callbacks };
    }

    function approveLive(): void {
        store.set(sendApprovalResponseAtom, { actionId: 'action-call-1', approved: true });
        store.set(removePendingApprovalAtom, 'action-call-1');
    }

    it('keeps an approval the run parks on waiting, and resumes the parked run with it', async () => {
        const { runId, callbacks } = await liveRun();
        approveLive();
        callbacks.onDeferredApprovalStale?.({ event: 'deferred_approval_stale', action_id: 'action-call-1', reason: 'parking' });

        // No fallback to applying locally: the answer is on its way to the parked run.
        expect(store.get(staleApprovalActionIdsAtom).has('action-call-1')).toBe(false);

        const resumed = nextConnection();
        await finish(callbacks, runId, parked([approval('call-1'), question('call-3')]));
        const { request } = await resumed;

        expect(request.user_prompt).toMatchObject({
            resumes_run_id: runId,
            deferred_results: {
                'call-1': { type: 'deferred_approval_response', action_id: 'action-call-1', approved: true },
            },
        });
        expect(Object.keys(request.user_prompt.deferred_results)).toEqual(['call-1']);
        expect([...store.get(pendingParkedAnswerIdsAtom)]).toEqual(['call-1']);
        expect([...store.get(pendingApprovalsAtom).keys()]).toEqual([]);
        expect([...store.get(pendingQuestionsAtom).keys()]).toEqual(['call-3']);
    });

    it('resumes with an answer that crossed the end of the run unanswered', async () => {
        const { runId, callbacks } = await liveRun();
        store.set(sendAskUserQuestionResponseAtom, {
            questionId: 'question-call-3',
            toolcallId: 'call-3',
            answers: [{ item_id: 'q0', selected_option_ids: ['q0-o0'] }],
        });

        const resumed = nextConnection();
        await finish(callbacks, runId, parked([approval('call-1'), question('call-3')]));
        const { request } = await resumed;

        expect(Object.keys(request.user_prompt.deferred_results)).toEqual(['call-3']);
        expect(request.user_prompt.deferred_results['call-3']).toMatchObject({
            type: 'ask_user_question_response',
            question_id: 'question-call-3',
        });
        expect([...store.get(pendingApprovalsAtom).keys()]).toEqual(['action-call-1']);
    });

    it('resumes with the answer when the run parks but loses its connection before done', async () => {
        const { runId, callbacks } = await liveRun();
        approveLive();
        callbacks.onDeferredApprovalStale?.({ event: 'deferred_approval_stale', action_id: 'action-call-1', reason: 'parking' });

        const resumed = nextConnection();
        await callbacks.onRunComplete({
            event: 'run_complete', run_id: runId, usage: null, cost: null, citations: null, agent_actions: null,
            parked: parked([approval('call-1'), question('call-3')]),
        });
        callbacks.onClose?.(1006, '', false);
        const { request } = await resumed;

        expect(request.user_prompt.resumes_run_id).toBe(runId);
        expect(Object.keys(request.user_prompt.deferred_results)).toEqual(['call-1']);
    });

    it('does not carry an answer whose call returned', async () => {
        const { runId, callbacks } = await liveRun();
        approveLive();
        await returnTool(callbacks, runId, 'call-1');

        await finish(callbacks, runId, parked([question('call-3')]));
        await Promise.resolve();

        expect(connectMock).toHaveBeenCalledTimes(1);
        expect(store.get(parkedAnswerQueueAtom).size).toBe(0);
    });

    it('restores the local controls when the run ends without parking the card', async () => {
        const { runId, callbacks } = await liveRun();
        approveLive();
        callbacks.onDeferredApprovalStale?.({ event: 'deferred_approval_stale', action_id: 'action-call-1', reason: 'parking' });

        await finish(callbacks, runId);
        await Promise.resolve();

        expect(connectMock).toHaveBeenCalledTimes(1);
        expect(store.get(staleApprovalActionIdsAtom).has('action-call-1')).toBe(true);
    });

    it('restores the local controls when the run fails while parking', async () => {
        const { callbacks } = await liveRun();
        approveLive();
        callbacks.onDeferredApprovalStale?.({ event: 'deferred_approval_stale', action_id: 'action-call-1', reason: 'parking' });

        callbacks.onError({ event: 'error', type: 'internal_error', message: 'boom' } as any);

        expect(store.get(staleApprovalActionIdsAtom).has('action-call-1')).toBe(true);
    });

    it('restores the local controls when the user stops the run while it parks', async () => {
        const { callbacks } = await liveRun();
        approveLive();
        callbacks.onDeferredApprovalStale?.({ event: 'deferred_approval_stale', action_id: 'action-call-1', reason: 'parking' });

        store.set(abandonActiveRunLocallyAtom);

        expect(store.get(staleApprovalActionIdsAtom).has('action-call-1')).toBe(true);
    });

    it('restores the local controls when the connection is lost before the run completes', async () => {
        const { callbacks } = await liveRun();
        approveLive();
        callbacks.onDeferredApprovalStale?.({ event: 'deferred_approval_stale', action_id: 'action-call-1', reason: 'parking' });

        callbacks.onClose?.(1006, '', false);

        expect(store.get(staleApprovalActionIdsAtom).has('action-call-1')).toBe(true);
    });

    it('falls back to applying locally for an answer that simply timed out', async () => {
        const { callbacks } = await liveRun();
        approveLive();
        callbacks.onDeferredApprovalStale?.({ event: 'deferred_approval_stale', action_id: 'action-call-1', reason: 'timed_out' });

        expect(store.get(staleApprovalActionIdsAtom).has('action-call-1')).toBe(true);
    });
});

describe('a resume waiting for the cards it shows again', () => {
    beforeEach(resetChat);

    /** Park, answer call-1, and return the resume that carries the answer. */
    async function resume(): Promise<{ callbacks: WSCallbacks; resumeRunId: string }> {
        await parkRun();
        const resumed = nextConnection();
        store.set(sendApprovalResponseAtom, { actionId: 'action-call-1', approved: true });
        store.set(removePendingApprovalAtom, 'action-call-1');
        const { callbacks } = await resumed;
        store.set(isWSReadyAtom, true);
        return { callbacks, resumeRunId: store.get(activeRunAtom)!.id };
    }

    function showAgain(callbacks: WSCallbacks): void {
        callbacks.onDeferredApprovalRequest?.(approval('call-2').request as any);
        callbacks.onAskUserQuestionRequest?.(question('call-3').request as any);
    }

    it('keeps the cards on screen as they were and answers them over its socket', async () => {
        const { callbacks, resumeRunId } = await resume();
        const questionCard = store.get(pendingQuestionsAtom).get('call-3');

        showAgain(callbacks);

        expect([...store.get(resumeLiveCardsAtom)].sort()).toEqual(['call-2', 'call-3']);
        expect(store.get(pendingQuestionsAtom).get('call-3')).toBe(questionCard);
        expect([...store.get(pendingApprovalsAtom).keys()]).toEqual(['action-call-2']);
        // The thread still looks parked: the model waits for the other cards.
        expect(store.get(isThreadParkedAtom)).toBe(true);

        await returnTool(callbacks, resumeRunId, 'call-1');
        // The answer the resume carried has landed: its card shows the result, not a spinner.
        expect(store.get(pendingParkedAnswerIdsAtom).has('call-1')).toBe(false);
        store.set(sendApprovalResponseAtom, { actionId: 'action-call-2', approved: true });

        expect(sendApprovalResponseMock).toHaveBeenCalledWith('action-call-2', true, undefined, undefined);
        expect(connectMock).toHaveBeenCalledTimes(2);
        expect(store.get(parkedAnswerQueueAtom).size).toBe(0);
        expect(store.get(isThreadParkedAtom)).toBe(true);

        store.set(sendAskUserQuestionResponseAtom, {
            questionId: 'question-call-3',
            toolcallId: 'call-3',
            answers: [{ item_id: 'q0', selected_option_ids: ['q0-o0'] }],
        });

        expect(sendQuestionResponseMock).toHaveBeenCalledTimes(1);
        expect(connectMock).toHaveBeenCalledTimes(2);
        // Every card has an answer on its way: the model continues in this run.
        expect(store.get(isThreadParkedAtom)).toBe(false);
    });

    it('sends an answer given before the resume shows its card again once it does', async () => {
        const { callbacks } = await resume();
        store.set(sendAskUserQuestionResponseAtom, {
            questionId: 'question-call-3',
            toolcallId: 'call-3',
            answers: [{ item_id: 'q0', selected_option_ids: ['q0-o0'] }],
        });
        expect([...store.get(parkedAnswerQueueAtom).keys()]).toEqual(['call-3']);

        callbacks.onAskUserQuestionRequest?.(question('call-3').request as any);

        expect(sendCardAnswerMock).toHaveBeenCalledWith(expect.objectContaining({
            type: 'ask_user_question_response',
            question_id: 'question-call-3',
        }));
        expect(store.get(parkedAnswerQueueAtom).size).toBe(0);
        expect(store.get(pendingQuestionsAtom).has('call-3')).toBe(false);
        expect(store.get(liveCardAnswersAtom).has('call-3')).toBe(true);
        expect(connectMock).toHaveBeenCalledTimes(2);
    });

    it('sends a table card answer given before the resume shows the card again once it does', async () => {
        const connected = nextConnection();
        await store.set(sendWSMessageAtom, 'make a table');
        const { callbacks } = await connected;
        const runId = store.get(activeRunAtom)!.id;
        streamToolCalls(callbacks, runId, ['call-1', 'call-2']);
        callbacks.onDeferredApprovalRequest?.(approval('call-1').request as any);
        callbacks.onTableCardRequest?.(tableCard('call-2').request as any);
        await finish(callbacks, runId, parked([approval('call-1'), tableCard('call-2')]));

        const resumed = nextConnection();
        store.set(sendApprovalResponseAtom, { actionId: 'action-call-1', approved: true });
        store.set(removePendingApprovalAtom, 'action-call-1');
        const { callbacks: resumeCallbacks } = await resumed;
        store.set(sendTableCardResponseAtom, { type: 'table_card_response', card_id: 'card-call-2', approved: true } as any);
        expect([...store.get(parkedAnswerQueueAtom).keys()]).toEqual(['call-2']);

        resumeCallbacks.onTableCardRequest?.(tableCard('call-2').request as any);

        expect(sendCardAnswerMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'table_card_response', card_id: 'card-call-2' }));
        expect(store.get(pendingTableCardsAtom).has('card-call-2')).toBe(false);
        expect(connectMock).toHaveBeenCalledTimes(2);
    });

    it('can be parked only once its own answers came back and it waits on a card', async () => {
        const { callbacks, resumeRunId } = await resume();
        expect(parkableRunId(store.get)).toBeNull();

        showAgain(callbacks);
        expect(parkableRunId(store.get)).toBeNull();

        await returnTool(callbacks, resumeRunId, 'call-1');
        expect(store.get(isResumeWaitingAtom)).toBe(true);
        expect(parkableRunId(store.get)).toBe(resumeRunId);

        store.set(sendApprovalResponseAtom, { actionId: 'action-call-2', approved: true });
        expect(parkableRunId(store.get)).toBeNull();
    });

    it('parks the resume before sending a message written instead', async () => {
        const { callbacks, resumeRunId } = await resume();
        showAgain(callbacks);
        await returnTool(callbacks, resumeRunId, 'call-1');
        parkRunMock.mockImplementationOnce(async () => {
            await finish(callbacks, resumeRunId, parked([approval('call-2'), question('call-3')]));
            return 'ended';
        });
        const superseding = nextConnection();

        await store.set(sendWSMessageAtom, 'something else');
        const { request } = await superseding;

        expect(parkRunMock).toHaveBeenCalledWith(resumeRunId, expect.any(Number));
        expect(store.get(threadRunsAtom).at(-1)).toMatchObject({ id: resumeRunId, status: 'parked' });
        expect(request.user_prompt.content).toBe('something else');
        expect(request.user_prompt.deferred_results).toBeUndefined();
        expect(request.expected_tail_run_id).toBe(resumeRunId);
        expect(store.get(pendingApprovalsAtom).size).toBe(0);
        expect(store.get(pendingQuestionsAtom).size).toBe(0);
    });

    it('drops a message written instead when the user leaves the chat while the resume parks', async () => {
        const { callbacks, resumeRunId } = await resume();
        showAgain(callbacks);
        await returnTool(callbacks, resumeRunId, 'call-1');
        parkRunMock.mockImplementationOnce(async () => {
            store.set(threadNavigationSeqAtom, (seq) => seq + 1);
            await finish(callbacks, resumeRunId, parked([approval('call-2'), question('call-3')]));
            return 'ended';
        });

        await store.set(sendWSMessageAtom, 'something else');

        expect(parkRunMock).toHaveBeenCalledTimes(1);
        expect(connectMock).toHaveBeenCalledTimes(2);
    });

    it('does not send a message while the resume still applies its answer', async () => {
        await resume();

        await store.set(sendWSMessageAtom, 'something else');

        expect(parkRunMock).not.toHaveBeenCalled();
        expect(connectMock).toHaveBeenCalledTimes(2);
    });

    it('leaves the cards answerable when the resume parks again', async () => {
        const { callbacks, resumeRunId } = await resume();
        showAgain(callbacks);
        await returnTool(callbacks, resumeRunId, 'call-1');

        await finish(callbacks, resumeRunId, parked([approval('call-2'), question('call-3')]));

        expect(store.get(resumeLiveCardsAtom).size).toBe(0);
        expect([...store.get(pendingApprovalsAtom).keys()]).toEqual(['action-call-2']);
        expect([...store.get(pendingQuestionsAtom).keys()]).toEqual(['call-3']);

        const next = nextConnection();
        store.set(sendAskUserQuestionResponseAtom, {
            questionId: 'question-call-3',
            toolcallId: 'call-3',
            answers: [{ item_id: 'q0', selected_option_ids: ['q0-o0'] }],
        });
        const { request } = await next;
        expect(request.user_prompt.resumes_run_id).toBe(resumeRunId);
        expect(Object.keys(request.user_prompt.deferred_results)).toEqual(['call-3']);
    });
});

describe('parkableRunId', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        connectMock.mockReset();
        isConnectedMock.mockReturnValue(true);
        store.set(sessionAtom, { user: { id: 'user-1' } } as any);
        store.set(threadRunsAtom, []);
        store.set(activeRunAtom, null);
        store.set(currentThreadIdAtom, THREAD);
        store.set(threadAdmissionAtom, { threadId: THREAD, tailRunId: null, activity: { state: 'idle', run_id: null } });
        store.set(isWSChatPendingAtom, false);
        store.set(pendingApprovalsAtom, new Map());
        store.set(pendingQuestionsAtom, new Map());
        store.set(pendingCreditConfirmationsAtom, new Map());
        store.set(clearParkedAnswersAtom);
        store.set(liveCardAnswersAtom, new Map());
    });

    async function liveRunWaitingOnACard(): Promise<string> {
        const connected = nextConnection();
        await store.set(sendWSMessageAtom, 'hello');
        const { callbacks } = await connected;
        const runId = store.get(activeRunAtom)!.id;
        callbacks.onDeferredApprovalRequest?.(approval('call-1').request as any);
        return runId;
    }

    it('names a live run waiting only on a card', async () => {
        const runId = await liveRunWaitingOnACard();

        expect(parkableRunId(store.get)).toBe(runId);
    });

    it('does not park a run waiting on a credit confirmation too', async () => {
        await liveRunWaitingOnACard();
        store.set(pendingCreditConfirmationsAtom, new Map([['confirmation-1', {} as any]]));

        expect(parkableRunId(store.get)).toBeNull();
    });

    it('does not park a run while an answer the user gave may be applying', async () => {
        await liveRunWaitingOnACard();
        store.set(sendApprovalResponseAtom, { actionId: 'action-call-1', approved: true });

        expect(parkableRunId(store.get)).toBeNull();
    });

    it('does not park a run that waits on nothing', async () => {
        const connected = nextConnection();
        await store.set(sendWSMessageAtom, 'hello');
        await connected;

        expect(parkableRunId(store.get)).toBeNull();
    });
});
