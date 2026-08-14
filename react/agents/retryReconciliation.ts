/**
 * Keeping a retry's local view of a thread in step with the server's.
 *
 * Run IDs are client-generated, and the server writes the run row late in its
 * setup phase. A retry whose request dies before then (connect failure, credit
 * rejection, invalid model) leaves the client holding an ID that does not exist
 * server-side, and holding a thread it truncated for a deletion that never
 * happened. Both are drift, and the repair for both is the same: describe the
 * truncation to the server by what the client *keeps* rather than only by which
 * run it deletes from.
 *
 * `RetryAnchor` carries that keep set alongside the target run, and
 * `resolveRetryTarget` stops a run the server never persisted from becoming the
 * anchor in the first place — an anchor naming a phantom matches nothing, which
 * is what would make the drift permanent.
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
 * A retry the client applied locally but the server has not confirmed.
 *
 * The server truncates a thread while loading it, which happens after the
 * request is acknowledged and is reported by the `thread` event. Until that
 * event arrives, the run this retry started may not exist server-side at all,
 * so it cannot serve as the anchor for a further retry: naming it would match
 * nothing. `anchor` is what the next retry targeting this run inherits instead
 * — what the user wants replaced is what *this* retry was replacing.
 */
export interface UnconfirmedRetry {
    /** The run this retry started. */
    runId: string;
    anchor: RetryAnchor;
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
 * set. But a target the server never confirmed only stands in for the retry it
 * was — naming it matches nothing server-side. Inherit that retry's anchor
 * instead. If the run it was replacing is still in `threadRuns` (a reloaded
 * thread puts it back), re-target that run so the truncation and keep set
 * follow from the target as usual.
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
