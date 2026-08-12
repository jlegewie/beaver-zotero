/**
 * Keeping a retry's local view of a thread in step with the server's.
 *
 * A retry asks the server to delete a block of runs and regenerate from there.
 * Both sides have to end up agreeing on which runs are gone, and two things
 * make that harder than it sounds:
 *
 * - The client cannot delete its copy up front. Run IDs are client-generated
 *   and the server writes the run row late in its setup phase, so a request
 *   that dies before then (connect failure, credit rejection, invalid model)
 *   leaves the thread untouched server-side. A client that already dropped
 *   those runs would strand them: gone from the UI, alive server-side, and
 *   replayed into the history of every later run. So the client keeps them
 *   until the server reports the truncation, and `PendingRetry` is what it
 *   holds in the meantime.
 * - Even then the two views can drift, because a run the client believes it
 *   sent may never have been persisted. `RetryAnchor` carries a second anchor
 *   the server can match, which lets any later retry express the drift.
 *
 * The two halves of that are a request and a response. `RetryAnchor` is what
 * the client asks for; the `thread` event reports what the server's truncation
 * did — whether it anchored, and which rows it deleted. The client needs both
 * that and the plan below, and `commitPendingRetryAtom` explains why neither
 * one answers for the other.
 */

import type { AgentRun } from '@beaver/agent-core/agents/types';

/**
 * What a retry asks the server to replace.
 *
 * `retryRunId` alone is fragile: it can name a run that was never persisted.
 * `keepRunIds` is the second anchor — the runs the client still holds after the
 * truncation. The server deletes the trailing block of runs outside that set,
 * which reconciles a thread whose client-side and server-side views have
 * drifted apart. A set matching no run in the thread says nothing about where
 * the discarded tail begins and is ignored, so both are always sent together.
 */
export interface RetryAnchor {
    /** Run to restart from. The server deletes it and everything after it. */
    retryRunId: string;
    /** Run IDs the client still holds for this thread after the truncation. */
    keepRunIds: string[];
}

/**
 * A retry whose local truncation is still waiting on the server.
 *
 * Nothing in this record has been applied yet: the runs it names are still in
 * the thread. The retry's own run is hidden from the thread until then (see
 * `uncommittedRunIdAtom`), so the user sees the turns they still have.
 *
 * Reverting the runs' Zotero changes is deliberately *not* deferred this way —
 * that happens before the request goes out, where an interrupted undo still has
 * server-side records to resume from. See `startRetry`.
 *
 * It resolves exactly one of two ways:
 *
 * - commit — the server sent the `thread` event, which it does only after
 *   loading the thread and applying the truncation. That is positive proof of
 *   what is gone server-side, and the only point at which the client destroys
 *   its own copy. A truncation that never anchored deleted nothing, and then a
 *   commit destroys nothing either.
 * - abort — the run reached a terminal failure, or the user cancelled, before
 *   that proof arrived. Nothing was destroyed, so nothing has to be put back:
 *   the record is dropped and the failed run shell with it.
 *
 * Aborting without the proof is deliberate, and it is a choice: a cancel or a
 * dropped connection late enough in the exchange may land after the server has
 * truncated, leaving the client holding runs the server no longer has. That
 * resolves in the direction that keeps data — a visible thread the backend has
 * moved past, which a reload corrects and the keep set below reconciles on the
 * next retry — rather than deleting runs and Zotero items on the guess that the
 * server got far enough to delete its own.
 */
export interface PendingRetry {
    /** The run this retry started. */
    runId: string;
    /** The run the user retried — where the UI shows the retry in progress. */
    sourceRunId: string;
    /** Thread the plan was made against, so it is never applied to another. */
    threadId: string | null;
    /**
     * Runs the retry expects to remove from the thread: the run the request is
     * anchored on and everything after it. That anchor can sit earlier than
     * `sourceRunId`, which is the run the user clicked — retrying a resume run
     * replaces the whole chain from its root.
     *
     * Still needed once the server reports what it deleted: that report names
     * rows, and a planned run that was never persisted has no row to name.
     */
    runIdsToRemove: string[];
}

/** Runs the retry keeps, given the index it truncates the thread from. */
export function buildRetryAnchor(
    threadRuns: AgentRun[],
    retryRunId: string,
    truncateFromIndex: number,
): RetryAnchor {
    return {
        retryRunId,
        keepRunIds: threadRuns.slice(0, Math.max(0, truncateFromIndex)).map((run) => run.id),
    };
}
