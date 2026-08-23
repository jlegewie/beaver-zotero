/**
 * Batch progress, as the client reads it back off the run.
 *
 * The backend stamps `metadata.batch_progress` on every watched tool return
 * while a batch is open. Newest stamp wins — everything before it describes a
 * batch that has since moved on.
 *
 * User-facing strings are composed backend-side and rendered verbatim, so the
 * progress bar, approval card, and result card cannot describe one batch
 * differently. Collection names included: no surface resolves a key.
 */

import type { AgentRun, ModelMessage } from '../agents/types';

/** How far a batch got, and how it ended. */
export type BatchProgressStatus = 'active' | 'completed' | 'failed_out' | 'cancelled';

/**
 * One row of a batch's outcome distribution.
 *
 * What a row means depends on the operation — a collection for `sort`, a tag
 * for `tag`, a field name for `edit_metadata` — so the row carries no type of
 * its own and `tally_heading` says which.
 */
export interface BatchOutcomeTally {
    /** Already composed; no library lookup. */
    label: string;
    /** Items this row was recorded for. */
    count: number;
    /** Stable identity when names collide — a collection key for `sort`. */
    reference?: string;
    /** Destination created by this run, not one the user already had. */
    created?: boolean;
    /** Something taken away, never a destination. Rendered apart. */
    removal?: boolean;
}

/** Progress for one batch. */
export interface BatchProgressEntry {
    batch_id: string;
    /** `tag` | `sort` | `annotate` | `extract` | `edit_metadata` | `create_notes`. */
    operation: string;
    /**
     * Absent means `active` — the backend omits default-valued fields, so this
     * must be defaulted before it is compared, never read as `=== 'active'`.
     */
    status?: BatchProgressStatus;
    /**
     * Whether this batch is big enough to draw progress for. Decided
     * backend-side; a client must not reimplement the rule.
     */
    show_progress?: boolean;
    /** The batch being worked, and the one the bar tracks. */
    is_handover?: boolean;
    /**
     * What the batch is doing, e.g. "Filing items". Composed backend-side.
     * Absent on older records — fall back to the headline, do not invent a title.
     */
    progress_title?: string;
    /** Emphasised half of the headline, e.g. "109 of 184". Always set. */
    progress_primary: string;
    /** Context half, e.g. "items filed". */
    progress_secondary?: string;
    /** Breakdown under the track, e.g. "76 filed · 26 left as-is · 7 to go". */
    detail_label?: string;
    goal?: string;
    total?: number;
    resolved?: number;
    no_change?: number;
    failed?: number;
    /**
     * Heading for the distribution. Absent for operations that record none —
     * hide the block on this alone rather than hard-coding which those are.
     */
    tally_heading?: string;
    tallies?: BatchOutcomeTally[];
    tallies_overflow?: number;
    /**
     * Sum across all rows, listed or not. Tallies count memberships, not items
     * (one item can take several tags), so this is never the item count.
     */
    tallies_total?: number;
    removals?: BatchOutcomeTally[];
    /** Why items could not be processed. Only reported when a user can act on it. */
    failure_reasons?: BatchOutcomeTally[];
}

/** Every batch worth showing, as of the tool return this rode on. */
export interface BatchProgressStamp {
    /** Handover batch first, then the rest. */
    batches: BatchProgressEntry[];
}

/** Narrow an unknown metadata value to a {@link BatchProgressStamp}. */
export function isBatchProgressStamp(value: unknown): value is BatchProgressStamp {
    if (!value || typeof value !== 'object') return false;
    const batches = (value as { batches?: unknown }).batches;
    if (!Array.isArray(batches)) return false;
    return batches.every(
        (entry) =>
            !!entry &&
            typeof entry === 'object' &&
            typeof (entry as BatchProgressEntry).batch_id === 'string' &&
            typeof (entry as BatchProgressEntry).progress_primary === 'string',
    );
}

/** The stamp a message's tool returns carry, latest part first. */
function stampInMessage(message: ModelMessage): BatchProgressStamp | null {
    if (message.kind !== 'request') return null;
    for (let index = message.parts.length - 1; index >= 0; index--) {
        const part = message.parts[index];
        if (part.part_kind !== 'tool-return') continue;
        const stamp = (part.metadata as { batch_progress?: unknown } | undefined)?.batch_progress;
        if (isBatchProgressStamp(stamp)) return stamp;
    }
    return null;
}

/** The newest stamp in a thread, with the run that carried it. */
function newestStamp(
    runs: readonly AgentRun[],
): { stamp: BatchProgressStamp; runIndex: number } | null {
    for (let runIndex = runs.length - 1; runIndex >= 0; runIndex--) {
        const messages = runs[runIndex]?.model_messages;
        if (!messages?.length) continue;
        for (let index = messages.length - 1; index >= 0; index--) {
            const stamp = stampInMessage(messages[index]);
            if (stamp) return { stamp, runIndex };
        }
    }
    return null;
}

/**
 * The newest batch progress in a thread, or null when nothing has been stamped.
 *
 * Walks runs newest-first and stops at the first readable stamp. A stamp is a
 * complete statement of every open batch, so this is not an accumulation —
 * merging older stamps would resurrect cancelled or compacted batches.
 *
 * Use {@link selectLiveBatchProgress} for what a bar should still draw.
 */
export function selectBatchProgress(runs: readonly AgentRun[]): BatchProgressStamp | null {
    return newestStamp(runs)?.stamp ?? null;
}

/**
 * Whether a batch has ended. Absent `status` means `active` — the backend
 * omits default-valued fields, so never compare with `=== 'active'`.
 */
export function hasBatchEnded(entry: BatchProgressEntry): boolean {
    return (entry.status ?? 'active') !== 'active';
}

/**
 * Batch progress a bar should still draw, or null when nothing was stamped.
 *
 * Newest stamp, minus batches that had already ended when a newer run started.
 * A stamp is only written by a call that moves a batch, so a later run with no
 * stamp leaves the previous one standing — right for an active batch (still
 * open, must survive reload), wrong for an ended one (its bar would stay pinned
 * above the composer for the rest of the thread).
 *
 * An active batch survives later runs. An ended batch is retired as soon as a
 * later run exists.
 */
export function selectLiveBatchProgress(
    runs: readonly AgentRun[],
): BatchProgressStamp | null {
    const newest = newestStamp(runs);
    if (!newest) return null;
    if (newest.runIndex === runs.length - 1) return newest.stamp;
    const open = newest.stamp.batches.filter((entry) => !hasBatchEnded(entry));
    // Keep the original stamp when nothing was dropped so derived atoms stay
    // reference-equal.
    return open.length === newest.stamp.batches.length ? newest.stamp : { batches: open };
}

/**
 * The batch the bar tracks: the one being worked, or the first that is left.
 *
 * Returns null when nothing is worth showing — no batches, or every batch below
 * the size the backend decided is worth a progress bar.
 */
export function selectTrackedBatch(
    stamp: BatchProgressStamp | null,
): BatchProgressEntry | null {
    const shown = stamp?.batches.filter((entry) => entry.show_progress) ?? [];
    if (!shown.length) return null;
    return shown.find((entry) => entry.is_handover) ?? shown[0];
}
