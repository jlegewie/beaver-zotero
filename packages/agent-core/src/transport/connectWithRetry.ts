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

/** Bounded-jitter spacing between reachability probes (see `probeReachable`). */
const REACHABILITY_PROBE_INTERVAL_MS = { min: 750, max: 1250 };

/**
 * Probes without an answer after which the loop makes one attempt anyway, so a
 * host whose probes cannot succeed (the probed endpoint blocked while sockets
 * get through) still recovers, only more slowly. Kept far apart because every
 * failed attempt makes the browser hold back the next one for longer.
 */
export const REACHABILITY_PROBES_PER_BLIND_ATTEMPT = 30;

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
    /**
     * Keep retrying until `isStillWanted` turns false, instead of stopping
     * after `CONNECT_MAX_ATTEMPTS`. Every connection failure is retried, since
     * the caller has a deadline of its own, and the backoff stays at its last
     * range. With no attempt budget there is no progress to report:
     * `onAttempt` is not called and `onRetrying` only gets the final `null`.
     */
    untilStopped?: boolean;
    /**
     * Whether the server can be reached without opening a socket. When given,
     * an attempt that failed before its socket opened is retried, after the
     * backoff, only once a probe succeeds: attempts made while the network is
     * down fail anyway, and each failure makes the browser hold back the next
     * socket to the same server for longer. Probes overlap, a new one starting
     * every second or so, so one stuck in a dead network does not delay the
     * next.
     */
    probeReachable?: () => Promise<boolean>;
    /** Test seam for the backoff wait. */
    sleep?: (ms: number) => Promise<void>;
    /** Test seam for the backoff jitter. */
    random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How a failed attempt ended, for the log: whether the socket never opened,
 * opened and then closed, or the attempt ran out of time. An attempt that
 * times out without opening was held back before reaching the server.
 */
function describeAttemptEnd(error: unknown): string {
    if (!(error instanceof AgentConnectionError)) {
        return error instanceof Error ? error.name : 'unknown error';
    }
    const { stage, socketOpened, closeCode, timedOut } = error.evidence;
    const how = timedOut
        ? 'timed out'
        : socketOpened
          ? 'closed after open'
          : 'closed before open';
    return `${how}, stage=${stage}${closeCode !== null ? `, code=${closeCode}` : ''}`;
}

/**
 * Resolve once a probe succeeds, the run stops being wanted, or
 * `REACHABILITY_PROBES_PER_BLIND_ATTEMPT` probes went unanswered.
 */
async function waitUntilReachable(
    probeReachable: () => Promise<boolean>,
    isStillWanted: () => boolean,
    sleep: (ms: number) => Promise<void>,
    random: () => number,
): Promise<'reachable' | 'blind' | 'unwanted'> {
    let reachable = false;
    let wake = () => {};
    const reached = new Promise<void>((resolve) => {
        wake = resolve;
    });
    for (let probes = 0; probes < REACHABILITY_PROBES_PER_BLIND_ATTEMPT; probes++) {
        if (!isStillWanted()) return 'unwanted';
        Promise.resolve().then(probeReachable).then(
            (ok) => {
                if (!ok) return;
                reachable = true;
                wake();
            },
            () => {},
        );
        const { min, max } = REACHABILITY_PROBE_INTERVAL_MS;
        await Promise.race([sleep(min + random() * (max - min)), reached]);
        if (reachable) return 'reachable';
    }
    return 'blind';
}

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
        untilStopped = false,
        probeReachable,
        sleep = defaultSleep,
        random = Math.random,
    } = options;

    // Not an option: the budget and the backoff table below are one policy, and
    // a caller that could raise the count without extending the table would
    // silently reuse the last range for every extra attempt. `untilStopped`
    // drops the budget instead, and reuses the last range on purpose.
    const maxAttempts = CONNECT_MAX_ATTEMPTS;
    const attemptLabel = (attempt: number) => (untilStopped ? `${attempt}` : `${attempt}/${maxAttempts}`);
    const prefix = logLabel ? `connectWithRetry (${logLabel}):` : 'connectWithRetry:';
    let lastFailure: unknown = null;
    let attemptsMade = 0;
    // One timestamp for the whole run, so the backend sees how long the client
    // spent connecting across every attempt rather than just the last one.
    const connectStartedAtMs = Date.now();

    try {
        for (let attempt = 1; untilStopped || attempt <= maxAttempts; attempt++) {
            attemptsMade = attempt;
            const attemptStartedAt = Date.now();
            try {
                logger(`${prefix} connect attempt ${attemptLabel(attempt)}`);
                if (!untilStopped) onAttempt?.({ attempt, maxAttempts });
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
                logger(`${prefix} connect attempt ${attemptLabel(attempt)} settled after ${Date.now() - attemptStartedAt}ms`);
                return { kind: 'connected', attemptsMade };
            } catch (error: unknown) {
                logger(
                    `${prefix} connect attempt ${attemptLabel(attempt)} failed after ${Date.now() - attemptStartedAt}ms (${describeAttemptEnd(error)}):`,
                    error,
                    1,
                );
                lastFailure = error;

                // Both abandon paths are left for the caller to log: it knows
                // what it is abandoning and why that matters, and a line here
                // would only say the same thing with less of it.
                if (isAlreadyReported()) {
                    return { kind: 'abandoned', reason: 'already_reported', attemptsMade };
                }

                const retryable =
                    error instanceof AgentConnectionError &&
                    (untilStopped ||
                        (attempt < maxAttempts && isRetryablePreReadyConnectFailure(error.evidence)));
                if (!retryable) break;

                // Fully tear down the failed attempt so AgentService's overlap
                // guard cannot swallow the next connect (a no-op when the
                // failure path already reset the connection state).
                // A run waiting to be reattached stays waiting.
                service.close(1000, 'Retrying connection', {
                    notifyClose: false,
                    ...(isReattachRequest(request) ? { keepDetachedRun: true } : {}),
                });
                if (!untilStopped) onRetrying({ attempt: attempt + 1, maxAttempts });

                const backoffRange = CONNECT_RETRY_BACKOFF_MS[
                    Math.min(attempt - 1, CONNECT_RETRY_BACKOFF_MS.length - 1)
                ];
                await sleep(
                    backoffRange.min + random() * (backoffRange.max - backoffRange.min),
                );

                if (probeReachable && !error.evidence.socketOpened && isStillWanted()) {
                    const waitStartedAt = Date.now();
                    const reach = await waitUntilReachable(probeReachable, isStillWanted, sleep, random);
                    logger(`${prefix} waited ${Date.now() - waitStartedAt}ms for the server (${reach})`);
                }

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
    probeReachable(): Promise<boolean>;
    isReattaching(runId: string): boolean;
    reattachAttempt(runId: string): { request: WSReattachRequest; callbacks: WSCallbacks } | null;
}

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
 * Retries until a socket reaches `ready` and the reattach is sent, or the run
 * stops waiting. While the server cannot be reached, it probes over HTTP rather
 * than opening sockets, so the first attempt after the network returns is not
 * held back by the browser. The run stops waiting when the service gives it up
 * at the grace period the backend advertised, when it is closed on purpose, or
 * when the server answers.
 * Returns `connected` once the request is sent — the outcome then arrives
 * through the run's callbacks (`onReattached` or `onReattachFailed`) — and
 * `stopped` otherwise. A caller that gets `stopped` for a run still
 * reattaching should give it up.
 */
export async function reattachWithRetry(
    options: ReattachWithRetryOptions,
): Promise<'connected' | 'stopped'> {
    const { service, runId, isStillWanted, logLabel, sleep, random } = options;
    const waiting = () => service.isReattaching(runId) && isStillWanted();
    const attempt = waiting() ? service.reattachAttempt(runId) : null;
    if (!attempt) return 'stopped';
    const result = await connectWithRetry({
        service,
        request: attempt.request,
        callbacks: attempt.callbacks,
        logLabel,
        untilStopped: true,
        // The run's own "reconnecting" state covers the whole wait.
        onRetrying: () => {},
        isAlreadyReported: () => !service.isReattaching(runId),
        isStillWanted: waiting,
        probeReachable: () => service.probeReachable(),
        sleep,
        random,
    });
    return result.kind === 'connected' ? 'connected' : 'stopped';
}
