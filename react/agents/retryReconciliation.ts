/**
 * Keeping a retry's local view of a thread in step with the server's.
 *
 * Run IDs are client-generated, and the server writes the run row late in its
 * setup phase. A retry whose request dies before then (connect failure, credit
 * rejection, invalid model) leaves the client holding an ID that does not exist
 * server-side. Two failures follow from that, and this module supplies what the
 * retry paths need to avoid both:
 *
 * - The client removed runs it asked the server to delete, but the server never
 *   got that far. The runs stay in the thread, out of the UI, and replay into
 *   the history of every later run. `RemovedThreadTail` is the snapshot that
 *   puts them back.
 * - Every later retry anchored on the phantom ID matches nothing server-side,
 *   so the drift can never be expressed, let alone repaired. `RetryAnchor`
 *   carries a second anchor the server can match, and `resolveRetryTarget`
 *   stops a phantom from becoming the anchor in the first place.
 */

import type { AgentRun } from './types';
import type { AgentAction } from './agentActions';
import type { Citation } from '../types/citations';

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

/** The local thread tail a retry removed before the server confirmed it. */
export interface RemovedThreadTail {
    /** Thread the snapshot belongs to, so it is never restored into another. */
    threadId: string | null;
    runs: AgentRun[];
    actions: AgentAction[];
    citations: Citation[];
    /**
     * Actions whose Zotero changes the retry reverted on the way out.
     *
     * The snapshot is taken before the revert is reflected anywhere, so these
     * come back reading as applied. Restoring them as undone keeps the cards
     * from offering operations on items and edits that no longer exist.
     */
    undoneActionIds: string[];
}

/**
 * A retry the client applied locally but the server has not confirmed.
 *
 * The server truncates a thread while loading it, which happens after the
 * request is acknowledged and is reported by the `thread` event. Until that
 * event arrives the runs the client removed are still in the thread. Two things
 * depend on knowing that:
 *
 * - `removed` restores the local view when the run dies first, so the thread
 *   stops serving runs the user believes are gone.
 * - `anchor` is inherited by the next retry that targets this run. The run was
 *   never persisted, so naming it as the retry target matches nothing; what the
 *   user wants replaced is what *this* retry was replacing.
 */
export interface UnconfirmedRetry {
    /** The run this retry started. */
    runId: string;
    anchor: RetryAnchor;
    /** Null once restored, or when the retry removed nothing locally. */
    removed: RemovedThreadTail | null;
    /**
     * Whether the server acknowledged the request.
     *
     * The only sound evidence the client has about the truncation. The server
     * acknowledges before it loads the thread, so an unacknowledged request
     * cannot have truncated anything; once acknowledged, the client can no
     * longer tell. See `planRetryRollback`.
     */
    acknowledged: boolean;
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

/**
 * Resolve which run a retry replaces, and what to tell the server about it.
 *
 * Normally that is the target run itself, with the runs before it as the keep
 * set. But a target the server never acknowledged only stands in for the retry
 * it was — naming it matches nothing server-side. Inherit that retry's anchor
 * instead, and re-target the run it was replacing when the rollback has put
 * that run back on screen, so the truncation and keep set follow from the
 * target as usual.
 *
 * `truncateFromIndex` is the index the caller would truncate `threadRuns` at,
 * which is the length of the list when the target is the active run.
 */
export function resolveRetryTarget(
    unconfirmed: UnconfirmedRetry | null,
    threadRuns: AgentRun[],
    targetRun: AgentRun,
    truncateFromIndex: number,
): { targetRun: AgentRun; truncateFromIndex: number; anchor: RetryAnchor } {
    // A run that never reached the server only ever occupies the active slot,
    // so a target that is part of thread history is real and anchors on itself.
    // Checked here rather than relying on the entry having been cleared, which
    // happens on an event the client cannot guarantee it will see.
    const isThreadHistory = threadRuns.some((run) => run.id === targetRun.id);
    if (!isThreadHistory && unconfirmed?.runId === targetRun.id) {
        const replacedIndex = threadRuns.findIndex(
            (run) => run.id === unconfirmed.anchor.retryRunId,
        );
        if (replacedIndex >= 0) {
            const replacedRun = threadRuns[replacedIndex];
            return {
                targetRun: replacedRun,
                truncateFromIndex: replacedIndex,
                anchor: buildRetryAnchor(threadRuns, replacedRun.id, replacedIndex),
            };
        }
        return { targetRun, truncateFromIndex, anchor: unconfirmed.anchor };
    }
    return {
        targetRun,
        truncateFromIndex,
        anchor: buildRetryAnchor(threadRuns, targetRun.id, truncateFromIndex),
    };
}

/**
 * What to do with a retry's local truncation when its run reaches a terminal
 * failure.
 *
 * - `none` — this run has no pending truncation; leave the entry alone. Covers
 *   a run whose truncation the server has confirmed, and any failure belonging
 *   to a different run.
 * - `restore` — put the tail back, then mark the entry restored.
 * - `discard` — the snapshot no longer describes what is on screen; drop it
 *   without restoring.
 */
export type RetryRollbackPlan =
    | { action: 'none' }
    | { action: 'discard' }
    | { action: 'restore'; removed: RemovedThreadTail };

/**
 * Decide whether a run's local truncation has to be put back.
 *
 * Restoring is gated on positive proof that the server never truncated, which
 * is the absence of an acknowledgment: the server acknowledges a request before
 * it loads the thread, and the truncation happens during that load. A run that
 * ends unacknowledged therefore left its runs in place, and leaving them
 * removed locally is what strands them — gone from the UI, alive server-side,
 * and replayed into the history of every later run.
 *
 * Past the acknowledgment the client cannot tell whether the truncation ran,
 * because the `thread` event that would report it can be lost with the
 * connection. That case is deliberately resolved as `discard`: re-creating runs
 * the server has already deleted would show content no later run can see, and
 * nothing would correct it. Under-restoring is recoverable instead — the keep
 * set on the next retry reconciles the thread either way.
 *
 * A thread switch during the failed request also discards the snapshot, since
 * restoring it would inject another thread's runs into the current one.
 */
export function planRetryRollback(
    unconfirmed: UnconfirmedRetry | null,
    runId: string,
    currentThreadId: string | null,
): RetryRollbackPlan {
    if (!unconfirmed || unconfirmed.runId !== runId || !unconfirmed.removed) {
        return { action: 'none' };
    }
    if (unconfirmed.acknowledged || unconfirmed.removed.threadId !== currentThreadId) {
        return { action: 'discard' };
    }
    return { action: 'restore', removed: unconfirmed.removed };
}

/**
 * Re-append removed entries that are not already back in the list.
 *
 * The removed entries were a contiguous tail, so appending restores both their
 * position and their relative order.
 */
export function restoreRemoved<T>(
    current: T[],
    removed: T[],
    keyOf: (entry: T) => string,
): T[] {
    if (removed.length === 0) return current;
    const present = new Set(current.map(keyOf));
    const missing = removed.filter((entry) => !present.has(keyOf(entry)));
    return missing.length > 0 ? [...current, ...missing] : current;
}
