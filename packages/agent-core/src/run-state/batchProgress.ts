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
}

/** How a block's rows are drawn. */
export type BatchOutcomeBlockKind = 'destination' | 'removal' | 'failure';

/**
 * One labelled group of outcome rows.
 *
 * A repeated block rather than a field per axis, so an operation that grows a
 * new axis costs a client nothing. Headings are composed backend-side.
 */
export interface BatchOutcomeBlock {
    heading: string;
    kind: BatchOutcomeBlockKind;
    rows?: BatchOutcomeTally[];
    /** Rows beyond those listed. Every capped block reports one. */
    overflow?: number;
    /**
     * Sum across all rows, listed or not. Destination rows count memberships,
     * not items (one item can take several tags), so this is never the item count.
     */
    total?: number;
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
     * What the batch has done, in labelled groups. Empty for an operation that
     * records none — render what arrives, never hard-code which those are.
     *
     * Absent on records written before blocks existed; `readBatchProgressStamp`
     * builds it from the legacy fields so nothing downstream sees two shapes.
     */
    blocks?: BatchOutcomeBlock[];
}

/**
 * The pre-`blocks` shape, still present in stored threads.
 *
 * Read only by {@link legacyBlocks}. Nothing else may reach for these — every
 * surface reads `blocks`.
 */
interface LegacyOutcomeFields {
    tally_heading?: string;
    tallies?: BatchOutcomeTally[];
    tallies_overflow?: number;
    tallies_total?: number;
    removals?: BatchOutcomeTally[];
    removals_overflow?: number;
    failure_reasons?: BatchOutcomeTally[];
    failure_reasons_overflow?: number;
}

/** Headings the client used to own, kept for records that predate `blocks`. */
const LEGACY_REMOVAL_HEADING = 'Removed';
const LEGACY_FAILURE_HEADING = 'Could not be read';

/** Blocks for an entry written before the backend sent any. */
function legacyBlocks(entry: BatchProgressEntry): BatchOutcomeBlock[] {
    const legacy = entry as LegacyOutcomeFields;
    const blocks: BatchOutcomeBlock[] = [];
    if (legacy.tally_heading && legacy.tallies?.length) {
        blocks.push({
            heading: legacy.tally_heading,
            kind: 'destination',
            rows: legacy.tallies,
            overflow: legacy.tallies_overflow,
            total: legacy.tallies_total,
        });
    }
    if (legacy.removals?.length) {
        blocks.push({
            heading: LEGACY_REMOVAL_HEADING,
            kind: 'removal',
            rows: legacy.removals,
            overflow: legacy.removals_overflow,
        });
    }
    if (legacy.failure_reasons?.length) {
        blocks.push({
            heading: LEGACY_FAILURE_HEADING,
            kind: 'failure',
            rows: legacy.failure_reasons,
            overflow: legacy.failure_reasons_overflow,
        });
    }
    return blocks;
}

/** Every batch worth showing, as of the tool return this rode on. */
export interface BatchProgressStamp {
    /** Handover batch first, then the rest. */
    batches: BatchProgressEntry[];
}

interface BatchProgressContainer {
    batches: unknown[];
}

/** Whether an entry carries the fields the bar cannot render without. */
function isRenderableEntry(entry: unknown): entry is BatchProgressEntry {
    return (
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as BatchProgressEntry).batch_id === 'string' &&
        typeof (entry as BatchProgressEntry).progress_primary === 'string'
    );
}

/** Narrow an unknown metadata value to a {@link BatchProgressStamp}. */
export function isBatchProgressStamp(value: unknown): value is BatchProgressStamp {
    if (!value || typeof value !== 'object') return false;
    const batches = (value as { batches?: unknown }).batches;
    return Array.isArray(batches) && batches.every(isRenderableEntry);
}

/** Whether a value has the stamp container shape, without validating its entries. */
function isBatchProgressContainer(value: unknown): value is BatchProgressContainer {
    return (
        !!value &&
        typeof value === 'object' &&
        Array.isArray((value as { batches?: unknown }).batches)
    );
}

/** An entry with `blocks` filled in, whichever shape it was stored in. */
function withBlocks(entry: BatchProgressEntry): BatchProgressEntry {
    if (entry.blocks) return entry;
    const blocks = legacyBlocks(entry);
    return blocks.length ? { ...entry, blocks } : entry;
}

/**
 * A stamp with unrenderable entries dropped and `blocks` normalized, or null
 * when it is not a stamp.
 *
 * Per-entry, not all-or-nothing: discarding the whole stamp over one bad entry
 * falls back to an older one and shows stale numbers, where dropping the entry
 * keeps its readable siblings. An empty result still supersedes.
 *
 * The single place a pre-`blocks` record is adapted, so every surface downstream
 * reads one shape.
 */
export function readBatchProgressStamp(value: unknown): BatchProgressStamp | null {
    if (!isBatchProgressContainer(value)) return null;
    const usable = value.batches.filter(isRenderableEntry);
    const adapted = usable.map(withBlocks);
    // Reference-equal when nothing needed changing, so derived atoms do not
    // re-render on every unrelated read.
    return adapted.every((entry, index) => entry === usable[index]) &&
        usable.length === value.batches.length
        ? (value as BatchProgressStamp)
        : { batches: adapted };
}

/** The stamp a message's tool returns carry, latest part first. */
function stampInMessage(message: ModelMessage): BatchProgressStamp | null {
    if (message.kind !== 'request') return null;
    for (let index = message.parts.length - 1; index >= 0; index--) {
        const part = message.parts[index];
        if (part.part_kind !== 'tool-return') continue;
        const stamp = (part.metadata as { batch_progress?: unknown } | undefined)?.batch_progress;
        const usable = readBatchProgressStamp(stamp);
        if (usable) return usable;
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

/** How the panel above the composer splits a stamp into its three tenses. */
export interface BatchPanelGroups {
    /**
     * The batch the bar tracks, or null when nothing is worth showing — no
     * batches, or every batch below the size the backend decided is worth a
     * progress bar.
     */
    tracked: BatchProgressEntry | null;
    /** Batches that have ended, most recent first. Never includes `tracked`. */
    done: readonly BatchProgressEntry[];
    /** Batches still waiting their turn, in the order they will be worked. */
    queued: readonly BatchProgressEntry[];
}

const NO_GROUPS: BatchPanelGroups = { tracked: null, done: [], queued: [] };

/**
 * The stamp's batches, grouped the way the panel above the composer draws them.
 *
 * The single place the panel's policy lives: which batch gets the full bar, what
 * is still to come, and what has finished. Surfaces downstream render what they
 * are given and filter nothing, so the three groups cannot drift apart.
 *
 * An open batch always outranks an ended one for the bar — a stamp can flag a
 * batch as the handover on the same call that ends it, and tracking that one
 * would hide the batch actually being worked. With nothing open, the previous
 * rule stands, so a run that finishes its only batch still reads as it always
 * did: the completed bar, with its tick and its distribution.
 *
 * `done` runs most-recent-first, which the stamp's own order gives in two
 * pieces. The batch flagged as the handover leads the stamp, and the backend
 * pins that flag at the top of the request rather than clearing it when the
 * batch ends — so an ended handover is the batch that finished on this very
 * call, and it leads. Everything behind it is in the order the batches were
 * created, and they are worked oldest-first, so reversing that tail puts the
 * completion before it next.
 */
export function selectBatchPanelGroups(
    stamp: BatchProgressStamp | null,
): BatchPanelGroups {
    const shown = stamp?.batches.filter((entry) => entry.show_progress) ?? [];
    if (!shown.length) return NO_GROUPS;
    const open = shown.filter((entry) => !hasBatchEnded(entry));
    const tracked =
        open.find((entry) => entry.is_handover) ??
        open[0] ??
        shown.find((entry) => entry.is_handover) ??
        shown[0];
    const ended = shown.filter((entry) => entry !== tracked && hasBatchEnded(entry));
    return {
        tracked,
        done: [
            ...ended.filter((entry) => entry.is_handover),
            ...ended.filter((entry) => !entry.is_handover).reverse(),
        ],
        queued: open.filter((entry) => entry !== tracked),
    };
}

/**
 * The batch the bar tracks, for callers that need nothing else.
 *
 * Delegates, so there is exactly one rule for which batch that is.
 */
export function selectTrackedBatch(
    stamp: BatchProgressStamp | null,
): BatchProgressEntry | null {
    return selectBatchPanelGroups(stamp).tracked;
}
