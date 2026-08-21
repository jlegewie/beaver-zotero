/**
 * Contract for the shared connect-retry loop: how many attempts it makes, which
 * failures it retries, what it tears down in between, and what it reports back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSupabase } = vi.hoisted(() => ({
    mockSupabase: {
        auth: { getSession: vi.fn(), refreshSession: vi.fn() },
    },
}));

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({ supabase: mockSupabase }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    AgentConnectionError,
    ConnectTimeoutError,
} from '@beaver/agent-core/transport/agentService';
import { setClientIdentityProvider } from '@beaver/agent-core/transport/clientIdentity';
import type { ConnectionFailureEvidence } from '@beaver/agent-core/transport/connectionFailure';
import {
    CONNECT_MAX_ATTEMPTS,
    connectWithRetry,
    type ConnectRetryProgress,
    type ConnectableAgentService,
} from '@beaver/agent-core/transport/connectWithRetry';
import type { AgentRunRequest, WSCallbacks } from '@beaver/agent-core/protocol/agentProtocol';

const request = { user_prompt: 'hello' } as unknown as AgentRunRequest;
const callbacks: WSCallbacks = {};

function evidence(
    overrides: Partial<ConnectionFailureEvidence> = {},
): ConnectionFailureEvidence {
    return {
        stage: 'opening',
        closeCode: 1006,
        closeReason: '',
        wasClean: false,
        socketOpened: false,
        readyReceived: false,
        timedOut: false,
        navigatorOnline: true,
        ...overrides,
    };
}

/** An abrupt pre-`ready` transport drop — the case worth retrying. */
function retryableFailure(closeReason = ''): AgentConnectionError {
    return new AgentConnectionError('closed before ready', evidence({ closeReason }));
}

/**
 * An attempt that never settled. It carries no close code of its own — the
 * transport tears it down with a normal close — so it is only retryable if the
 * decision reads `timedOut` rather than the code, and only reaches the decision
 * at all if the loop still recognises the subclass as a connection error.
 */
function timeoutFailure(): ConnectTimeoutError {
    return new ConnectTimeoutError(
        evidence({ stage: 'awaiting_ready', closeCode: null, socketOpened: true }),
    );
}

/**
 * The socket refused the run request. The one retryable failure that happens
 * after `ready`: the server never took the message, so there is no run to
 * duplicate by trying again.
 */
function requestNeverSentFailure(): AgentConnectionError {
    return new AgentConnectionError(
        'connection closed before the request could be sent',
        evidence({
            stage: 'mid_run',
            closeCode: null,
            socketOpened: true,
            readyReceived: true,
            requestNeverSent: true,
        }),
    );
}

/** A failed sign-in session check — never retried, it will not fix itself. */
function authFailure(): AgentConnectionError {
    return new AgentConnectionError(
        'could not check user session',
        evidence({ stage: 'auth', closeCode: null }),
    );
}

interface Harness {
    service: ConnectableAgentService;
    connect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    sleeps: number[];
    retrying: (ConnectRetryProgress | null)[];
    attempts: ConnectRetryProgress[];
    run: (
        overrides?: Partial<Parameters<typeof connectWithRetry>[0]>,
    ) => ReturnType<typeof connectWithRetry>;
}

/**
 * Drives the loop against a stubbed service, with the wait and the jitter
 * pinned so attempt counts and backoff values are exact.
 */
function harness(outcomes: (Error | null)[]): Harness {
    let index = 0;
    const connect = vi.fn(async () => {
        const outcome = outcomes[Math.min(index, outcomes.length - 1)];
        index += 1;
        if (outcome) throw outcome;
    });
    const close = vi.fn();
    const sleeps: number[] = [];
    const retrying: (ConnectRetryProgress | null)[] = [];
    const attempts: ConnectRetryProgress[] = [];
    const service = { connect, close } as unknown as ConnectableAgentService;

    return {
        service,
        connect,
        close,
        sleeps,
        retrying,
        attempts,
        run: (overrides = {}) =>
            connectWithRetry({
                service,
                request,
                callbacks,
                onAttempt: (progress) => attempts.push(progress),
                onRetrying: (progress) => retrying.push(progress),
                isAlreadyReported: () => false,
                isStillWanted: () => true,
                sleep: async (ms) => {
                    sleeps.push(ms);
                },
                random: () => 0.5,
                ...overrides,
            }),
    };
}

describe('connectWithRetry', () => {
    beforeEach(() => {
        setClientIdentityProvider(() => ({
            frontendVersion: '1.2.3',
            clientType: 'test-client',
            clientFeatures: ['citations_event'],
        }));
    });

    it('connects on the first attempt without retrying or tearing anything down', async () => {
        const h = harness([null]);

        const result = await h.run();

        expect(result).toEqual({ kind: 'connected', attemptsMade: 1 });
        expect(h.connect).toHaveBeenCalledTimes(1);
        expect(h.close).not.toHaveBeenCalled();
        expect(h.sleeps).toEqual([]);
        // The only reconnect signal on a clean connect is the clearing one, so a
        // caller that renders it never flashes a state the run was never in.
        expect(h.retrying).toEqual([null]);
        expect(h.attempts).toEqual([{ attempt: 1, maxAttempts: CONNECT_MAX_ATTEMPTS }]);
    });

    it('retries a pre-ready transport drop and reports the recovered connect', async () => {
        const h = harness([retryableFailure(), null]);

        const result = await h.run();

        expect(result).toEqual({ kind: 'connected', attemptsMade: 2 });
        expect(h.connect).toHaveBeenCalledTimes(2);
        // The failed attempt is torn down explicitly: the service's overlap
        // guard would otherwise swallow the next connect entirely.
        expect(h.close).toHaveBeenCalledTimes(1);
        expect(h.close).toHaveBeenCalledWith(1000, 'Retrying connection', {
            notifyClose: false,
        });
        expect(h.retrying).toEqual([
            { attempt: 2, maxAttempts: CONNECT_MAX_ATTEMPTS },
            null,
        ]);
        expect(h.sleeps).toEqual([125]);
    });

    it('tells the backend which attempt this is and what the last one looked like', async () => {
        const h = harness([retryableFailure('proxy closed it'), null]);

        await h.run();

        expect(h.connect.mock.calls[0][6]).toMatchObject({ connect_attempts: 1 });
        expect(h.connect.mock.calls[0][6].last_connect_failure).toBeUndefined();
        expect(h.connect.mock.calls[1][6]).toMatchObject({
            connect_attempts: 2,
            last_connect_failure: { stage: 'opening', close_code: 1006, timed_out: false },
        });
        // One timestamp for the whole run, so the backend sees the latency the
        // user waited rather than the last attempt's slice of it.
        expect(h.connect.mock.calls[1][6].connect_started_at_ms).toBe(
            h.connect.mock.calls[0][6].connect_started_at_ms,
        );
    });

    it('retries an attempt that timed out, which carries no close code', async () => {
        const h = harness([timeoutFailure(), null]);

        const result = await h.run();

        expect(result).toEqual({ kind: 'connected', attemptsMade: 2 });
        expect(h.connect).toHaveBeenCalledTimes(2);
        // The backend is told what the last attempt looked like, and a timeout
        // is only distinguishable there by this flag.
        expect(h.connect.mock.calls[1][6].last_connect_failure).toMatchObject({
            stage: 'awaiting_ready',
            close_code: null,
            timed_out: true,
        });
    });

    it('retries a request the socket refused, though it happened after ready', async () => {
        const h = harness([requestNeverSentFailure(), null]);

        const result = await h.run();

        expect(result).toEqual({ kind: 'connected', attemptsMade: 2 });
        expect(h.connect).toHaveBeenCalledTimes(2);
    });

    it('does not retry a failure that will not fix itself', async () => {
        const failure = authFailure();
        const h = harness([failure]);

        const result = await h.run();

        expect(result.kind).toBe('failed');
        expect(result).toMatchObject({ attemptsMade: 1, cause: failure });
        expect(h.connect).toHaveBeenCalledTimes(1);
        expect(h.close).not.toHaveBeenCalled();
    });

    it('gives up after the attempt budget and reports the last failure', async () => {
        const last = retryableFailure('the fourth one');
        const h = harness([
            retryableFailure('first'),
            retryableFailure('second'),
            retryableFailure('third'),
            last,
        ]);

        const result = await h.run();

        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') throw new Error('unreachable');
        expect(result.attemptsMade).toBe(CONNECT_MAX_ATTEMPTS);
        expect(h.connect).toHaveBeenCalledTimes(CONNECT_MAX_ATTEMPTS);
        // The user is told about the failure they are actually left with.
        expect(result.evidence.closeReason).toBe('the fourth one');
        expect(result.cause).toBe(last);
        // Bounded jitter, widening then holding at the last range.
        expect(h.sleeps).toEqual([125, 600, 1500]);
        expect(h.retrying[h.retrying.length - 1]).toBeNull();
    });

    it('stops without retrying when the failure has already been reported', async () => {
        const h = harness([retryableFailure(), null]);

        const result = await h.run({ isAlreadyReported: () => true });

        expect(result).toEqual({
            kind: 'abandoned',
            reason: 'already_reported',
            attemptsMade: 1,
        });
        expect(h.connect).toHaveBeenCalledTimes(1);
        expect(h.close).not.toHaveBeenCalled();
        expect(h.retrying).toEqual([null]);
    });

    it('abandons the retry when the run stopped being wanted during the backoff', async () => {
        const h = harness([retryableFailure(), null]);

        const result = await h.run({ isStillWanted: () => false });

        expect(result).toEqual({
            kind: 'abandoned',
            reason: 'superseded',
            attemptsMade: 1,
        });
        expect(h.connect).toHaveBeenCalledTimes(1);
        expect(h.sleeps).toEqual([125]);
        // The caller is released from the reconnect state it was put into just
        // before the wait.
        expect(h.retrying).toEqual([
            { attempt: 2, maxAttempts: CONNECT_MAX_ATTEMPTS },
            null,
        ]);
    });

    it('classifies a non-transport rejection as an opening failure', async () => {
        const h = harness([new TypeError('boom')]);

        const result = await h.run();

        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') throw new Error('unreachable');
        expect(result.evidence.stage).toBe('opening');
        expect(result.evidence.errorName).toBe('TypeError');
        expect(h.connect).toHaveBeenCalledTimes(1);
    });
});
