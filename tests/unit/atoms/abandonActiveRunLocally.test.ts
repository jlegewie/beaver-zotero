/**
 * Local run-abandon bookkeeping, shared by the stop button (cancel frame) and
 * the shutdown path (plain close).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cancelMock, closeMock, connectMock, isConnectedMock, reportConnectionFailureMock } =
    vi.hoisted(() => ({
        cancelMock: vi.fn().mockResolvedValue(undefined),
        closeMock: vi.fn(),
        connectMock: vi.fn(),
        isConnectedMock: vi.fn(() => true),
        reportConnectionFailureMock: vi.fn().mockResolvedValue(undefined),
    }));

vi.mock('@beaver/agent-core/transport/agentService', () => ({
    agentService: {
        cancel: cancelMock,
        close: closeMock,
        connect: connectMock,
        isConnected: isConnectedMock,
    },
    AgentConnectionError: class AgentConnectionError extends Error {
        evidence: any;
        constructor(message: string, evidence: any) {
            super(message);
            this.name = 'AgentConnectionError';
            this.evidence = evidence;
        }
    },
}));
vi.mock('@beaver/agent-core/transport/clientIdentity', () => ({
    resolveClientIdentity: vi.fn(() => ({
        frontendVersion: '0.99.1-test',
        clientType: 'zotero-plugin',
        clientFeatures: [],
    })),
}));
vi.mock('@beaver/agent-core/transport/clients/diagnosticsService', () => ({
    reportConnectionFailure: reportConnectionFailureMock,
}));
vi.mock('../../../react/atoms/applicationState', () => ({
    getApplicationStateProvider: vi.fn(() => async () => ({})),
}));
vi.mock('../../../src/services/systemNotifications', () => ({
    notifyRunComplete: vi.fn(),
    notifyUserQuestion: vi.fn(),
}));
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn(), refreshSession: vi.fn() } },
}));
vi.mock('../../../src/beaver-extract', () => ({ prewarmMuPDFWorker: vi.fn() }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { activeRunAtom, threadRunsAtom, wsReconnectingAtom } from '@beaver/agent-core/run-state/atoms';
import { pendingQuestionsAtom } from '@beaver/agent-core/run-state/pendingQuestions';
import { pendingCreditConfirmationsAtom } from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { pendingApprovalsAtom } from '../../../react/agents/agentActions';
import { runApprovalPolicyAtom } from '../../../react/atoms/runApprovalPolicy';
import { store } from '../../../react/store';
import { sessionAtom } from '../../../react/atoms/auth';
import { AgentConnectionError } from '@beaver/agent-core/transport/agentService';
import {
    abandonActiveRunLocallyAtom,
    clearClientShutDownLatch,
    approvalResponseIntentsAtom,
    closeWSConnectionAtom,
    closeWSConnectionForShutdownAtom,
    isWSChatPendingAtom,
    isWSConnectedAtom,
    isWSReadyAtom,
    sendWSMessageAtom,
    wsErrorAtom,
} from '../../../react/atoms/agentRunAtoms';

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
    return {
        id: 'run-1',
        thread_id: 'thread-1',
        status: 'in_progress',
        ...overrides,
    } as AgentRun;
}

function stagePendingCards() {
    store.set(pendingApprovalsAtom, new Map([['action-1', {} as any]]));
    store.set(pendingQuestionsAtom, new Map([['question-1', {} as any]]));
    store.set(pendingCreditConfirmationsAtom, new Map([['confirm-1', {} as any]]));
    store.set(approvalResponseIntentsAtom, new Map([['action-1', true]]));
    store.set(runApprovalPolicyAtom, {
        runId: 'run-1',
        approvedGroups: new Set(['note_edit']),
        approvedResources: new Set(['item-1']),
    });
}

function pendingCardState() {
    const policy = store.get(runApprovalPolicyAtom);
    return {
        approvals: store.get(pendingApprovalsAtom).size,
        questions: store.get(pendingQuestionsAtom).size,
        creditConfirmations: store.get(pendingCreditConfirmationsAtom).size,
        responseIntents: store.get(approvalResponseIntentsAtom).size,
        approvalPolicyRunId: policy.runId,
        approvedGroups: policy.approvedGroups.size,
        approvedResources: policy.approvedResources.size,
    };
}

/** Abrupt drop before handshake; the connect loop retries this. */
const PRE_READY_DROP = {
    stage: 'opening',
    closeCode: 1006,
    closeReason: '',
    wasClean: false,
    socketOpened: false,
    readyReceived: false,
    timedOut: false,
    navigatorOnline: true,
} as any;

const NO_PENDING_CARDS = {
    approvals: 0,
    questions: 0,
    creditConfirmations: 0,
    responseIntents: 0,
    approvalPolicyRunId: null,
    approvedGroups: 0,
    approvedResources: 0,
};

describe('abandoning the active run locally', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        store.set(activeRunAtom, null);
        store.set(threadRunsAtom, []);
        store.set(isWSChatPendingAtom, false);
        store.set(isWSConnectedAtom, false);
        store.set(isWSReadyAtom, false);
    });

    it('archives a streaming run as canceled and releases the composer', () => {
        store.set(activeRunAtom, makeRun());
        store.set(isWSChatPendingAtom, true);

        store.set(abandonActiveRunLocallyAtom);

        expect(store.get(activeRunAtom)).toBeNull();
        expect(store.get(threadRunsAtom)).toEqual([
            expect.objectContaining({ id: 'run-1', status: 'canceled' }),
        ]);
        expect(store.get(threadRunsAtom)[0].completed_at).toBeTruthy();
        expect(store.get(isWSChatPendingAtom)).toBe(false);
    });

    it('archives a run parked on a deferred approval', () => {
        store.set(activeRunAtom, makeRun({ status: 'awaiting_deferred' }));

        store.set(abandonActiveRunLocallyAtom);

        expect(store.get(activeRunAtom)).toBeNull();
        expect(store.get(threadRunsAtom)).toEqual([
            expect.objectContaining({ id: 'run-1', status: 'canceled' }),
        ]);
    });

    it('leaves a failed run in the active slot so its retry survives', () => {
        const failed = makeRun({ status: 'error' });
        store.set(activeRunAtom, failed);

        store.set(abandonActiveRunLocallyAtom);

        expect(store.get(activeRunAtom)).toBe(failed);
        expect(store.get(threadRunsAtom)).toEqual([]);
    });

    it('clears every card whose answer can no longer be delivered', () => {
        store.set(activeRunAtom, makeRun());
        stagePendingCards();

        store.set(abandonActiveRunLocallyAtom);

        expect(pendingCardState()).toEqual(NO_PENDING_CARDS);
    });

    it('does not touch the socket', () => {
        store.set(activeRunAtom, makeRun());

        store.set(abandonActiveRunLocallyAtom);

        expect(cancelMock).not.toHaveBeenCalled();
        expect(closeMock).not.toHaveBeenCalled();
    });
});

describe('closing the connection from the stop button', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        isConnectedMock.mockReturnValue(true);
        store.set(activeRunAtom, null);
        store.set(threadRunsAtom, []);
        store.set(isWSChatPendingAtom, false);
        store.set(isWSConnectedAtom, true);
        store.set(isWSReadyAtom, true);
    });

    it('still sends a cancel frame, on top of the local bookkeeping', async () => {
        store.set(activeRunAtom, makeRun());
        store.set(isWSChatPendingAtom, true);

        await store.set(closeWSConnectionAtom);

        expect(cancelMock).toHaveBeenCalledOnce();
        expect(store.get(activeRunAtom)).toBeNull();
        expect(store.get(threadRunsAtom)).toEqual([
            expect.objectContaining({ id: 'run-1', status: 'canceled' }),
        ]);
        expect(store.get(isWSChatPendingAtom)).toBe(false);
        expect(store.get(isWSConnectedAtom)).toBe(false);
        expect(store.get(isWSReadyAtom)).toBe(false);
    });
});

describe('closing the connection because the client is going away', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // clearAllMocks keeps implementations; cases below replace `close`.
        closeMock.mockReset();
        clearClientShutDownLatch();
        isConnectedMock.mockReturnValue(true);
        store.set(activeRunAtom, null);
        store.set(threadRunsAtom, []);
        store.set(isWSChatPendingAtom, false);
    });

    it('closes with 1000 and the caller\'s reason, and never cancels', () => {
        store.set(closeWSConnectionForShutdownAtom, 'Main window closed');

        expect(closeMock).toHaveBeenCalledExactlyOnceWith(1000, 'Main window closed');
        expect(cancelMock).not.toHaveBeenCalled();
    });

    it('sends the close before touching the store', () => {
        const order: string[] = [];
        closeMock.mockImplementation(() => order.push('close'));
        store.set(activeRunAtom, makeRun());
        const unsubscribe = store.sub(activeRunAtom, () => order.push('store'));

        store.set(closeWSConnectionForShutdownAtom, 'Zotero quitting');
        unsubscribe();

        expect(order).toEqual(['close', 'store']);
    });

    it('archives the run it abandons and releases the composer', () => {
        store.set(activeRunAtom, makeRun());
        store.set(isWSChatPendingAtom, true);
        stagePendingCards();

        store.set(closeWSConnectionForShutdownAtom, 'Beaver plugin shutting down');

        expect(store.get(activeRunAtom)).toBeNull();
        expect(store.get(threadRunsAtom)).toEqual([
            expect.objectContaining({ id: 'run-1', status: 'canceled' }),
        ]);
        expect(store.get(isWSChatPendingAtom)).toBe(false);
        expect(pendingCardState()).toEqual(NO_PENDING_CARDS);
    });

    it('leaves another window\'s run alone when this bundle owns nothing', () => {
        isConnectedMock.mockReturnValue(false);
        const run = makeRun();
        store.set(activeRunAtom, run);

        store.set(closeWSConnectionForShutdownAtom, 'Main window closed');

        expect(closeMock).not.toHaveBeenCalled();
        expect(cancelMock).not.toHaveBeenCalled();
        expect(store.get(activeRunAtom)).toBe(run);
    });

    it('aborts an attempt that has not finished opening', () => {
        isConnectedMock.mockReturnValue(false);
        let releaseConnect: (() => void) | null = null;
        connectMock.mockImplementation(
            () => new Promise<void>((resolve) => { releaseConnect = resolve; }),
        );
        store.set(sessionAtom, { user: { id: 'user-1' } } as any);
        const sending = store.set(sendWSMessageAtom, 'hello');

        return Promise.resolve().then(async () => {
            await new Promise((r) => setTimeout(r, 5));
            expect(connectMock).toHaveBeenCalledTimes(1);
            expect(store.get(activeRunAtom)?.status).toBe('in_progress');

            store.set(closeWSConnectionForShutdownAtom, 'Beaver plugin shutting down');

            expect(closeMock).toHaveBeenCalledWith(1000, 'Beaver plugin shutting down');
            expect(store.get(activeRunAtom)).toBeNull();
            releaseConnect?.();
            await sending;
        });
    });

    it('stops a retry loop that is only waiting out its backoff', async () => {
        isConnectedMock.mockReturnValue(false);
        connectMock.mockImplementation(async (_request: unknown, callbacks: any) => {
            callbacks.onClose?.(1006, '', false, PRE_READY_DROP);
            throw new AgentConnectionError('closed before ready', PRE_READY_DROP);
        });
        store.set(sessionAtom, { user: { id: 'user-1' } } as any);
        store.set(wsReconnectingAtom, null);
        const sending = store.set(sendWSMessageAtom, 'hello');

        // First attempt fails immediately; shortest backoff is 50ms, so the
        // loop is asleep with the next attempt already announced.
        await new Promise((r) => setTimeout(r, 10));
        expect(connectMock).toHaveBeenCalledTimes(1);
        expect(store.get(wsReconnectingAtom)).not.toBeNull();

        store.set(closeWSConnectionForShutdownAtom, 'Beaver plugin shutting down');
        await sending;

        expect(connectMock).toHaveBeenCalledTimes(1);
        expect(closeMock).toHaveBeenCalledWith(1000, 'Beaver plugin shutting down');
        expect(store.get(activeRunAtom)).toBeNull();
        expect(store.get(isWSChatPendingAtom)).toBe(false);
        expect(store.get(wsReconnectingAtom)).toBeNull();
    });

    it('reports nothing when the close reaches a run still in flight', async () => {
        let closeCallbacks: any = null;
        connectMock.mockImplementation(async (_request: unknown, callbacks: any) => {
            closeCallbacks = callbacks;
        });
        store.set(sessionAtom, { user: { id: 'user-1' } } as any);
        store.set(wsErrorAtom, null);
        await store.set(sendWSMessageAtom, 'hello');
        expect(closeCallbacks).not.toBeNull();
        // Past handshake, a close is no longer a connect-phase failure.
        store.set(isWSReadyAtom, true);
        expect(store.get(activeRunAtom)?.status).toBe('in_progress');

        // Real `close()` notifies with three args and no evidence.
        let notified = 0;
        closeMock.mockImplementation((code: number, reason: string) => {
            notified += 1;
            closeCallbacks.onClose(code, reason, true);
        });

        store.set(closeWSConnectionForShutdownAtom, 'Main window closed');

        expect(closeMock).toHaveBeenCalledExactlyOnceWith(1000, 'Main window closed');
        expect(notified).toBe(1);
        expect(store.get(wsErrorAtom)).toBeNull();
        expect(reportConnectionFailureMock).not.toHaveBeenCalled();
        // Archived, not just dropped: `onClose` only clears completed runs.
        expect(store.get(activeRunAtom)).toBeNull();
        expect(store.get(threadRunsAtom)).toEqual([
            expect.objectContaining({ status: 'canceled' }),
        ]);
    });
});

describe('after the client has been told to go away', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        closeMock.mockReset();
        connectMock.mockReset();
        clearClientShutDownLatch();
        store.set(activeRunAtom, null);
        store.set(threadRunsAtom, []);
        store.set(isWSChatPendingAtom, false);
    });

    it('does not connect for a run that was still being prepared', async () => {
        isConnectedMock.mockReturnValue(false);
        connectMock.mockResolvedValue(undefined);
        store.set(sessionAtom, { user: { id: 'user-1' } } as any);

        store.set(closeWSConnectionForShutdownAtom, 'Beaver plugin shutting down');
        expect(closeMock).not.toHaveBeenCalled();

        await store.set(sendWSMessageAtom, 'hello');

        expect(connectMock).not.toHaveBeenCalled();
        expect(store.get(activeRunAtom)).toBeNull();
        expect(store.get(isWSChatPendingAtom)).toBe(false);
    });
});
