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
import { parseItemReference, UNRESOLVED_LIBRARY_ID } from '../identity/libraryRef';
import type { ZoteroItemReference } from '../types/zotero';

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

/**
 * How a block's rows are drawn. `finding` is what the model flagged for the
 * user to act on, grouped by finding; any operation may send one.
 */
export type BatchOutcomeBlockKind = 'destination' | 'removal' | 'finding' | 'failure' | 'no_change';

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
    /** `tag` | `sort` | `annotate` | `extract` | `edit_metadata` | `create_notes` | `review`. */
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
     * Open, but NOT being worked by the run that stamped it: an earlier turn
     * left it unfinished and nothing has resumed it. Nothing happens to a
     * paused batch until the user asks for it back, so no live surface draws
     * one — not as the tracked bar, not as a queued row.
     *
     * Distinct from a batch waiting its turn behind the tracked one, which
     * carries neither this nor `is_handover` and IS being worked towards.
     * A finished batch is never paused.
     */
    paused?: boolean;
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
    /** Portable ref (`u` / `g<groupID>`) of the one library this batch's
     * population lives in. */
    library_ref?: string;
    total?: number;
    resolved?: number;
    no_change?: number;
    /**
     * Items examined and flagged for the user to act on. Settled like
     * `no_change`, but neither changed nor left alone — the `finding` block
     * groups them by what was found. Absent on older records and when zero.
     */
    findings?: number;
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

/** Shared empty result, so a panel with nothing to draw never re-renders. */
const NO_LIVE_BATCHES: BatchProgressStamp = { batches: [] };

/**
 * Batch progress the panel above the composer should still draw, or null when
 * nothing was stamped.
 *
 * The panel speaks for work in flight, so a batch reaches it only while
 * something is actually doing it. Two things end that:
 *
 * - **The carrying run is terminal.** Nothing runs when no run is active, so
 *   the whole stamp goes: its ended batches belong to
 *   {@link selectRunBatchOutcomes} — `isRunActive` is the complement of the
 *   statuses the receipt mounts for, so the two surfaces cannot both draw one
 *   batch — and its open ones are paused by definition. That covers the case a
 *   flag cannot: a run stopped mid-batch never gets to stamp anything, so its
 *   last word on the batch is "active" forever. Do not also require "newest
 *   run": a later run implies the carrier finished, but if that ever stopped
 *   holding, the batch would be unreachable.
 * - **The stamp says the batch is paused.** Left by an earlier turn and not
 *   resumed, so the run that stamped it is working something else. Only the
 *   backend knows this — an incidental edit landing on a paused batch's item
 *   credits it and re-stamps mid-run, and nothing in the entry itself would
 *   distinguish that from progress.
 *
 * Ended batches are otherwise kept while their carrying run is still going —
 * the panel holds them briefly after completion.
 */
export function selectLiveBatchProgress(
    runs: readonly AgentRun[],
): BatchProgressStamp | null {
    const newest = newestStamp(runs);
    if (!newest) return null;
    if (!isRunActive(runs[newest.runIndex])) return NO_LIVE_BATCHES;
    const worked = newest.stamp.batches.filter((entry) => !entry.paused);
    // Keep the original stamp when nothing was dropped so derived atoms stay
    // reference-equal.
    return worked.length === newest.stamp.batches.length
        ? newest.stamp
        : { batches: worked };
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
 * Paused batches are not screened out here: {@link selectLiveBatchProgress} has
 * already dropped them on the way to the panel, and the receipt reads only
 * ended entries, which a paused batch never is.
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

/**
 * A library object named by an outcome row, when the client can navigate to it.
 */
export type BatchOutcomeTarget = { libraryRef?: string } & (
    | { kind: 'collection'; key: string; name: string }
    | { kind: 'tag'; name: string }
);

/**
 * The library object an outcome row names, or `null`.
 */
export function batchOutcomeTarget(
    operation: string,
    block: BatchOutcomeBlock,
    row: BatchOutcomeTally,
    /** The batch's library, when it has exactly one. */
    libraryRef?: string,
): BatchOutcomeTarget | null {
    if (block.kind !== 'destination') return null;
    const name = row.label?.trim();
    if (!name) return null;
    const library = libraryRef?.trim() || undefined;
    if (operation === 'sort') {
        // Name alone cannot address a collection.
        const key = row.reference?.trim();
        if (!key) return null;
        const ref = parseItemReference(key);
        return { kind: 'collection', key, name, libraryRef: ref?.library_ref ?? library };
    }
    if (operation === 'tag') return { kind: 'tag', name, libraryRef: library };
    return null;
}

/**
 * The items behind one outcome row, keyed the way the row is: `kind` plus
 * `reference` when the row has one (a collection key for `sort`), else `kind`
 * plus `label`. Ids are model-facing item ids (`u-KEY` / `g<groupID>-KEY`, or
 * the legacy numeric form) — see {@link batchItemReference}.
 */
export interface BatchItemGroup {
    kind: BatchOutcomeBlockKind;
    label: string;
    reference?: string;
    /** Every item the row was recorded for, in population order. */
    item_ids: string[];
}

/**
 * Which items each outcome row of one batch stands for.
 *
 * Written ONCE by the backend, on the tool return that ended the batch (or the
 * first after it), never on the live stamps — so unlike `batch_progress` it is
 * collected, not superseded: the newest record per batch wins, wherever in
 * the thread it sits. Complete rather than capped: every row the block cap
 * hid is here with every item under it. Absent on records written before it
 * existed, and every surface must render without it.
 */
export interface BatchItemsRecord {
    batch_id: string;
    groups: BatchItemGroup[];
}

/** The item records one tool return carried. */
export interface BatchItemsStamp {
    batches: BatchItemsRecord[];
}

const ITEM_GROUP_KINDS: ReadonlySet<string> = new Set([
    'destination', 'removal', 'finding', 'failure', 'no_change',
]);

function isItemGroup(value: unknown): value is BatchItemGroup {
    if (!value || typeof value !== 'object') return false;
    const group = value as BatchItemGroup;
    return (
        typeof group.kind === 'string' &&
        ITEM_GROUP_KINDS.has(group.kind) &&
        typeof group.label === 'string' &&
        Array.isArray(group.item_ids) &&
        group.item_ids.every((id) => typeof id === 'string')
    );
}

/**
 * Narrow an unknown metadata value to a {@link BatchItemsStamp}.
 *
 * Per-record and per-group rather than all-or-nothing: one unreadable group
 * costs that group, not every batch on the stamp. A record with no readable
 * batch id is dropped.
 */
export function readBatchItemsStamp(value: unknown): BatchItemsStamp | null {
    if (!value || typeof value !== 'object') return null;
    const batches = (value as { batches?: unknown }).batches;
    if (!Array.isArray(batches)) return null;
    const usable: BatchItemsRecord[] = [];
    for (const record of batches) {
        if (!record || typeof record !== 'object') continue;
        const { batch_id, groups } = record as { batch_id?: unknown; groups?: unknown };
        if (typeof batch_id !== 'string' || !Array.isArray(groups)) continue;
        usable.push({ batch_id, groups: groups.filter(isItemGroup) });
    }
    return { batches: usable };
}

/** Item records by batch id. */
export type BatchItemsByBatch = ReadonlyMap<string, BatchItemsRecord>;

/** Shared empty result, so a thread without records never re-renders a consumer. */
const NO_ITEMS: BatchItemsByBatch = new Map();

/**
 * The newest item record for every batch in these runs.
 *
 * Walks newest-first and keeps the first record seen per batch — the backend
 * re-records a batch whose ledger moved after it ended, and the newest
 * statement is the one that matches the newest progress stamp. Reads
 * `metadata.batch_items` off tool returns, the same carrier as the progress
 * stamp; a thread whose runs predate the field yields an empty map, and
 * every consumer renders the counts alone.
 */
export function selectChainBatchItems(runs: readonly AgentRun[]): BatchItemsByBatch {
    let found: Map<string, BatchItemsRecord> | null = null;
    for (let runIndex = runs.length - 1; runIndex >= 0; runIndex--) {
        const messages = runs[runIndex]?.model_messages;
        if (!messages?.length) continue;
        for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index];
            if (message.kind !== 'request') continue;
            for (let part = message.parts.length - 1; part >= 0; part--) {
                const candidate = message.parts[part];
                if (candidate.part_kind !== 'tool-return') continue;
                const raw = (candidate.metadata as { batch_items?: unknown } | undefined)?.batch_items;
                if (!raw) continue;
                const stamp = readBatchItemsStamp(raw);
                if (!stamp) continue;
                for (const record of stamp.batches) {
                    if (found?.has(record.batch_id)) continue;
                    (found ??= new Map()).set(record.batch_id, record);
                }
            }
        }
    }
    return found ?? NO_ITEMS;
}

/**
 * The item group behind an outcome row, or `null` when the record has none.
 *
 * A row with a `reference` is matched on it — two `sort` destinations can
 * share a name — and every other row on its label, within the block's kind.
 */
export function batchItemGroupFor(
    record: BatchItemsRecord | undefined,
    block: Pick<BatchOutcomeBlock, 'kind'>,
    row: Pick<BatchOutcomeTally, 'label' | 'reference'>,
    collectionLibraryRef?: string,
): BatchItemGroup | null {
    if (!record) return null;
    const identity = (value?: string) => {
        const ref = value?.trim();
        return ref && collectionLibraryRef && /^[A-Z0-9]{8}$/.test(ref)
            ? `${collectionLibraryRef}-${ref}` : ref;
    };
    const reference = identity(row.reference);
    for (const group of record.groups) {
        if (group.kind !== block.kind) continue;
        if (reference ? identity(group.reference) === reference : (!group.reference && group.label === row.label)) {
            return group;
        }
    }
    return null;
}

/** The groups of one block's kind, in the order the backend listed them. */
export function batchItemGroupsOfKind(
    record: BatchItemsRecord | undefined,
    kind: BatchOutcomeBlockKind,
): BatchItemGroup[] {
    return record ? record.groups.filter((group) => group.kind === kind) : [];
}

/**
 * A recorded item id as a reference the host can resolve, or `null` when it
 * is not one. A portable prefix names the library; a legacy numeric prefix is
 * this device's rowid, which for the personal library is the same everywhere.
 */
export function batchItemReference(itemId: string): ZoteroItemReference | null {
    const parsed = parseItemReference(itemId);
    if (!parsed) return null;
    return {
        zotero_key: parsed.zotero_key,
        library_id: parsed.library_id ?? UNRESOLVED_LIBRARY_ID,
        ...(parsed.library_ref ? { library_ref: parsed.library_ref } : {}),
    };
}

// ---------------------------------------------------------------------------
// The population record: how a batch's items look
// ---------------------------------------------------------------------------

/**
 * One item of a batch's population, as a list draws it.
 *
 * One-letter keys because the record repeats them once per item, up to the
 * population cap, on every load of the thread — the keys would otherwise
 * weigh as much as the values. The same conventions as `ItemRowView`: `n` is
 * the headline ("Author Year" for a regular item, the title for a note or
 * standalone attachment) and `s` the quieter second line.
 */
export interface BatchPopulationItem {
    /** Model-facing item id, spelled the way `BatchItemGroup.item_ids` spells it. */
    id: string;
    /** Display name: the row's headline. */
    n: string;
    /** Subtitle: title and context, or the parent for a child item. */
    s?: string;
    /** Zotero item type, for the icon. */
    t?: string;
    /** Attachments only: broad content kind, for the icon. */
    c?: string;
}

/**
 * How the items of one batch's population look, as of its declaration.
 *
 * Written ONCE by the backend, on the `batch_start` return that minted the
 * population, and never again: an update to the batch reuses its frozen ids,
 * and a continuation mints a new batch with its own record. A snapshot, like
 * an item-list view: a rename after the batch ran does not reach it. Read
 * beside {@link BatchItemsRecord}, whose groups name these items by id; a
 * thread without the record, or a row the record lacks, draws the id (or
 * whatever the host can resolve live).
 */
export interface BatchPopulationRecord {
    batch_id: string;
    items: BatchPopulationItem[];
}

function isPopulationItem(value: unknown): value is BatchPopulationItem {
    if (!value || typeof value !== 'object') return false;
    const item = value as BatchPopulationItem;
    return typeof item.id === 'string' && item.id !== '' && typeof item.n === 'string' && item.n !== '';
}

/**
 * Narrow an unknown metadata value to a {@link BatchPopulationRecord}.
 *
 * Per-item rather than all-or-nothing: one unreadable row costs that row, not
 * the record. A record with no readable batch id is dropped.
 */
export function readBatchPopulationRecord(value: unknown): BatchPopulationRecord | null {
    if (!value || typeof value !== 'object') return null;
    const { batch_id, items } = value as { batch_id?: unknown; items?: unknown };
    if (typeof batch_id !== 'string' || !Array.isArray(items)) return null;
    return { batch_id, items: items.filter(isPopulationItem) };
}

/** Population rows by item identity — see {@link batchItemIdentityKey}. */
export type BatchPopulationLookup = ReadonlyMap<string, BatchPopulationItem>;

/** Population lookups by batch id. */
export type BatchPopulationsByBatch = ReadonlyMap<string, BatchPopulationLookup>;

/** Shared empty result, so a thread without records never re-renders a consumer. */
const NO_POPULATIONS: BatchPopulationsByBatch = new Map();

/**
 * Zotero pins the personal library to this rowid on every install, which is
 * why the backend treats the portable `u` and the legacy `1-` prefix as one
 * library. A group is portable only as `g<groupID>`: a bare rowid for one
 * names a library only on the install that wrote it.
 */
const PERSONAL_LIBRARY_ROWID = 1;

/**
 * The identity an item id names, whichever grammar spells it, or `null` when
 * it is not an item id. Two records written by different clients can spell
 * the same item `u-KEY` and `1-KEY`; joining them by this key keeps the
 * population's rows attached to the outcome groups either way.
 */
export function batchItemIdentityKey(itemId: string): string | null {
    const parsed = parseItemReference(itemId);
    if (!parsed) return null;
    const token =
        parsed.library_ref
        ?? (parsed.library_id === PERSONAL_LIBRARY_ROWID ? 'u' : String(parsed.library_id));
    return `${token}-${parsed.zotero_key}`;
}

function populationLookup(record: BatchPopulationRecord): BatchPopulationLookup {
    const lookup = new Map<string, BatchPopulationItem>();
    for (const item of record.items) {
        const key = batchItemIdentityKey(item.id);
        if (key && !lookup.has(key)) lookup.set(key, item);
    }
    return lookup;
}

/**
 * The newest population record for every batch in these runs, as lookups.
 *
 * Reads `metadata.batch_population` off tool returns, the carrier the ledger
 * and the item record share. Walks newest-first and keeps the first record
 * seen per batch, the same rule as {@link selectChainBatchItems}; a thread
 * whose runs predate the field yields an empty map.
 */
export function selectChainBatchPopulations(runs: readonly AgentRun[]): BatchPopulationsByBatch {
    let found: Map<string, BatchPopulationLookup> | null = null;
    for (let runIndex = runs.length - 1; runIndex >= 0; runIndex--) {
        const messages = runs[runIndex]?.model_messages;
        if (!messages?.length) continue;
        for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index];
            if (message.kind !== 'request') continue;
            for (let part = message.parts.length - 1; part >= 0; part--) {
                const candidate = message.parts[part];
                if (candidate.part_kind !== 'tool-return') continue;
                const raw = (candidate.metadata as { batch_population?: unknown } | undefined)?.batch_population;
                if (!raw) continue;
                const record = readBatchPopulationRecord(raw);
                if (!record || found?.has(record.batch_id)) continue;
                (found ??= new Map()).set(record.batch_id, populationLookup(record));
            }
        }
    }
    return found ?? NO_POPULATIONS;
}

/** The population row for an item, or `null` when the record has none. */
export function batchPopulationItemFor(
    population: BatchPopulationLookup | undefined,
    itemId: string,
): BatchPopulationItem | null {
    if (!population) return null;
    const key = batchItemIdentityKey(itemId);
    return (key && population.get(key)) || null;
}
