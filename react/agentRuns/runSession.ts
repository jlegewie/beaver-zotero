/**
 * A run session: everything one chat's execution owns.
 *
 * The run engine keeps no state at module level. What it needs between events
 * and across the runs a chat goes through (its transport, the quiet-stream
 * tracker, the part queue, connect loops in flight, stops held for a
 * reconnecting run, resume bookkeeping) lives here, so that each session is
 * independent of any other in the same realm.
 *
 * Today a renderer installs one session and reuses it for every run it
 * starts: the transport holds one run at a time, and a new run waits on it
 * for the cancel of a run stopped while reconnecting.
 */

import type { createStore } from 'jotai';
import type { AgentService } from '@beaver/agent-core/transport/agentService';
import {
    createStreamActivityTracker,
    streamQuietAtom,
    type StreamActivityTracker,
} from '@beaver/agent-core/run-state/streamActivity';
import type { PartEventQueue } from '../utils/streamingPartQueue';
import type { RunHost } from './runHost';

type Store = ReturnType<typeof createStore>;

/** A retry committing its removal, and whether the user pressed Stop meanwhile. */
export interface RetryCommit {
    runId: string;
    stopRequested: boolean;
}

export class RunSession {
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

    constructor(
        /** The store the session's run state is written to. */
        readonly store: Store,
        readonly agentService: AgentService,
        readonly host: RunHost,
        readonly partQueue: PartEventQueue,
    ) {
        this.streamActivity = createStreamActivityTracker({
            publish: (state) => store.set(streamQuietAtom, state),
        });
    }
}

let installed: RunSession | null = null;

/** Make `session` the one this renderer's runs execute in. */
export function installRunSession(session: RunSession): void {
    installed = session;
}

/** The session this renderer's runs execute in. */
export function getRunSession(): RunSession {
    if (!installed) throw new Error('No run session is installed');
    return installed;
}
