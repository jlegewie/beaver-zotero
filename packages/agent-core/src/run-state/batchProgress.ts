/**
 * Batch progress, as the client reads it back off the run.
 *
 * The backend stamps `metadata.batch_progress` on every watched tool return
 * while a batch is open. A tool return is already both a live WebSocket frame
 * and a persisted message part, so one field carries live progress and durable
 * progress at once — a reload, a restart or a different machine all recover the
 * same state with no backfill and no extra request.
 *
 * The rule for reading it is the same one the backend uses to find the ledger:
 * **the newest stamp wins**. Everything before it describes a batch that has
 * since moved on.
 *
 * Every user-facing string here is composed backend-side and rendered verbatim,
 * exactly as on the approval card and the batch result card. A client owns its
 * own headings and its own layout, and nothing else — the three surfaces must
 * not be able to describe one batch differently. That now includes collection
 * NAMES: the backend composes them from the `collection_names` this client
 * returns while validating an `organize_items` action, so no surface resolves a
 * key at render time or at the run-state boundary.
 */

import type { AgentRun, ModelMessage } from '../agents/types';

/** How far a batch got, and how it ended. */
export type BatchProgressStatus = 'active' | 'completed' | 'failed_out' | 'cancelled';

/**
 * One row of a batch's outcome distribution.
 *
 * What a row MEANS depends on the operation — a collection for `sort`, a tag
 * for `tag`, a field name for `edit_metadata` — so the row carries no type of
 * its own and `tallyHeading` says which.
 */
export interface BatchOutcomeTally {
    /**
     * Text to show. Already the name a user knows a destination by: the
     * backend composes `sort` labels from the `collection_names` this client
     * returns during action validation, so nothing here needs a library lookup.
     */
    label: string;
    /** Items this row was recorded for. */
    count: number;
    /**
     * Stable identity behind the label when it has one — a Zotero collection
     * key for `sort`. Absent otherwise. What makes two rows provably the same
     * destination when their names collide.
     */
    reference?: string;
    /**
     * The run brought this destination into existence rather than using one the
     * user already had. The difference a distribution cannot be read without:
     * a run that invents twelve collections looks identical to one that files
     * into twelve existing ones until this is shown.
     */
    created?: boolean;
    /** Something taken AWAY, never a destination. Rendered apart. */
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
     * Whether this batch is big enough to draw progress for. Decided backend-side
     * from the operation's slice size; a client must not reimplement the rule.
     */
    show_progress?: boolean;
    /** This is the batch being worked, and the one the bar tracks. */
    is_handover?: boolean;
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
     * Heading for the distribution. EMPTY (absent) for an operation that records
     * no distribution — every call carries the same outcome label and a chart of
     * it would be one bar at 100%. Hiding the block on this alone is what keeps
     * the client from having to know which operations those are.
     */
    tally_heading?: string;
    tallies?: BatchOutcomeTally[];
    tallies_overflow?: number;
    /**
     * Sum across ALL rows, listed or not. Tallies count MEMBERSHIPS, not items —
     * one item takes several tags — so this is what the rows are a share of, and
     * never the item count.
     */
    tallies_total?: number;
    removals?: BatchOutcomeTally[];
    /**
     * Why items could not be processed. Only operations whose failures a user
     * can act on report any — `extract`, where a blind retry costs money.
     */
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

/**
 * The newest batch progress in a thread, or null when nothing has been stamped.
 *
 * Walks runs newest-first and stops at the first readable stamp. Deliberately
 * NOT an accumulation across runs: a stamp is a complete statement of every
 * batch that was open when it was written, so merging older ones back in would
 * resurrect batches that have since been cancelled or compacted away.
 *
 * Pure — no Zotero, no store, no I/O — so it can be exercised as a function.
 */
export function selectBatchProgress(runs: readonly AgentRun[]): BatchProgressStamp | null {
    for (let runIndex = runs.length - 1; runIndex >= 0; runIndex--) {
        const messages = runs[runIndex]?.model_messages;
        if (!messages?.length) continue;
        for (let index = messages.length - 1; index >= 0; index--) {
            const stamp = stampInMessage(messages[index]);
            if (stamp) return stamp;
        }
    }
    return null;
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
