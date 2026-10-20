/**
 * What the reader sees while a run is picked up on a new socket.
 *
 * While the run is reattaching nothing ends: the streamed answer, the approval
 * cards, the composer lock and the chat writer all stay, and the run says it is
 * reconnecting. If the reattach fails, the run ends exactly as the original
 * loss would have ended it, with Continue offered when the server says it has
 * already saved the run.
 *
 * The transport is a stand-in that hands back the callbacks the run was
 * started with; the atoms, the store and the retry loop are the real thing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionFailureEvidence } from '@beaver/agent-core/transport/connectionFailure';

const {
    connectMock,
    closeMock,
    failReattachMock,
    isReattachingMock,
    reattachAttemptMock,
    resolveClientIdentityMock,
    reportConnectionFailureMock,
} =
    vi.hoisted(() => ({
        connectMock: vi.fn(),
        closeMock: vi.fn(),
        failReattachMock: vi.fn(),
        isReattachingMock: vi.fn(() => false),
        reattachAttemptMock: vi.fn((): unknown => null),
        resolveClientIdentityMock: vi.fn(),
        reportConnectionFailureMock: vi.fn().mockResolvedValue(undefined),
    }));

vi.mock('@beaver/agent-core/transport/agentService', () => ({
    agentService: {
        connect: connectMock,
        close: closeMock,
        failReattach: failReattachMock,
        isReattaching: isReattachingMock,
        reattachAttempt: reattachAttemptMock,
        cancel: vi.fn(),
        cancelHandoff: () => null,
        canLeaveRun: () => false,
        leaveRun: () => false,
    },
    AgentConnectionError: class AgentConnectionError extends Error {
        evidence: ConnectionFailureEvidence;
        constructor(message: string, evidence: ConnectionFailureEvidence) {
            super(message);
            this.evidence = evidence;
        }
    },
}));
vi.mock('@beaver/agent-core/transport/clientIdentity', () => ({
    resolveClientIdentity: resolveClientIdentityMock,
}));
vi.mock('@beaver/agent-core/transport/clients/diagnosticsService', () => ({
    reportConnectionFailure: reportConnectionFailureMock,
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

import { activeRunAtom, wsReconnectingAtom } from '@beaver/agent-core/run-state/atoms';
import type { WSCallbacks } from '@beaver/agent-core/protocol/agentProtocol';
import { store } from '../../../react/store';
import {
    abandonActiveRunLocallyAtom,
    isRunReconnectingAtom,
    isWSChatPendingAtom,
    isWSReadyAtom,
    sendWSMessageAtom,
    wsErrorAtom,
} from '../../../react/atoms/agentRunAtoms';
import { pendingApprovalsAtom } from '../../../react/agents/agentActions';
import { sessionAtom } from '../../../react/atoms/auth';
import { agentService } from '@beaver/agent-core/transport/agentService';
import { currentThreadIdAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import {
    closeWSConnectionAtom,
    regenerateFromRunAtom,
    resumeFromRunAtom,
} from '../../../react/atoms/agentRunAtoms';
import { threadAdmissionAtom } from '../../../react/runtime/threadAdmission';
import { reattachResolutionAtom } from '@beaver/agent-core/run-state/runResolution';
import { popupMessagesAtom } from '../../../react/atoms/ui';

const DROP: ConnectionFailureEvidence = {
    stage: 'mid_run',
    closeCode: 1006,
    closeReason: '',
    wasClean: false,
    socketOpened: true,
    readyReceived: true,
    timedOut: false,
    navigatorOnline: true,
};

/** Start a run and return the callbacks the transport was given. */
async function startRun(): Promise<WSCallbacks> {
    let callbacks: WSCallbacks | null = null;
    connectMock.mockImplementation(async (_request: unknown, given: WSCallbacks) => {
        callbacks = given;
    });
    await store.set(sendWSMessageAtom, 'hello');
    if (!callbacks) throw new Error('Expected the run to connect');
    store.set(isWSReadyAtom, true);
    (callbacks as WSCallbacks).onDeferredApprovalRequest?.({
        event: 'deferred_approval_request',
        action_id: 'action-1',
        toolcall_id: 'call-1',
        action_type: 'edit_metadata',
        action_data: {},
    } as any);
    return callbacks;
}

function dropConnection(callbacks: WSCallbacks): void {
    callbacks.onReattaching?.({
        runId: store.get(activeRunAtom)!.id,
        cancelRequested: false,
        detachedAt: DETACHED_AT,
        graceMs: 120_000,
    });
}

const DETACHED_AT = 1_700_000_000_000;

describe('a run reattaching after its connection dropped', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        isReattachingMock.mockReturnValue(false);
        reattachAttemptMock.mockReturnValue(null);
        reportConnectionFailureMock.mockResolvedValue(undefined);
        resolveClientIdentityMock.mockReturnValue({
            frontendVersion: '0.99.1-test',
            clientType: 'zotero-plugin',
            clientFeatures: [],
        });
        store.set(wsErrorAtom, null);
        store.set(wsReconnectingAtom, null);
        store.set(isWSChatPendingAtom, false);
        store.set(isWSReadyAtom, false);
        store.set(pendingApprovalsAtom, new Map());
        store.set(sessionAtom, { user: { id: 'user-1' } } as any);
    });

    it('keeps the run, its cards and the composer lock while it reconnects', async () => {
        const callbacks = await startRun();
        const runId = store.get(activeRunAtom)!.id;
        // The transport keeps the run waiting, so the loop does not give up.
        isReattachingMock.mockReturnValue(true);

        dropConnection(callbacks);

        expect(store.get(activeRunAtom)).toMatchObject({ id: runId, status: 'in_progress' });
        expect(store.get(pendingApprovalsAtom).has('action-1')).toBe(true);
        expect(store.get(isWSChatPendingAtom)).toBe(true);
        expect(store.get(wsErrorAtom)).toBeNull();
        // Timed from the loss, so a blip stays hidden and the copy escalates.
        expect(store.get(wsReconnectingAtom)).toMatchObject({ since: DETACHED_AT, graceMs: 120_000 });
        expect(store.get(isRunReconnectingAtom)).toBe(true);
        // Nothing has failed yet, so nothing is reported yet.
        expect(reportConnectionFailureMock).not.toHaveBeenCalled();

        isReattachingMock.mockReturnValue(false);
    });

    it('clears the reconnecting state and reports the drop as recovered once reattached', async () => {
        const callbacks = await startRun();
        const runId = store.get(activeRunAtom)!.id;
        dropConnection(callbacks);

        callbacks.onReattached?.({ runId, evidence: DROP, gapMs: 1200, replayed: 4 });

        expect(store.get(wsReconnectingAtom)).toBeNull();
        expect(store.get(isWSReadyAtom)).toBe(true);
        expect(store.get(activeRunAtom)).toMatchObject({ id: runId, status: 'in_progress' });
        expect(store.get(pendingApprovalsAtom).has('action-1')).toBe(true);
        expect(reportConnectionFailureMock).toHaveBeenCalledWith(
            expect.objectContaining({ run_id: runId, reattach_outcome: 'reattached', reattach_gap_ms: 1200 }),
        );
    });

    it('ends the run with the usual error and offers Continue when the server saved it', async () => {
        const callbacks = await startRun();
        const runId = store.get(activeRunAtom)!.id;
        dropConnection(callbacks);

        callbacks.onReattachFailed?.({ runId, reason: 'expired', evidence: DROP, gapMs: 3000 });

        expect(store.get(wsReconnectingAtom)).toBeNull();
        expect(store.get(isWSChatPendingAtom)).toBe(false);
        expect(store.get(pendingApprovalsAtom).size).toBe(0);
        expect(store.get(activeRunAtom)).toMatchObject({
            id: runId,
            status: 'error',
            error: { type: 'connection_error', is_retryable: true, is_resumable: true },
        });
        expect(reportConnectionFailureMock).toHaveBeenCalledWith(
            expect.objectContaining({ run_id: runId, reattach_outcome: 'fallback:expired', reattach_gap_ms: 3000 }),
        );
    });

    it('ends the run with the usual error when the client gave up', async () => {
        const callbacks = await startRun();
        const runId = store.get(activeRunAtom)!.id;
        dropConnection(callbacks);

        callbacks.onReattachFailed?.({ runId, reason: 'gave_up', evidence: DROP, gapMs: 120_000 });

        const run = store.get(activeRunAtom)!;
        expect(run.status).toBe('error');
        expect(run.error?.type).toBe('connection_error');
        expect(run.error?.is_resumable).toBeUndefined();
        expect(reportConnectionFailureMock).toHaveBeenCalledWith(
            expect.objectContaining({ reattach_outcome: 'gave_up' }),
        );
    });

    it('still reports the loss of a run the user stopped while it was reconnecting', async () => {
        const callbacks = await startRun();
        const runId = store.get(activeRunAtom)!.id;
        dropConnection(callbacks);
        // Stop: the run leaves this window, and its callbacks stop writing.
        store.set(abandonActiveRunLocallyAtom);
        reportConnectionFailureMock.mockClear();

        callbacks.onReattached?.({ runId, evidence: DROP, gapMs: 900, replayed: 0 });

        expect(reportConnectionFailureMock).toHaveBeenCalledWith(
            expect.objectContaining({ run_id: runId, reattach_outcome: 'reattached' }),
        );
        expect(store.get(isWSReadyAtom)).toBe(false);
    });

    it('still reports a failed reattach of a run the user stopped', async () => {
        const callbacks = await startRun();
        const runId = store.get(activeRunAtom)!.id;
        dropConnection(callbacks);
        store.set(abandonActiveRunLocallyAtom);
        reportConnectionFailureMock.mockClear();

        callbacks.onReattachFailed?.({ runId, reason: 'not_found', evidence: DROP, gapMs: 700 });

        expect(reportConnectionFailureMock).toHaveBeenCalledWith(
            expect.objectContaining({ run_id: runId, reattach_outcome: 'fallback:not_found', reattach_gap_ms: 700 }),
        );
    });

    it('keeps reaching a stopped run so the server hears the cancel', async () => {
        const callbacks = await startRun();
        const runId = store.get(activeRunAtom)!.id;
        store.set(abandonActiveRunLocallyAtom);
        isReattachingMock.mockReturnValue(true);
        reattachAttemptMock.mockReturnValue({
            request: { type: 'reattach', run_id: runId, reattach_token: 'token', last_seq: 0 },
            callbacks,
        });
        connectMock.mockClear();
        connectMock.mockResolvedValue(undefined);

        callbacks.onReattaching?.({ runId, cancelRequested: true });

        await vi.waitFor(() => expect(connectMock.mock.calls[0]?.[0]).toMatchObject({ type: 'reattach', run_id: runId }));
        isReattachingMock.mockReturnValue(false);
    });

    it('gives the run up when the reattach loop stops without reaching the server', async () => {
        const callbacks = await startRun();
        const runId = store.get(activeRunAtom)!.id;

        // The transport no longer has the run waiting, so the loop stops at once.
        dropConnection(callbacks);
        await vi.waitFor(() => expect(failReattachMock).toHaveBeenCalledWith(runId, 'gave_up'));
    });

    describe('what the user can do while it reconnects', () => {
        beforeEach(() => {
            store.set(currentThreadIdAtom, null);
            store.set(threadRunsAtom, []);
            store.set(threadAdmissionAtom, null);
        });

        it('does not retry or continue a run, which would stop the reconnecting one', async () => {
            const callbacks = await startRun();
            const run = store.get(activeRunAtom)!;
            isReattachingMock.mockReturnValue(true);
            dropConnection(callbacks);
            expect(store.get(isRunReconnectingAtom)).toBe(true);

            await store.set(regenerateFromRunAtom, { runId: run.id });
            await store.set(resumeFromRunAtom, run.id);

            expect(agentService.cancel).not.toHaveBeenCalled();
            expect(store.get(activeRunAtom)).toMatchObject({ id: run.id, status: 'in_progress' });
            expect(store.get(isWSChatPendingAtom)).toBe(true);
            isReattachingMock.mockReturnValue(false);
        });

        it('waits for the server to confirm a stop made while reconnecting', async () => {
            const callbacks = await startRun();
            const run = store.get(activeRunAtom)!;
            store.set(currentThreadIdAtom, 'thread-1');
            isReattachingMock.mockReturnValue(true);
            dropConnection(callbacks);

            await store.set(closeWSConnectionAtom);

            expect(agentService.cancel).toHaveBeenCalled();
            expect(store.get(threadRunsAtom).at(-1)).toMatchObject({ id: run.id, status: 'canceled' });
            expect(store.get(threadAdmissionAtom)).toMatchObject({
                threadId: 'thread-1',
                activity: { state: 'unknown' },
                reason: 'stop_unconfirmed',
            });
            isReattachingMock.mockReturnValue(false);
        });

        it('does not wait again once the server settled a stopped run before the reattach', async () => {
            const callbacks = await startRun();
            const run = store.get(activeRunAtom)!;
            store.set(currentThreadIdAtom, 'thread-1');
            isReattachingMock.mockReturnValue(true);
            dropConnection(callbacks);
            await store.set(closeWSConnectionAtom);
            isReattachingMock.mockReturnValue(false);
            // The poller found the server idle and loaded what it saved.
            store.set(threadAdmissionAtom, {
                threadId: 'thread-1',
                tailRunId: run.id,
                activity: { state: 'idle', run_id: null },
            });

            callbacks.onReattached?.({ runId: run.id, evidence: DROP, gapMs: 900, replayed: 0 });

            expect(store.get(threadAdmissionAtom)?.activity.state).toBe('idle');
        });

        it('warns when a new message replaced a stopped run before its stop got through', async () => {
            store.set(popupMessagesAtom, []);
            const callbacks = await startRun();

            callbacks.onPreviousRunNotStopped?.('stopped-run');

            expect(store.get(popupMessagesAtom)).toEqual([
                expect.objectContaining({ type: 'warning', title: 'Stop not confirmed' }),
            ]);
        });

        it('does not block the chat after an ordinary stop', async () => {
            await startRun();
            store.set(currentThreadIdAtom, 'thread-1');

            await store.set(closeWSConnectionAtom);

            expect(store.get(threadAdmissionAtom)).toBeNull();
        });

        it('checks with the server after a failed reattach', async () => {
            const callbacks = await startRun();
            const runId = store.get(activeRunAtom)!.id;
            store.set(currentThreadIdAtom, 'thread-1');
            dropConnection(callbacks);

            callbacks.onReattachFailed?.({ runId, reason: 'not_found', evidence: DROP, gapMs: 500 });

            expect(store.get(threadAdmissionAtom)).toMatchObject({
                threadId: 'thread-1',
                activity: { state: 'unknown' },
                reason: 'reattach_failed',
            });
            // The run shows "checking" rather than its error meanwhile.
            expect(store.get(reattachResolutionAtom)).toMatchObject({ threadId: 'thread-1', runId });
        });

        it('does not resolve a stopped run as a failed reattach', async () => {
            store.set(reattachResolutionAtom, null);
            const callbacks = await startRun();
            store.set(currentThreadIdAtom, 'thread-1');
            isReattachingMock.mockReturnValue(true);
            dropConnection(callbacks);
            await store.set(closeWSConnectionAtom);
            expect(store.get(threadAdmissionAtom)?.reason).toBe('stop_unconfirmed');
            expect(store.get(reattachResolutionAtom)).toBeNull();
            isReattachingMock.mockReturnValue(false);
        });
    });
});
