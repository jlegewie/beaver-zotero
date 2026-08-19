/**
 * The composer lock across a quietly retried connect.
 *
 * The lock is what keeps the composer blocked while a run is in flight, and a
 * retried connect is the one situation where it changes hands: the failing
 * socket's own close releases it on the way out, so every retry has to put it
 * back, and whichever way the loop finally stops has to release it exactly once.
 * A lock left down opens the composer over a run that is still going; a lock
 * left up blocks it with no run to finish and no error to explain itself.
 *
 * The transport is replaced with one that fails the way a pre-`ready` drop does
 * — announcing the close first, then rejecting — because announcing it is what
 * releases the lock. Everything else, including the retry loop and the classifier
 * that decides the failure is worth retrying, is the real thing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionFailureEvidence } from '@beaver/agent-core/transport/connectionFailure';

const { connectMock, closeMock, resolveClientIdentityMock, reportConnectionFailureMock } =
    vi.hoisted(() => ({
        connectMock: vi.fn(),
        closeMock: vi.fn(),
        resolveClientIdentityMock: vi.fn(),
        reportConnectionFailureMock: vi.fn().mockResolvedValue(undefined),
    }));

// A stand-in for the service, and a stand-in class that the retry loop's
// `instanceof` check still narrows against: the mocked specifier and the loop's
// own relative import resolve to one module, so both see this same class.
vi.mock('@beaver/agent-core/transport/agentService', () => ({
    agentService: { connect: connectMock, close: closeMock },
    AgentConnectionError: class AgentConnectionError extends Error {
        evidence: ConnectionFailureEvidence;
        constructor(message: string, evidence: ConnectionFailureEvidence) {
            super(message);
            this.name = 'AgentConnectionError';
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
    notifyRunComplete: vi.fn(),
    notifyUserQuestion: vi.fn(),
}));
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn(), refreshSession: vi.fn() } },
}));
vi.mock('../../../src/beaver-extract', () => ({ prewarmMuPDFWorker: vi.fn() }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { AgentConnectionError } from '@beaver/agent-core/transport/agentService';
import { activeRunAtom, wsReconnectingAtom } from '@beaver/agent-core/run-state/atoms';
import { store } from '../../../react/store';
import {
    isWSChatPendingAtom,
    isWSReadyAtom,
    sendWSMessageAtom,
    wsErrorAtom,
} from '../../../react/atoms/agentRunAtoms';
import { sessionAtom } from '../../../react/atoms/auth';

/** An abrupt drop before the handshake finished — the case worth retrying. */
const PRE_READY_DROP: ConnectionFailureEvidence = {
    stage: 'opening',
    closeCode: 1006,
    closeReason: '',
    wasClean: false,
    socketOpened: false,
    readyReceived: false,
    timedOut: false,
    navigatorOnline: true,
};

/** The same drop, after the run was under way — never retried, always reported. */
const MID_RUN_DROP: ConnectionFailureEvidence = {
    ...PRE_READY_DROP,
    stage: 'mid_run',
    socketOpened: true,
    readyReceived: true,
};

/** The lock as each attempt found it, which is the whole point of the file. */
let lockOnEntry: boolean[] = [];

/** Fail every attempt the way the transport does, optionally acting first. */
function failEveryAttempt(beforeThrow?: (attempt: number) => void): void {
    let attempt = 0;
    connectMock.mockImplementation(async (_request: unknown, callbacks: any) => {
        attempt += 1;
        lockOnEntry.push(store.get(isWSChatPendingAtom));
        // The close arrives first and releases the lock, exactly as the socket's
        // own close event does.
        callbacks.onClose?.(1006, '', false, PRE_READY_DROP);
        beforeThrow?.(attempt);
        throw new AgentConnectionError('connection closed before ready', PRE_READY_DROP);
    });
}

describe('what a connection reports about how it was opened', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        lockOnEntry = [];
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
        store.set(sessionAtom, { user: { id: 'user-1' } } as any);
    });

    it('names the attempts that opened it when it later drops mid-run', async () => {
        // A drop after `ready` has no attempt count of its own: the connection it
        // lost is the one that succeeded, so the number that describes it is the
        // number that got it open. The count is only known once the connect has
        // settled, which is why it is read when the report is made rather than
        // captured when the callbacks are built.
        let lastCallbacks: any = null;
        let attempt = 0;
        connectMock.mockImplementation(async (_request: unknown, callbacks: any) => {
            attempt += 1;
            lastCallbacks = callbacks;
            if (attempt >= 3) return;
            callbacks.onClose?.(1006, '', false, PRE_READY_DROP);
            throw new AgentConnectionError('connection closed before ready', PRE_READY_DROP);
        });

        await store.set(sendWSMessageAtom, 'hello');
        expect(attempt).toBe(3);
        // Nothing was reported for the two failures the client recovered from.
        expect(reportConnectionFailureMock).not.toHaveBeenCalled();

        // Now that connection drops, with the run under way.
        store.set(isWSReadyAtom, true);
        lastCallbacks.onClose?.(1006, '', false, MID_RUN_DROP);

        expect(reportConnectionFailureMock).toHaveBeenCalledTimes(1);
        expect(reportConnectionFailureMock.mock.calls[0][0]).toMatchObject({
            connect_attempts: 3,
            evidence: { stage: 'mid_run' },
        });
    }, 15000);
});

describe('the composer lock across a retried connect', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        lockOnEntry = [];
        reportConnectionFailureMock.mockResolvedValue(undefined);
        resolveClientIdentityMock.mockReturnValue({
            frontendVersion: '0.99.1-test',
            clientType: 'zotero-plugin',
            clientFeatures: [],
        });
        store.set(wsErrorAtom, null);
        store.set(wsReconnectingAtom, null);
        store.set(isWSChatPendingAtom, false);
        store.set(sessionAtom, { user: { id: 'user-1' } } as any);
    });

    it('holds the lock through every retry, and releases it when the attempts run out', async () => {
        failEveryAttempt();

        await store.set(sendWSMessageAtom, 'hello');

        // Every attempt began with the composer still blocked. Attempts after the
        // first can only say that because the retry put the lock back after the
        // failed attempt's close took it away.
        expect(lockOnEntry).toEqual([true, true, true, true]);
        // And the reader gets the composer back, with an error explaining why.
        expect(store.get(isWSChatPendingAtom)).toBe(false);
        expect(store.get(wsErrorAtom)?.type).toBe('connection_error');
        expect(store.get(wsReconnectingAtom)).toBeNull();
    }, 15000);

    it('releases the lock for a failure that never got as far as a close', async () => {
        // Not every failure comes from a socket: this one is refused before there
        // is anything to close, so nothing releases the lock on the way out and
        // the loop's own ending is the only thing that can. It is also not a
        // transport failure, so it is never retried.
        connectMock.mockImplementation(async () => {
            lockOnEntry.push(store.get(isWSChatPendingAtom));
            throw new TypeError('refused before opening');
        });

        await store.set(sendWSMessageAtom, 'hello');

        expect(lockOnEntry).toEqual([true]);
        expect(store.get(isWSChatPendingAtom)).toBe(false);
        expect(store.get(wsErrorAtom)?.type).toBe('connection_error');
    }, 15000);

    it('leaves a newer run\'s lock and reconnect state alone when it gives up', async () => {
        // Another run takes over while this one's first attempt is failing, so by
        // the time this loop wakes from its backoff the connection state it was
        // about to write describes someone else's run. Writing anyway would open
        // the composer over a run that is still going, and clear a reconnect that
        // run is in the middle of.
        failEveryAttempt((attempt) => {
            if (attempt !== 1) return;
            store.set(activeRunAtom, {
                id: 'run-taking-over',
                status: 'in_progress',
            } as any);
            store.set(isWSChatPendingAtom, true);
            store.set(wsReconnectingAtom, { attempt: 2, maxAttempts: 4 });
        });

        await store.set(sendWSMessageAtom, 'hello');

        expect(connectMock).toHaveBeenCalledTimes(1);
        expect(store.get(isWSChatPendingAtom)).toBe(true);
        expect(store.get(wsReconnectingAtom)).toEqual({ attempt: 2, maxAttempts: 4 });
    }, 15000);

    it('leaves a newer run\'s lock alone when it gives up for good', async () => {
        // An attempt can be in flight for twenty seconds, so a run that starts in
        // that window has already raised the lock for itself before this loop
        // finds out its own attempt failed. Every attempt fails here, so the loop
        // ends by reporting rather than abandoning — the path that has to refuse
        // to release the lock just the same.
        failEveryAttempt((attempt) => {
            if (attempt !== 4) return;
            store.set(activeRunAtom, {
                id: 'run-taking-over',
                status: 'in_progress',
            } as any);
            store.set(isWSChatPendingAtom, true);
        });

        await store.set(sendWSMessageAtom, 'hello');

        expect(connectMock).toHaveBeenCalledTimes(4);
        expect(store.get(isWSChatPendingAtom)).toBe(true);
    }, 15000);

    it('releases the lock when the run stops being active mid-retry', async () => {
        // The run goes away while the first attempt is failing, so the loop
        // abandons after its backoff instead of trying again. Nothing downstream
        // ends a run that is already gone, so this path owes the release itself.
        failEveryAttempt((attempt) => {
            if (attempt === 1) store.set(activeRunAtom, null);
        });

        await store.set(sendWSMessageAtom, 'hello');

        expect(connectMock).toHaveBeenCalledTimes(1);
        expect(store.get(isWSChatPendingAtom)).toBe(false);
        expect(store.get(wsReconnectingAtom)).toBeNull();
        // Abandoned quietly: the run it belonged to is not there to be told about.
        expect(store.get(wsErrorAtom)).toBeNull();
    }, 15000);
});
