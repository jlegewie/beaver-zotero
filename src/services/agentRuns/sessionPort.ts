/**
 * What a window holds of a run session: a port.
 *
 * The session lives in the plugin realm, and a window evaluates its own copy
 * of the engine's modules, so the two never exchange atom objects or stores.
 * The window names the session state it reads and writes (`sessionState.ts`)
 * and the engine actions it starts (`sessionActions.ts`), and calls the
 * session's queries and commands here.
 *
 * Each window that views a session has a port of its own, so the session
 * knows which window a command came from: its dialogs show there, and the
 * window that sends a message is the one its run's once-only effects go to.
 *
 * Calls are synchronous, in-process calls. A session outlives the windows
 * that view it, so what a window passes in is copied into the session's realm
 * (`copyIn`).
 */

import type { AgentService } from '@beaver/agent-core/transport/agentService';
import type { ModelConfig } from '@beaver/agent-core/types/models';
import type { AttachmentResolvedPayload } from '../attachmentResolved';
import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';
import { isRunActive } from '@beaver/agent-core/agents/types';
import { emitAttachmentResolved } from './attachmentResolvedEvent';
import { copyIn } from './copyIn';
import { jobWaitAtom } from './jobWait';
import { runEffect } from './runHost';
import { setLocalSessionPortFactory, type RunSession } from './runSession';
import { sessionAtomByName } from './sessionState';
import { currentWriter } from './threadWriter';
import { reconcileThread } from './threadAdmission';
import {
    isWSChatPendingAtom,
    messageParksResume,
    retryCommitInFlight,
    retryPendingRunIdAtom,
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
    /**
     * Whether the session has work going: a message being prepared, a run,
     * a stop or retry settling, or a fill it waits on. A busy session goes on
     * when no window views it.
     */
    isBusy(): boolean;
    /** Increases whenever the session starts writing to its chat (a run, a retry). */
    writerSeq(): number;
    /** Whether this port's window sent the session's latest message: once-only window effects of its run happen there. */
    isOrigin(): boolean;
    retryCommitInFlight(logPrefix: string): boolean;
    messageParksResume(): boolean;
    isApprovalAnswerHeld(actionId: string): boolean;

    // --- Commands ----------------------------------------------------------
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

/**
 * Whether `session` has work going (`SessionPort.isBusy`). A run waiting on a
 * card counts, and so does a parked run waiting on a fill.
 */
export function sessionBusy(session: RunSession): boolean {
    const { get } = session.store;
    return !!currentWriter(session)
        || get(isWSChatPendingAtom)
        || isRunActive(get(activeRunAtom))
        || !!get(retryPendingRunIdAtom)
        || !!get(jobWaitAtom)
        || session.connectLoopsInFlight > 0
        || session.parkedResumeStarting
        || !!session.retryCommit;
}

/**
 * Arguments a window passes to a session atom, copied in. An updater a window
 * passes for a state atom runs in the session's store and builds its value
 * in the window's realm, so what it returns is copied too.
 */
function copyArgs(args: unknown[]): unknown[] {
    return args.map((arg) =>
        typeof arg === 'function'
            ? (...inner: unknown[]) => copyIn((arg as (...a: unknown[]) => unknown)(...inner))
            : copyIn(arg));
}

/** How a window's port reports to the registry. */
export interface SessionPortOptions {
    /** Whether the window that holds the port still views the session; a composer restore is dropped once it does not. */
    viewerAttached?: () => boolean;
    /** Whether the window that holds the port sent the session's latest message. */
    isOrigin?: () => boolean;
    /** The window issued a command: the session's dialogs show there. */
    onCommand?: () => void;
    /**
     * The window's message starts its run: the run's once-only window effects
     * go there, and runs the session starts on its own use `model`.
     */
    onSend?: (model: ModelConfig | null) => void;
}

/** The port of `session` for one window. */
export function createSessionPort(session: RunSession, options: SessionPortOptions = {}): SessionPort {
    const { store } = session;
    const viewerAttached = options.viewerAttached ?? (() => true);
    const command = (): void => options.onCommand?.();
    return {
        sessionId: session.id,
        owner: sessionOwner(session),
        get: (name) => store.get(sessionAtomByName(name)),
        set: (name, ...args) => {
            command();
            return store.set(sessionAtomByName(name), ...copyArgs(args));
        },
        sub: (name, listener) => store.sub(sessionAtomByName(name), listener),

        hasWriter: () => !!currentWriter(session),
        isBusy: () => sessionBusy(session),
        writerSeq: () => session.writerSeq,
        isOrigin: () => options.isOrigin?.() ?? true,
        retryCommitInFlight: (logPrefix) => retryCommitInFlight(store.get, logPrefix),
        messageParksResume: () => messageParksResume(store.get),
        isApprovalAnswerHeld: (actionId) => session.agentService.isApprovalAnswerHeld(actionId),

        reconcileThread: (isCurrent) => reconcileThread(session, store.get, store.set, isCurrent),
        clearSettlingThreads: () => session.settlingThreads.clear(),
        withThreadWriter: (operation) => {
            command();
            return withThreadWriter(store.set, (_guardedSet, guardedSessionSet) => operation({
                assertCurrent: () => runEffect(guardedSessionSet, () => {}),
                set: (name, ...args) => (guardedSessionSet as (...a: unknown[]) => unknown)(sessionAtomByName(name), ...copyArgs(args)),
                startMessageRun: (submission, onAccepted) => {
                    const copied = copyIn(submission);
                    options.onSend?.(copied.model);
                    return startMessageRun(session, store.get, guardedSessionSet, copied, onAccepted && (() => {
                        const restore = onAccepted();
                        return restore && (() => {
                            if (viewerAttached()) restore();
                        });
                    }));
                },
            }), session);
        },
        emitAttachmentResolved: (payload) => emitAttachmentResolved(session.agentService, copyIn(payload)),
        debugTransport: () => session.agentService,
    };
}

setLocalSessionPortFactory((session) => createSessionPort(session));
