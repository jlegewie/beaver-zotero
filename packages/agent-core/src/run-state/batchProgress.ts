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

import { isRunActive } from '../agents/types';
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
     * Whether the backend judged this batch big enough to be worth a progress
     * bar. No surface here gates on it: a batch the model opened is a batch the
     * user is shown, and a size cutoff only made the panel and the receipt
     * disagree with the run they describe. Kept because it is on the wire.
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
 * Batch progress the panel above the composer should still draw, or null when
 * nothing was stamped.
 *
 * Newest stamp, with ended batches kept only while their carrying run is still
 * going — the panel holds them briefly after completion. Once that run is
 * terminal they belong to {@link selectRunBatchOutcomes}. `isRunActive` is the
 * complement of the statuses the receipt mounts for, so the two surfaces cannot
 * both draw one batch. Do not also require "newest run": a later run implies
 * the carrier finished, but if that ever stopped holding the batch would be
 * unreachable.
 *
 * Active batches always survive: they are still open.
 */
export function selectLiveBatchProgress(
    runs: readonly AgentRun[],
): BatchProgressStamp | null {
    const newest = newestStamp(runs);
    if (!newest) return null;
    if (isRunActive(runs[newest.runIndex])) return newest.stamp;
    const open = newest.stamp.batches.filter((entry) => !hasBatchEnded(entry));
    // Keep the original stamp when nothing was dropped so derived atoms stay
    // reference-equal.
    return open.length === newest.stamp.batches.length ? newest.stamp : { batches: open };
}

/** How the panel above the composer splits a stamp into its three tenses. */
export interface BatchPanelGroups {
    /** The batch the bar tracks, or null when the stamp holds no batches. */
    tracked: BatchProgressEntry | null;
    /**
     * Ended batches, most recent first. Never includes `tracked`.
     * The panel does not draw these; {@link selectRunBatchOutcomes} uses them
     * for the receipt, and needs `{tracked} ∪ done` to cover every ended entry.
     */
    done: readonly BatchProgressEntry[];
    /** Batches still waiting their turn, in the order they will be worked. */
    queued: readonly BatchProgressEntry[];
}

const NO_GROUPS: BatchPanelGroups = { tracked: null, done: [], queued: [] };

/**
 * Group a stamp the way the panel and receipt both consume it.
 *
 * Every batch in the stamp is grouped. Whether a job was worth batching is the
 * model's call, made when it opened one, and the prompt is where that judgement
 * is steered — screening the small ones back out here only produced a panel and
 * a receipt that disagreed with the run they were describing.
 *
 * Open batches outrank ended ones for `tracked` — a stamp can flag handover on
 * the same call that ends it. `done` is most-recent-first: the ended handover
 * leads, then the rest reversed (they were worked oldest-first).
 * `{tracked} ∪ done` must cover every ended entry, and `done` must not repeat
 * `tracked` — {@link selectRunBatchOutcomes} relies on both.
 */
export function selectBatchPanelGroups(
    stamp: BatchProgressStamp | null,
): BatchPanelGroups {
    const shown = stamp?.batches ?? [];
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

/** Shared empty result, so a run with no outcomes never re-renders a consumer. */
const NO_OUTCOMES: readonly BatchProgressEntry[] = [];

/**
 * Batches this run finished, most recent first.
 *
 * Newest stamp of the run only — merging older stamps would resurrect cancelled
 * batches. Order and filter via {@link selectBatchPanelGroups} so the receipt
 * matches the panel. An active tracked batch is dropped; it still belongs to
 * the panel.
 */
export function selectRunBatchOutcomes(run: AgentRun): readonly BatchProgressEntry[] {
    const stamp = newestStamp([run])?.stamp;
    if (!stamp) return NO_OUTCOMES;
    const { tracked, done } = selectBatchPanelGroups(stamp);
    const outcomes = [tracked, ...done].filter(
        (entry): entry is BatchProgressEntry => !!entry && hasBatchEnded(entry),
    );
    return outcomes.length ? outcomes : NO_OUTCOMES;
}

/**
 * Batches an answer finished, across every run that produced it.
 *
 * A response continued after an interruption spans a chain of runs but reads as
 * one message, and its receipt has to speak for the whole chain. Each run knows
 * only its own stamp, so the per-run outcomes are collected newest run first
 * and the newest record of a batch wins.
 *
 * Superseding is decided on every batch the newer run stamped, not just the
 * ones it ended: a batch the continuation picked back up is open again, and an
 * older run's ended record of it would otherwise resurface here while the panel
 * still draws it as running.
 */
export function selectChainBatchOutcomes(
    runs: readonly AgentRun[],
): readonly BatchProgressEntry[] {
    if (runs.length <= 1) {
        return runs.length ? selectRunBatchOutcomes(runs[0]) : NO_OUTCOMES;
    }
    const seen = new Set<string>();
    const outcomes: BatchProgressEntry[] = [];
    for (let index = runs.length - 1; index >= 0; index--) {
        const run = runs[index];
        for (const entry of selectRunBatchOutcomes(run)) {
            if (seen.has(entry.batch_id)) continue;
            seen.add(entry.batch_id);
            outcomes.push(entry);
        }
        for (const entry of newestStamp([run])?.stamp.batches ?? []) {
            seen.add(entry.batch_id);
        }
    }
    return outcomes.length ? outcomes : NO_OUTCOMES;
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
