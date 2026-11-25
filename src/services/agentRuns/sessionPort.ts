/**
 * What a window holds of its run session: a port.
 *
 * The session lives in the plugin realm, and a window evaluates its own copy
 * of the engine's modules, so the two never exchange atom objects or stores.
 * The window names the session state it reads and writes (`sessionState.ts`)
 * and the engine actions it starts (`sessionActions.ts`), and calls the
 * session's queries and commands here.
 *
 * Calls are synchronous, in-process calls. Values the window passes are kept
 * by reference, except a message submission, which is copied; the session's
 * lifetime is bounded by its window's.
 */

import type { AgentService, LiveJobWait, ParkOutcome } from '@beaver/agent-core/transport/agentService';
import type { AttachmentResolvedPayload } from '../attachmentResolved';
import { emitAttachmentResolved } from './attachmentResolvedEvent';
import { runEffect } from './runHost';
import { setLocalSessionPortFactory, type RunSession } from './runSession';
import { sessionAtomByName } from './sessionState';
import { currentWriter } from './threadWriter';
import { reconcileThread } from './threadAdmission';
import {
    canLeaveReconnectingRun,
    messageParksResume,
    parkableRunId,
    requestJobResume,
    retryCommitInFlight,
    startMessageRun,
    withThreadWriter,
    type MessageSubmission,
} from './runEngine';

/** What a window's preparation may do while it holds the chat's writer lease. */
export interface WriterScope {
    /** Throws `thread_operation_canceled` once the lease is lost or the window navigated. */
    assertCurrent(): void;
    /** Write session state or start a named action, guarded by the lease. */
    set(name: string, ...args: unknown[]): unknown;
    /**
     * Start the run of an assembled message. `onAccepted` runs once the run is
     * installed, and returns how to put the composer back if the server
     * refuses the run.
     */
    startMessageRun(submission: MessageSubmission, onAccepted?: () => (() => void) | undefined): Promise<void>;
}

export interface SessionPort {
    readonly sessionId: string;
    /** Owner of the session's library operations and sync pauses (`run:<sessionId>`). */
    readonly owner: string;

    // --- Session state, by name ------------------------------------------
    get(name: string): unknown;
    /** Set a state atom (a value or an updater) or start a named action. */
    set(name: string, ...args: unknown[]): unknown;
    sub(name: string, listener: () => void): () => void;

    // --- Queries -----------------------------------------------------------
    /** Whether the session holds its chat's writer lease. */
    hasWriter(): boolean;
    /** The active run, when it waits only on cards and can be parked. */
    parkableRunId(): string | null;
    /** Whether the active run is reconnecting and can be left to the server. */
    canLeaveReconnectingRun(): boolean;
    retryCommitInFlight(logPrefix: string): boolean;
    messageParksResume(): boolean;
    isApprovalAnswerHeld(actionId: string): boolean;

    // --- Commands ----------------------------------------------------------
    parkRun(runId: string): Promise<ParkOutcome>;
    leaveRun(runId: string): boolean;
    cancel(): Promise<void>;
    /** The fill the chat waits on may have ended: resume its parked run. */
    requestJobResume(): void;
    onJobWait(listener: (wait: LiveJobWait) => void): () => void;
    /** Settle the open chat against the server's history; see `reconcileThread`. */
    reconcileThread(isCurrent: () => boolean): Promise<boolean>;
    /** Forget the chats whose next reconcile would settle a lost run. */
    clearSettlingThreads(): void;
    /**
     * Prepare a message under the chat's writer lease: claims the chat and
     * reads admission first, as every send does.
     */
    withThreadWriter<T>(operation: (scope: WriterScope) => Promise<T>): Promise<T | undefined>;
    /** Report a resolved attachment to the backend on the session's socket. */
    emitAttachmentResolved(payload: AttachmentResolvedPayload): void;

    // --- Development ---------------------------------------------------------
    /** The session's transport, for development endpoints that inspect or fault it. */
    debugTransport(): AgentService;
}

/** The owner of a session's library operations and sync pauses. */
export function sessionOwner(session: RunSession): string {
    return `run:${session.id}`;
}

/** A copy of a submission made of the window's objects; it is plain data on the wire. */
function copySubmission(submission: MessageSubmission): MessageSubmission {
    return JSON.parse(JSON.stringify(submission));
}

/**
 * The port of `session`. `viewerAttached` tells whether the window the session
 * runs for is still there; a composer restore is dropped once it is gone.
 */
export function createSessionPort(
    session: RunSession,
    viewerAttached: () => boolean = () => true,
): SessionPort {
    const { store } = session;
    return {
        sessionId: session.id,
        owner: sessionOwner(session),
        get: (name) => store.get(sessionAtomByName(name)),
        set: (name, ...args) => store.set(sessionAtomByName(name), ...args),
        sub: (name, listener) => store.sub(sessionAtomByName(name), listener),

        hasWriter: () => !!currentWriter(session),
        parkableRunId: () => parkableRunId(store.get, session),
        canLeaveReconnectingRun: () => canLeaveReconnectingRun(store.get, session),
        retryCommitInFlight: (logPrefix) => retryCommitInFlight(store.get, logPrefix),
        messageParksResume: () => messageParksResume(store.get),
        isApprovalAnswerHeld: (actionId) => session.agentService.isApprovalAnswerHeld(actionId),

        parkRun: (runId) => session.agentService.parkRun(runId),
        leaveRun: (runId) => session.agentService.leaveRun(runId),
        cancel: () => session.agentService.cancel(),
        requestJobResume: () => requestJobResume(session),
        onJobWait: (listener) => session.agentService.onJobWait(listener),
        reconcileThread: (isCurrent) => reconcileThread(session, store.get, store.set, isCurrent),
        clearSettlingThreads: () => session.settlingThreads.clear(),
        withThreadWriter: (operation) =>
            withThreadWriter(store.set, (_guardedSet, guardedSessionSet) => operation({
                assertCurrent: () => runEffect(guardedSessionSet, () => {}),
                set: (name, ...args) => (guardedSessionSet as (...a: unknown[]) => unknown)(sessionAtomByName(name), ...args),
                startMessageRun: (submission, onAccepted) =>
                    startMessageRun(session, store.get, guardedSessionSet, copySubmission(submission), onAccepted && (() => {
                        const restore = onAccepted();
                        return restore && (() => {
                            if (viewerAttached()) restore();
                        });
                    })),
            }), session),
        emitAttachmentResolved: (payload) => emitAttachmentResolved(session.agentService, payload),
        debugTransport: () => session.agentService,
    };
}

setLocalSessionPortFactory((session) => createSessionPort(session));
