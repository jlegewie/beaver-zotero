/**
 * Automatic retry of a failed pre-`ready` connect attempt, shared by every
 * client that opens an agent connection.
 *
 * A cold-starting backend instance, a scale event, or a momentary network block
 * routinely produces a connect failure that succeeds on the next attempt, so
 * retrying quietly before anything reaches the user is the difference between a
 * run that starts a moment late and a run that fails. Only failures that cannot
 * have started a run on the server are retried — `isRetryablePreReadyConnectFailure`
 * owns that decision, and auth failures and application-level rejections are
 * excluded because they will not fix themselves.
 *
 * This module owns the loop and nothing else: attempt counting, per-attempt
 * identity resolution, the retryability decision, the teardown between
 * attempts, the jittered backoff, and the checks that abandon a run that
 * stopped being the caller's business. It surfaces no errors and writes no
 * client state — it returns a result and the caller decides what the user sees.
 */

import { logger } from '../platform/logger';
import { isReattachRequest } from '../protocol/agentProtocol';
import type { AgentConnectRequest, ExtractSchemaVersionsWire, WSCallbacks, WSReattachRequest, ZoteroInstanceWire } from '../protocol/agentProtocol';
import { resolveClientIdentity } from './clientIdentity';
import { AgentConnectionError } from './agentService';
import {
    baselineConnectionEvidence,
    connectRecoveryAuthFields,
    isRetryablePreReadyConnectFailure,
    type ConnectionFailureEvidence,
    type ConnectRecoveryAuthFields,
} from './connectionFailure';

/** Total connect attempts per run (initial attempt + automatic retries). */
export const CONNECT_MAX_ATTEMPTS = 4;

/** Bounded-jitter backoff ranges before the 2nd, 3rd, and 4th attempts. */
const CONNECT_RETRY_BACKOFF_MS = [
    { min: 50, max: 200 },
    { min: 200, max: 1000 },
    { min: 500, max: 2500 },
];

/**
 * The subset of `AgentService` this loop is allowed to touch, declared
 * structurally so the loop cannot reach the rest of the class and a test can
 * drive it with a stub. The signatures match `AgentService` exactly.
 */
export interface ConnectableAgentService {
    connect(
        request: AgentConnectRequest,
        callbacks: WSCallbacks,
        frontendVersion?: string,
        clientType?: string,
        clientFeatures?: string[],
        zoteroInstance?: ZoteroInstanceWire,
        connectRecovery?: ConnectRecoveryAuthFields,
        extractSchemaVersions?: ExtractSchemaVersionsWire,
    ): Promise<void>;
    close(
        code?: number,
        reason?: string,
        options?: { notifyClose?: boolean; onlyIfConnectionId?: number; keepDetachedRun?: boolean },
    ): void;
}

/**
 * Which attempt is about to run, out of how many the loop will make.
 *
 * Shaped to be assignable to the reconnect state a client renders, so a caller
 * can hand a progress report straight to its store without restating it.
 */
export interface ConnectRetryProgress {
    attempt: number;
    maxAttempts: number;
}

export type ConnectWithRetryResult =
    | { kind: 'connected'; attemptsMade: number }
    | { kind: 'abandoned'; reason: 'already_reported' | 'superseded'; attemptsMade: number }
    | {
          kind: 'failed';
          attemptsMade: number;
          evidence: ConnectionFailureEvidence;
          cause: unknown;
      };

export interface ConnectWithRetryOptions {
    service: ConnectableAgentService;
    request: AgentConnectRequest;
    callbacks: WSCallbacks;
    /** Called before each attempt, including the first. */
    onAttempt?: (progress: ConnectRetryProgress) => void;
    /**
     * Called with the next attempt's progress just before the backoff wait, and
     * with `null` on every exit from this function — so a caller that renders a
     * "reconnecting" state can never be left showing a stale one.
     */
    onRetrying: (progress: ConnectRetryProgress | null) => void;
    /**
     * Whether something else has already ended and reported this failure — an
     * application-level error event, a cancel. True stops the loop without
     * retrying and without classifying: the user already has an account of what
     * went wrong, and a failure that was reported at the application level will
     * not fix itself.
     */
    isAlreadyReported: () => boolean;
    /**
     * Whether the run is still the caller's business, checked after the backoff
     * wait. False means it was cancelled, replaced, or rolled back while the
     * loop was waiting, so the next attempt would connect for nothing.
     */
    isStillWanted: () => boolean;
    /**
     * What this connection is for, prefixed onto the loop's own log lines. A
     * retry burst is exactly when a log gets read, and without it the attempts
     * cannot be tied to the run that paid for them.
     */
    logLabel?: string;
    /** Test seam for the backoff wait. */
    sleep?: (ms: number) => Promise<void>;
    /** Test seam for the backoff jitter. */
    random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Connect, retrying a transient pre-`ready` failure with jittered backoff.
 *
 * Resolves once the outcome is decided; it never throws for a connect failure,
 * which arrives as a `failed` result carrying the evidence the caller needs to
 * describe it.
 */
export async function connectWithRetry(
    options: ConnectWithRetryOptions,
): Promise<ConnectWithRetryResult> {
    const {
        service,
        request,
        callbacks,
        onAttempt,
        onRetrying,
        isAlreadyReported,
        isStillWanted,
        logLabel,
        sleep = defaultSleep,
        random = Math.random,
    } = options;

    // Not an option: the budget and the backoff table below are one policy, and
    // a caller that could raise the count without extending the table would
    // silently reuse the last range for every extra attempt.
    const maxAttempts = CONNECT_MAX_ATTEMPTS;
    const prefix = logLabel ? `connectWithRetry (${logLabel}):` : 'connectWithRetry:';
    let lastFailure: unknown = null;
    let attemptsMade = 0;
    // One timestamp for the whole run, so the backend sees how long the client
    // spent connecting across every attempt rather than just the last one.
    const connectStartedAtMs = Date.now();

    try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            attemptsMade = attempt;
            try {
                logger(`${prefix} connect attempt ${attempt}/${maxAttempts}`);
                onAttempt?.({ attempt, maxAttempts });
                // Resolved fresh for this attempt (not cached) — the identity a
                // handshake reports can change between reconnects.
                const identity = resolveClientIdentity();
                const recovery = connectRecoveryAuthFields(
                    attemptsMade,
                    lastFailure instanceof AgentConnectionError ? lastFailure.evidence : null,
                    connectStartedAtMs,
                );
                // connect() applies its own attempt-scoped backstop timeout, so
                // this await cannot hang forever.
                await service.connect(
                    request,
                    callbacks,
                    identity.frontendVersion,
                    identity.clientType,
                    identity.clientFeatures,
                    identity.zoteroInstance,
                    recovery,
                    identity.extractSchemaVersions,
                );
                logger(`${prefix} connect settled`);
                return { kind: 'connected', attemptsMade };
            } catch (error: unknown) {
                logger(`${prefix} connect attempt ${attempt}/${maxAttempts} failed:`, error, 1);
                lastFailure = error;

                // Both abandon paths are left for the caller to log: it knows
                // what it is abandoning and why that matters, and a line here
                // would only say the same thing with less of it.
                if (isAlreadyReported()) {
                    return { kind: 'abandoned', reason: 'already_reported', attemptsMade };
                }

                const retryable =
                    attempt < maxAttempts &&
                    error instanceof AgentConnectionError &&
                    isRetryablePreReadyConnectFailure(error.evidence);
                if (!retryable) break;

                // Fully tear down the failed attempt so AgentService's overlap
                // guard cannot swallow the next connect (a no-op when the
                // failure path already reset the connection state).
                // A run waiting to be reattached stays waiting.
                service.close(1000, 'Retrying connection', {
                    notifyClose: false,
                    ...(isReattachRequest(request) ? { keepDetachedRun: true } : {}),
                });
                onRetrying({ attempt: attempt + 1, maxAttempts });

                const backoffRange = CONNECT_RETRY_BACKOFF_MS[
                    Math.min(attempt - 1, CONNECT_RETRY_BACKOFF_MS.length - 1)
                ];
                await sleep(
                    backoffRange.min + random() * (backoffRange.max - backoffRange.min),
                );

                if (!isStillWanted()) {
                    return { kind: 'abandoned', reason: 'superseded', attemptsMade };
                }
            }
        }

        const evidence =
            lastFailure instanceof AgentConnectionError
                ? lastFailure.evidence
                : baselineConnectionEvidence('opening', {
                      errorName: lastFailure instanceof Error ? lastFailure.name : 'UnknownError',
                  });
        return { kind: 'failed', attemptsMade, evidence, cause: lastFailure };
    } finally {
        onRetrying(null);
    }
}

// =============================================================================
// Reattaching a run after its socket was lost
// =============================================================================

/**
 * The part of `AgentService` the reattach loop uses on top of connecting,
 * declared structurally so a test can drive the loop with a stub.
 */
export interface ReattachableAgentService extends ConnectableAgentService {
    isReattaching(runId: string): boolean;
    reattachRequest(runId: string): WSReattachRequest | null;
    reattachCallbacks(runId: string): WSCallbacks | null;
}

/**
 * Pauses between rounds of connect attempts while a run waits to be
 * reattached. The last one repeats until the service gives the run up.
 */
const REATTACH_ROUND_PAUSE_MS = [
    { min: 250, max: 750 },
    { min: 750, max: 1500 },
    { min: 1500, max: 3000 },
];

export interface ReattachWithRetryOptions {
    service: ReattachableAgentService;
    runId: string;
    /**
     * Whether the run is still the caller's business beyond the service's own
     * state, e.g. the account it belongs to is still signed in.
     */
    isStillWanted: () => boolean;
    logLabel?: string;
    /** Test seam for the waits. */
    sleep?: (ms: number) => Promise<void>;
    /** Test seam for the jitter. */
    random?: () => number;
}

/**
 * Open a new socket for a run that lost its old one and ask the server to
 * reattach it.
 *
 * Runs `connectWithRetry` in rounds until a socket reaches `ready` and the
 * reattach is sent, or the run stops waiting: the service gives it up at the
 * grace period the backend advertised, when it is closed on purpose, or when
 * the server answers. Returns `connected` once the request is sent — the
 * outcome then arrives through the run's callbacks (`onReattached` or
 * `onReattachFailed`) — and `stopped` otherwise. A caller that gets `stopped`
 * for a run still reattaching should give it up.
 */
export async function reattachWithRetry(
    options: ReattachWithRetryOptions,
): Promise<'connected' | 'stopped'> {
    const {
        service,
        runId,
        isStillWanted,
        logLabel,
        sleep = defaultSleep,
        random = Math.random,
    } = options;
    const prefix = logLabel ? `reattachWithRetry (${logLabel}):` : 'reattachWithRetry:';
    const waiting = () => service.isReattaching(runId) && isStillWanted();

    for (let round = 0; waiting(); round++) {
        const request = service.reattachRequest(runId);
        const callbacks = service.reattachCallbacks(runId);
        if (!request || !callbacks) break;
        const result = await connectWithRetry({
            service,
            request,
            callbacks,
            logLabel,
            // The run's own "reconnecting" state covers every round.
            onRetrying: () => {},
            isAlreadyReported: () => !service.isReattaching(runId),
            isStillWanted: waiting,
            sleep,
            random,
        });
        if (result.kind === 'connected') return 'connected';
        if (!waiting()) break;
        const pause = REATTACH_ROUND_PAUSE_MS[Math.min(round, REATTACH_ROUND_PAUSE_MS.length - 1)];
        logger(`${prefix} round ${round + 1} failed (${result.kind}); trying again`, 1);
        await sleep(pause.min + random() * (pause.max - pause.min));
    }
    return 'stopped';
}
