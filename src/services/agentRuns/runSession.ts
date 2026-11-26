/**
 * A run session: everything one chat's execution owns.
 *
 * The run engine keeps no state at module level. What it needs between events
 * and across the runs a chat goes through (its transport, the quiet-stream
 * tracker, connect loops in flight, stops held for a reconnecting run, resume
 * bookkeeping) lives here, so that each session is independent of any other
 * in the same realm. Its chat state lives in its own store, which only the
 * session writes; windows render copies of it (`runProjection.ts`).
 *
 * Sessions live in the plugin realm (`addon.agentRuns`), one per chat that a
 * window shows or that has a run going, reused for every run of that chat:
 * the transport holds one run at a time, and a new run waits on it for the
 * cancel of a run stopped while reconnecting. Windows view a session, any
 * number at once, and reach it only through a `SessionPort`.
 */

import { atom, type createStore, type Getter } from 'jotai/vanilla';
import type { AgentService } from '@beaver/agent-core/transport/agentService';
import {
    createStreamActivityTracker,
    streamQuietAtom,
    type StreamActivityTracker,
} from '@beaver/agent-core/run-state/streamActivity';
import type { RunHost } from './runHost';
import type { SessionPort } from './sessionPort';
import type { WriterLease } from './threadWriter';

type Store = ReturnType<typeof createStore>;

/** The session a store belongs to: set in each session's own store. */
const ownSessionAtom = atom<RunSession | null>(null);

/** A retry committing its removal, and whether the user pressed Stop meanwhile. */
export interface RetryCommit {
    runId: string;
    stopRequested: boolean;
}

let sessionSeq = 0;

export class RunSession {
    /** Identifies the session in the registry, in owner tokens and in diagnostics. */
    readonly id = `s${++sessionSeq}-${Date.now().toString(36)}`;

    /**
     * Measures how long the stream has been quiet. Every handler that
     * advances a run notes activity on it: one left out would make its event
     * look like more silence, which is exactly the false report this exists
     * to prevent.
     */
    readonly streamActivity: StreamActivityTracker;

    /** Runs stopped while reconnecting, whose chat waits for the server from the stop on. */
    readonly heldStopRunIds = new Set<string>();

    /**
     * Connect loops in flight, including pre-ready attempts and backoff. The
     * transport reports no connection in that window, so shutdown uses this
     * count to abort a loop.
     */
    connectLoopsInFlight = 0;

    /**
     * Set once the client is going away. A send still preparing a message has
     * no socket or run yet; continuations check this so they don't connect
     * after the client is gone.
     */
    clientShutDown = false;

    /** Set while a parked-run resume is being started, before its run is installed. */
    parkedResumeStarting = false;

    /** Set while that resume carries the result of a fill the session waited on. */
    resumingFill = false;

    /** Fill resumes the server was not ready for yet, in a row. */
    jobResumeRetries = 0;

    /** Set while a message waits for the resume it replaces to park. */
    parkingResumeForMessage = false;

    /**
     * Increases whenever the callbacks of the runs started so far are revoked
     * (a run abandoned locally). Callbacks created under an older epoch drop
     * their writes.
     */
    writerCallbackEpoch = 0;

    /** Identifies the latest wait on a stop handoff, so an older one cannot end a newer. */
    cancelHandoffSeq = 0;

    /**
     * The retry whose removal is being committed, from the truncate request
     * until its replacement run is in place. A Stop pressed in that span is
     * held here and applied to the replacement.
     */
    retryCommit: RetryCommit | null = null;

    /**
     * Chats whose next reconcile settles a run the session lost track of.
     * Their local history may hold failed or stopped runs the server never
     * saved.
     */
    readonly settlingThreads = new Set<string>();

    /** The session's claim on writing to its chat, while it holds one (`threadWriter.ts`). */
    writerLease: WriterLease | undefined = undefined;

    /** Numbers the provisional claims of the session's new chats. */
    draftSeq = 0;

    /** Counts the writer claims the session has taken: each run, or retry, starts with one. */
    writerSeq = 0;

    /** Set once the session has left its registry; it starts nothing afterwards. */
    ended = false;

    /**
     * Called when something outside the session's store that decides whether
     * it is busy changes (its writer claim). Set by the registry.
     */
    lifecycleListener: (() => void) | null = null;

    /**
     * Why the session may not start writing now (too many runs at once), or
     * null. Asked before the session claims its chat. Set by the registry.
     */
    capacityRefusal: (() => { title: string; text: string } | null) | null = null;

    constructor(
        /** The session's private store: the authority for its chat state (`sessionStateAtoms`). */
        readonly store: Store,
        readonly agentService: AgentService,
        readonly host: RunHost,
    ) {
        this.streamActivity = createStreamActivityTracker({
            publish: (state) => store.set(streamQuietAtom, state),
        });
        store.set(ownSessionAtom, this);
    }
}

let installed: RunSession | null = null;
let installedPort: SessionPort | null = null;
let beforeFirstUse: (() => void) | null = null;
let localPortFactory: ((session: RunSession) => SessionPort) | null = null;

function prepareFirstUse(): void {
    if (!beforeFirstUse) return;
    const prepare = beforeFirstUse;
    beforeFirstUse = null;
    prepare();
}

/**
 * Make `session`, created in this realm, the one window code here talks to.
 * Unit tests run a window and its session in one realm this way; a Zotero
 * window installs the port of its plugin-realm session instead
 * (`installSessionPort`). `beforeFirstUse` runs once, when the session is
 * first asked for.
 */
export function installRunSession(session: RunSession, options?: { beforeFirstUse?: () => void }): void {
    installed = session;
    installedPort = null;
    beforeFirstUse = options?.beforeFirstUse ?? null;
}

/**
 * Make `port` the session window code in this realm talks to. `beforeFirstUse`
 * runs once, when the port is first asked for: the window attaches its
 * projection there, after the modules that define the session's state have
 * loaded.
 */
export function installSessionPort(port: SessionPort, options?: { beforeFirstUse?: () => void }): void {
    installed = null;
    installedPort = port;
    beforeFirstUse = options?.beforeFirstUse ?? null;
}

/** Set by `sessionPort.ts`, so a session installed in this realm gets a port. */
export function setLocalSessionPortFactory(factory: (session: RunSession) => SessionPort): void {
    localPortFactory = factory;
}

/**
 * The session installed in this realm. Only engine code running in the same
 * realm as its session uses this (unit tests); window code uses
 * `getSessionPort()`.
 */
export function getRunSession(): RunSession {
    if (!installed) throw new Error('No run session is installed in this realm');
    prepareFirstUse();
    return installed;
}

/** The port of the session this realm's window code talks to. */
export function getSessionPort(): SessionPort {
    prepareFirstUse();
    if (installedPort) return installedPort;
    if (!installed) throw new Error('No run session is installed');
    if (!localPortFactory) throw new Error('Session ports are not loaded');
    installedPort = localPortFactory(installed);
    return installedPort;
}

/**
 * The session that owns the store `get` reads, or null for any other store
 * (a window's).
 */
export function ownSessionOf(get: Getter): RunSession | null {
    return get(ownSessionAtom);
}

/**
 * The session that owns the store `get` reads, or the session installed in
 * this realm for any other store.
 */
export function sessionOf(get: Getter): RunSession {
    return get(ownSessionAtom) ?? getRunSession();
}
