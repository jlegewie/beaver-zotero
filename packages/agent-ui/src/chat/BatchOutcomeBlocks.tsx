import React, { useState } from 'react';
import type {
    BatchItemGroup,
    BatchItemsRecord,
    BatchPopulationLookup,
    BatchOutcomeBlock,
    BatchOutcomeBlockKind,
    BatchOutcomeTally,
    BatchProgressEntry,
} from '@beaver/agent-core/run-state/batchProgress';
import {
    batchItemGroupFor,
    batchItemGroupsOfKind,
    batchItemIdentityKey,
    batchOutcomeTarget,
    batchPopulationItemFor,
} from '@beaver/agent-core/run-state/batchProgress';
import { ArrowDownIcon, Icon } from '../icons';
import { getHost } from '../host';
import { BatchItemFilter, BatchItemFindingRow, BatchItemList } from './BatchItemRows';
import type { BatchItemListAction } from './BatchItemRows';

/**
 * Which surface is drawing the batch. The live bar above the composer keeps
 * its original presentation; the receipt in the transcript opts into the
 * denser one: a swatch legend under the track instead of a caption, section
 * heads that carry their segment's swatch and count, and lighter chrome. Both
 * draw the same rows from the same record — only the framing differs.
 */
export type BatchSurface = 'live' | 'receipt';

/**
 * The blocks that describe what a batch has actually done, shared by the live
 * progress bar and the batch card that stays in the transcript afterwards.
 *
 * Shared rather than written twice on purpose: a user who watches the bar and
 * later reopens the thread must not have to reconcile two different pictures of
 * one batch. Both surfaces are handed the same
 * {@link BatchProgressEntry} and render it the same way; only the wording
 * around them differs, and that wording is composed backend-side.
 *
 * Host-agnostic: pure view data, no client lookups. Every label arrives ready
 * to render — the backend composes a `sort` destination's name from the
 * `collection_names` the Zotero client returns while validating the action, so
 * no surface here resolves a key.
 *
 * Navigation is the exception: a collection or tag is a place in a client's
 * library. Rows that name one become links when the host offers
 * `revealBatchOutcome`; otherwise they stay plain text. See
 * {@link batchOutcomeTarget} for which rows name what.
 *
 * An ended batch may also carry an item record ({@link BatchItemsRecord}):
 * which items each row stands for. With one, every row opens to its items,
 * the rows the block cap hid are listed after the ones it sent, and a finding
 * recorded for a single item is drawn item-first. Without one — every record
 * written before it existed — the blocks draw exactly as they always did.
 */

const NEW_BADGE = 'new';

/** Rows the transcript lists per block before offering the rest. */
const MAX_LISTED_ROWS = 10;

/** Rows across a batch's blocks past which a filter box is worth its space. */
const FILTER_THRESHOLD = 25;

/** Divider between the tallied findings and the one-item findings under them. */

/** Layout wording. Everything that describes a batch is composed backend-side. */
const OPEN_COLLECTION_LABEL = 'Open collection';
const OPEN_TAG_LABEL = 'Open tag';

/** Rows are scaled against the top row, so a bar means "share of the largest". */
function topCount(rows: readonly BatchOutcomeTally[]): number {
    return rows.reduce((max, row) => (row.count > max ? row.count : max), 0);
}

/**
 * The colour each kind of block shares with its segment on the track, so the
 * legend under the track doubles as a table of contents for the blocks below.
 * A removal is not a segment — it is the other side of a destination — and
 * gets none.
 */
function blockSwatch(kind: BatchOutcomeBlockKind): string | null {
    switch (kind) {
        case 'destination': return 'var(--accent-blue)';
        case 'no_change': return 'var(--fill-tertiary)';
        case 'finding': return 'var(--tag-purple)';
        case 'failure': return 'var(--tag-orange)';
        default: return null;
    }
}

/** A colour swatch: the dot before a legend entry or a section head. */
const Swatch: React.FC<{ color: string }> = ({ color }) => (
    <span className="batch-swatch flex-none" style={{ backgroundColor: color }} aria-hidden="true" />
);

/**
 * A block heading, in the voice the batch approval and result cards use.
 *
 * `kind` adds the block's swatch and `count` sits right after the label —
 * both only on the receipt, where the head is the light 11px caps line and
 * the swatch ties it to the legend above. The live bar passes neither.
 */
export const BatchBlockHeading: React.FC<{
    children: React.ReactNode;
    trailing?: React.ReactNode;
    kind?: BatchOutcomeBlockKind;
    count?: string;
}> = ({ children, trailing, kind, count }) => {
    const swatch = kind ? blockSwatch(kind) : null;
    return (
        <div className="display-flex flex-row items-baseline gap-2 min-w-0">
            <div
                className="batch-block-heading display-flex flex-row items-baseline gap-1 text-sm font-semibold uppercase font-color-primary flex-1 min-w-0"
                style={{ letterSpacing: '0.06em' }}
            >
                {swatch && <Swatch color={swatch} />}
                <span className="min-w-0">{children}</span>
                {count && <span className="batch-block-heading-count font-color-secondary font-medium">{count}</span>}
            </div>
            {trailing !== undefined && trailing !== null && (
                <div className="text-sm font-color-secondary flex-none">{trailing}</div>
            )}
        </div>
    );
};

/** The line under a block's rows. */
export const BatchBlockFootnote: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="text-sm font-color-secondary">{children}</div>
);

/** What a truncated list hides. Every capped block says this, or it reads complete. */
function moreLabel(overflow: number): string {
    return `+ ${overflow.toLocaleString()} more`;
}

/** Layout wording for a list the surface itself capped. */
const showAllLabel = (count: number): string => `Show all ${count.toLocaleString()}`;

/** "N across M items" when memberships outnumber items, else just "N". */
function countAcrossItems(total: number, items: number): string {
    if (items > 0 && total > items) {
        return `${total.toLocaleString()} across ${items.toLocaleString()} items`;
    }
    return total.toLocaleString();
}

/**
 * Caption under the segmented track.
 *
 * Prefer the backend's breakdown; fall back to the headline count so a bar is
 * never left unlabeled — some operations send no outcome rows beneath it, and
 * older records omit the breakdown entirely.
 */
function trackCaption(batch: BatchProgressEntry): string {
    return batch.detail_label || batch.progress_primary;
}

/** One entry of the legend under the track: the backend's part, verbatim, and its swatch. */
interface TrackLegendEntry {
    label: string;
    color: string;
}

/** Swatch for the part of the track nothing has been credited to yet. */
const REMAINING_SWATCH = 'var(--fill-quarternary)';

/**
 * The breakdown as a legend, or `null` when it cannot be drawn as one.
 *
 * The backend composes `detail_label` in the track's own segment order —
 * changed, left alone, findings, failed, still to go — dropping every zero.
 * That makes the parts pair with the non-zero segments by position, and this
 * checks the pairing rather than trusting it: each part must open with its
 * segment's count, or the caller falls back to the plain caption. A record
 * that predates a segment, or one whose wording changed, is then labelled
 * rather than mislabelled.
 */
function trackLegend(batch: BatchProgressEntry): TrackLegendEntry[] | null {
    const detail = batch.detail_label?.trim();
    if (!detail) return null;
    const total = batch.total ?? 0;
    const resolved = batch.resolved ?? 0;
    const noChange = batch.no_change ?? 0;
    const findings = batch.findings ?? 0;
    const failed = batch.failed ?? 0;
    const remaining = Math.max(0, total - resolved - noChange - findings - failed);
    const segments = [
        { count: resolved, color: 'var(--accent-blue)' },
        { count: noChange, color: 'var(--fill-tertiary)' },
        { count: findings, color: 'var(--tag-purple)' },
        { count: failed, color: 'var(--tag-orange)' },
        { count: remaining, color: REMAINING_SWATCH },
    ].filter((segment) => segment.count > 0);
    const parts = detail.split(' · ');
    if (parts.length !== segments.length) return null;
    const entries: TrackLegendEntry[] = [];
    for (let index = 0; index < parts.length; index++) {
        const leading = parts[index].match(/^[\d,.\s]+/)?.[0].replace(/\D/g, '');
        if (!leading || leading !== String(segments[index].count)) return null;
        entries.push({ label: parts[index], color: segments[index].color });
    }
    return entries;
}

/**
 * The segmented progress track: changed, examined-and-left-alone, flagged
 * with a finding, failed.
 *
 * Every kind of decision fills the track, because each is a result — a track
 * that counted only changes would report an honest no-change batch, or a
 * review that flagged half its items, as having done nothing.
 */
export const BatchProgressTrack: React.FC<{
    batch: BatchProgressEntry;
    height?: string;
    /** Adds the count / breakdown line under the track. */
    showDetail?: boolean;
    /**
     * Draw the breakdown as a swatch legend rather than a plain caption, so
     * the track needs no decoding. Falls back to the caption when the parts
     * cannot be paired with the segments (see {@link trackLegend}).
     */
    legend?: boolean;
}> = ({ batch, height = '6px', showDetail = true, legend = false }) => {
    const total = batch.total ?? 0;
    const resolved = batch.resolved ?? 0;
    const noChange = batch.no_change ?? 0;
    const findings = batch.findings ?? 0;
    const failed = batch.failed ?? 0;
    const share = (count: number) => (total > 0 ? (count / total) * 100 : 0);
    // Nothing decided yet on a batch that is still running: a determinate track
    // at zero reads as stalled, which is wrong at the one moment the model is
    // busiest — working out what the first slice should get.
    const isIndeterminate =
        (batch.status ?? 'active') === 'active' &&
        resolved + noChange + findings + failed === 0;
    const legendEntries = showDetail && legend && !isIndeterminate ? trackLegend(batch) : null;
    const caption = showDetail && !legendEntries ? trackCaption(batch) : undefined;
    const detail = legendEntries ? (
        <div className="batch-track-legend display-flex flex-row flex-wrap text-sm font-color-secondary">
            {legendEntries.map((entry) => (
                <span key={entry.label} className="display-flex flex-row items-center gap-1 flex-none">
                    <Swatch color={entry.color} />
                    {entry.label}
                </span>
            ))}
        </div>
    ) : caption ? (
        <div className="text-sm font-color-secondary">{caption}</div>
    ) : null;

    if (isIndeterminate) {
        return (
            <div className="display-flex flex-col gap-1 min-w-0">
                <div
                    className="rounded-sm overflow-hidden"
                    style={{ height, backgroundColor: 'var(--fill-quinary)' }}
                >
                    <div className="batch-progress-indeterminate" />
                </div>
                {detail}
            </div>
        );
    }

    return (
        <div className="display-flex flex-col gap-1 min-w-0">
            <div
                className="display-flex flex-row rounded-sm overflow-hidden"
                style={{ height, backgroundColor: 'var(--fill-quinary)' }}
            >
                <div
                    style={{
                        width: `${share(resolved)}%`,
                        backgroundColor: 'var(--accent-blue)',
                    }}
                />
                <div
                    style={{
                        width: `${share(noChange)}%`,
                        backgroundColor: 'var(--fill-tertiary)',
                    }}
                />
                <div
                    style={{
                        width: `${share(findings)}%`,
                        backgroundColor: 'var(--tag-purple)',
                    }}
                />
                <div
                    style={{
                        width: `${share(failed)}%`,
                        backgroundColor: 'var(--tag-orange)',
                    }}
                />
            </div>
            {detail}
        </div>
    );
};

/**
 * One tally row: label, share-of-top bar, count — and, when the row has items
 * behind it, a disclosure that opens them.
 *
 * The label wraps rather than truncates: a finding is a sentence the user has
 * to read, and a hover title is not reading. The bar is drawn only when the
 * top row counts at least two, since a bar of "1 of 1" says nothing.
 */
export const BatchTallyRow: React.FC<{
    row: BatchOutcomeTally;
    top: number;
    muted?: boolean;
    name: string;
    /** Go to what this row names. Absent when it names nothing reachable. */
    onActivate?: () => void;
    /** Draw the share-of-top bar. */
    showMeter?: boolean;
    /** Open or close the items behind the row. Absent when there are none. */
    onToggle?: () => void;
    expanded?: boolean;
    /** The bar's colour; the accent unless the surface ties it to a block. */
    meterColor?: string;
}> = ({
    row,
    top,
    muted,
    name,
    onActivate,
    showMeter = true,
    onToggle,
    expanded = false,
    meterColor = 'var(--accent-blue)',
}) => (
    <div
        className={[
            'display-flex flex-row items-start gap-2 text-sm min-w-0',
            onToggle && 'batch-tally-toggle',
        ]
            .filter(Boolean)
            .join(' ')}
        role={onToggle ? 'button' : undefined}
        tabIndex={onToggle ? 0 : undefined}
        aria-expanded={onToggle ? expanded : undefined}
        onClick={onToggle}
        onKeyDown={
            onToggle
                ? (e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      onToggle();
                  }
                : undefined
        }
    >
        {/* The label takes the room, not the bar: in a sidebar the name is what
            the user reads and the bar is only a shape beside it. The badge rides
            inside this group so it sits against the name it qualifies rather
            than drifting to the bar. */}
        <div className="display-flex flex-row items-baseline gap-1 flex-1 min-w-0">
            <span
                className={[
                    muted ? 'font-color-secondary' : 'font-color-primary',
                    'batch-tally-label min-w-0',
                    onActivate && 'batch-outcome-target',
                ]
                    .filter(Boolean)
                    .join(' ')}
                role={onActivate ? 'button' : undefined}
                // Count sits in a sibling, so the accessible name has to carry it.
                aria-label={onActivate ? `${name}, ${row.count.toLocaleString()}` : undefined}
                tabIndex={onActivate ? 0 : undefined}
                onClick={
                    onActivate
                        ? (e) => {
                              e.stopPropagation();
                              onActivate();
                          }
                        : undefined
                }
                onKeyDown={
                    onActivate
                        ? (e) => {
                              if (e.key !== 'Enter' && e.key !== ' ') return;
                              e.preventDefault();
                              e.stopPropagation();
                              onActivate();
                          }
                        : undefined
                }
            >
                {name}
            </span>
            {row.created && (
                <span
                    className="text-sm font-color-purple flex-none"
                    style={{
                        backgroundColor: 'var(--tag-purple-quarternary)',
                        border: '1px solid var(--tag-purple-tertiary)',
                        borderRadius: '3px',
                        padding: '0 3px',
                        lineHeight: 1.2,
                    }}
                    title="Created by this run"
                >
                    {NEW_BADGE}
                </span>
            )}
        </div>
        {showMeter && (
            <div
                className="flex-none rounded-sm overflow-hidden batch-tally-meter"
                style={{ width: '4.5rem', height: '4px', backgroundColor: 'var(--fill-quinary)' }}
            >
                <div
                    style={{
                        height: '4px',
                        width: `${top > 0 ? Math.max(4, (row.count / top) * 100) : 0}%`,
                        backgroundColor: muted ? 'var(--fill-tertiary)' : meterColor,
                        opacity: muted ? 1 : 0.55,
                    }}
                />
            </div>
        )}
        <span
            className="font-color-secondary text-right flex-none"
            style={{ width: '1.6rem', fontVariantNumeric: 'tabular-nums' }}
        >
            {row.count.toLocaleString()}
        </span>
        {onToggle && (
            <Icon
                icon={ArrowDownIcon}
                className="font-color-tertiary flex-none scale-85 transition batch-tally-chevron"
                style={{ transform: expanded ? 'rotate(180deg)' : undefined }}
            />
        )}
    </div>
);

/** One row of a block, with the items behind it when the record names them. */
interface OutcomeEntry {
    row: BatchOutcomeTally;
    group: BatchItemGroup | null;
}

/**
 * A row and, opened, its items. Owns the disclosure so the block stays hook-free.
 *
 * A row that both opens to its items and names a place in the library would
 * carry two click targets with nothing to tell them apart, so the place moves
 * into the opened list as a named action ("Open collection") and the label
 * stays plain. Without items to open, the label is the only way there and
 * stays a link.
 */
const BatchOutcomeRow: React.FC<{
    entry: OutcomeEntry;
    block: BatchOutcomeBlock;
    top: number;
    showMeter: boolean;
    /** Go to what the row names. */
    onActivate?: () => void;
    /** Wording for `onActivate` when it moves into the item list. */
    activateLabel?: string;
    surface?: BatchSurface;
    /** How the batch's items look, when the thread carries that record. */
    population?: BatchPopulationLookup;
}> = ({ entry, block, top, showMeter, onActivate, activateLabel, surface, population }) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const { row, group } = entry;
    const plain = block.kind === 'failure' || block.kind === 'no_change';
    const toggle = group ? () => setIsExpanded((open) => !open) : undefined;
    const openTarget: BatchItemListAction | undefined =
        group && onActivate && activateLabel ? { label: activateLabel, run: onActivate } : undefined;
    // On the receipt the bar takes the block's swatch, so a findings bar is
    // purple under a purple head; the live bar keeps the accent throughout.
    const meterColor = surface === 'receipt' ? (blockSwatch(block.kind) ?? undefined) : undefined;
    return (
        <div className="display-flex flex-col min-w-0">
            <BatchTallyRow
                row={row}
                top={top}
                muted={plain || block.kind === 'removal'}
                name={row.label}
                onActivate={openTarget ? undefined : onActivate}
                showMeter={showMeter && !plain}
                onToggle={toggle}
                expanded={isExpanded}
                meterColor={meterColor}
            />
            {isExpanded && group && <BatchItemList group={group} action={openTarget} population={population} />}
        </div>
    );
};

/**
 * A block's rows, capped by the surface with the rest on request.
 *
 * Separate from the block so the block itself stays hook-free: the live bar
 * and the tests call it as a plain function.
 */
const BatchOutcomeRowList: React.FC<{
    entries: readonly OutcomeEntry[];
    block: BatchOutcomeBlock;
    top: number;
    showMeter: boolean;
    /** Cap before "Show all"; unset lists everything. */
    maxRows?: number;
    /** Draw one-item findings item-first. */
    itemFirst?: boolean;
    operation?: string;
    libraryRef?: string;
    surface?: BatchSurface;
    population?: BatchPopulationLookup;
}> = ({ entries, block, top, showMeter, maxRows, itemFirst, operation, libraryRef, surface, population }) => {
    const [showAll, setShowAll] = useState(false);
    const shown = showAll || maxRows === undefined ? entries : entries.slice(0, maxRows);
    // Bind so a host object with state still gets its `this`.
    const navigation = getHost().navigation;
    const reveal = navigation?.revealBatchOutcome?.bind(navigation);
    return (
        <>
            {shown.map(({ row, group }) => {
                if (itemFirst && group) {
                    return <BatchItemFindingRow key={row.reference || row.label} group={group} population={population} />;
                }
                const target = operation ? batchOutcomeTarget(operation, block, row, libraryRef) : null;
                return (
                    <BatchOutcomeRow
                        key={row.reference || row.label}
                        entry={{ row, group }}
                        block={block}
                        top={top}
                        showMeter={showMeter}
                        onActivate={target && reveal ? () => void reveal(target) : undefined}
                        activateLabel={
                            target ? (target.kind === 'collection' ? OPEN_COLLECTION_LABEL : OPEN_TAG_LABEL) : undefined
                        }
                        surface={surface}
                        population={population}
                    />
                );
            })}
            {entries.length > shown.length && (
                <span
                    className="batch-outcome-target font-color-secondary text-sm"
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                        e.stopPropagation();
                        setShowAll(true);
                    }}
                    onKeyDown={(e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        e.stopPropagation();
                        setShowAll(true);
                    }}
                >
                    {showAllLabel(entries.length)}
                </span>
            )}
        </>
    );
};

/** A row for a group the block's own rows did not carry (hidden by its cap). */
function rowFromGroup(group: BatchItemGroup): BatchOutcomeTally {
    return {
        label: group.label,
        count: group.item_ids.length,
        ...(group.reference ? { reference: group.reference } : {}),
    };
}

/**
 * The block's rows joined to the record: the rows the backend sent, each with
 * its group when the record has one, then the groups the block cap hid.
 *
 * The sent rows stay authoritative — their counts are the ledger's, and a
 * membership the ledger could not attribute to an item is in the count but
 * in no group. The appended rows are complete by construction: a hidden row
 * is only known through its group.
 */
function joinRows(block: BatchOutcomeBlock, items?: BatchItemsRecord): OutcomeEntry[] {
    const rows = block.rows ?? [];
    const entries: OutcomeEntry[] = rows.map((row) => ({
        row,
        group: batchItemGroupFor(items, block, row),
    }));
    const seen = new Set(entries.map((entry) => entry.group).filter(Boolean));
    for (const group of batchItemGroupsOfKind(items, block.kind)) {
        if (seen.has(group) || group.item_ids.length === 0) continue;
        entries.push({ row: rowFromGroup(group), group });
    }
    return entries;
}

/**
 * Whether a row survives the filter box: its label, one of its item ids, or —
 * with a population record — the name or subtitle of one of its items, so
 * "Smith" finds the rows Smith's items sit under.
 */
function matchesFilter(entry: OutcomeEntry, filter: string, population?: BatchPopulationLookup): boolean {
    const query = filter.trim().toLowerCase();
    if (!query) return true;
    if (entry.row.label.toLowerCase().includes(query)) return true;
    return !!entry.group?.item_ids.some((id) => {
        if (id.toLowerCase().includes(query)) return true;
        const item = batchPopulationItemFor(population, id);
        return !!item && (item.n.toLowerCase().includes(query) || !!item.s?.toLowerCase().includes(query));
    });
}

/** Rows a batch's blocks would list, for the filter threshold. */
function countRows(batch: BatchProgressEntry, items?: BatchItemsRecord): number {
    return (batch.blocks ?? []).reduce((sum, block) => sum + joinRows(block, items).length, 0);
}

/**
 * One labelled group of outcome rows.
 *
 * `kind` is the only thing that varies: destinations get an accent bar and a
 * `new` badge, removals the same bar muted, findings the accent bar with no
 * link (a finding names no place in the library), failure reasons and
 * no-change reasons no bar at all. The heading and every label arrive
 * composed — nothing here is per-operation.
 *
 * A findings block with an item record reads one of two ways, never both:
 * item-first when every finding is one item (the finding is then unique per
 * item, and the item is the natural key), and as tallies otherwise — every
 * row alike, a one-item finding folded like the rest. Hook-free on purpose:
 * the live bar and the tests call it directly.
 */
export const BatchOutcomeBlockView: React.FC<{
    block: BatchOutcomeBlock;
    /** Items a call changed, for the memberships footnote. Destinations only. */
    resolved?: number;
    /** When set, destination rows that name a library object become links. */
    operation?: string;
    /** The batch's library, so a row can name one. See {@link batchOutcomeTarget}. */
    libraryRef?: string;
    /**
     * Cap listed rows; the rest join `block.overflow` in the "+ N more"
     * footnote. Unset lists everything sent, and offers the rest of a record
     * behind "Show all".
     */
    maxRows?: number;
    /** The batch's item record, when it has one. */
    items?: BatchItemsRecord;
    /** Text from the filter box; rows that match neither label nor id are dropped. */
    filter?: string;
    /** See {@link BatchSurface}. Defaults to the live bar's presentation. */
    surface?: BatchSurface;
    /** How the batch's items look, when the thread carries that record. */
    population?: BatchPopulationLookup;
}> = ({ block, resolved = 0, operation, libraryRef, maxRows, items, filter, surface = 'live', population }) => {
    const joined = joinRows(block, items);
    if (joined.length === 0) return null;
    const filtered = filter ? joined.filter((entry) => matchesFilter(entry, filter, population)) : joined;
    if (filter && filtered.length === 0) return null;

    // Which way the block reads. Item-first only when every finding is one
    // recorded item; as soon as one finding covers several, every row is a
    // tally, one-item findings included. Decided on the unfiltered rows, so
    // typing in the filter box cannot flip the shape.
    const itemFirst =
        block.kind === 'finding'
        && !!items
        && joined.every((entry) => entry.row.count === 1 && entry.group?.item_ids.length === 1);
    // Scale against every row in the block so a cap does not rescale the bars.
    const top = topCount(filtered.map((entry) => entry.row));
    const showMeter = !itemFirst && top >= 2;

    // A surface cap hides rows into the backend's overflow count; uncapped,
    // the record's extra rows sit behind "Show all" instead.
    const rows = maxRows !== undefined ? filtered.slice(0, maxRows) : filtered;
    // maxRows=0 would otherwise draw a heading over an empty list.
    if (rows.length === 0) return null;
    const sentRows = block.rows ?? [];
    // Rows the record added back are no longer hidden; what the surface
    // dropped joins the ones the backend never sent.
    const restored = joined.length - sentRows.length;
    const dropped = filtered.length - rows.length;
    // What the backend never sent cannot be filtered, so under a filter it
    // is not counted as "more" matches; only rows this surface dropped are.
    const unsent = Math.max(0, (block.overflow ?? 0) - restored);
    const overflow = (filter ? 0 : unsent) + dropped;
    const rowSum = joined.reduce((sum, entry) => sum + entry.row.count, 0);
    // The backend's sum spans rows it never sent. An older record omits it,
    // and then the rows on hand sum to the total only when none is missing:
    // heading a capped block with the sum of what it lists would state a
    // total that is not one.
    const total = block.total || (unsent === 0 ? rowSum : undefined);

    // Destination rows count MEMBERSHIPS, not items — one item takes several
    // tags — so when the sum runs past the item count, say so rather than leave
    // the user to work out why the numbers exceed the population. The receipt
    // says it in the section head; the live bar keeps it as a footnote.
    const receipt = surface === 'receipt';
    const membershipNote =
        block.kind === 'destination' && total !== undefined && total > resolved && resolved > 0
            ? `${total.toLocaleString()} across ${resolved.toLocaleString()} items`
            : null;
    const footnote: string[] = [];
    if (membershipNote && !receipt) footnote.push(membershipNote);
    if (overflow > 0) footnote.push(moreLabel(overflow));

    // The head's count. For findings, the record says how many distinct items
    // the findings fall on; without it, every row is taken as its own items.
    let headCount: string | undefined;
    if (receipt) {
        if (membershipNote) {
            headCount = membershipNote;
        } else if (block.kind === 'finding' && items) {
            const distinct = new Set<string>();
            let unattributed = 0;
            for (const entry of joined) {
                // By identity, not spelling: two records can name one item
                // `u-KEY` and `1-KEY`, and counting both overstates the items.
                if (entry.group) entry.group.item_ids.forEach((id) => distinct.add(batchItemIdentityKey(id) ?? id));
                else unattributed += entry.row.count;
            }
            headCount = total === undefined ? undefined : countAcrossItems(total, distinct.size + unattributed);
        } else {
            headCount = total?.toLocaleString();
        }
    }

    const listedRowCap = maxRows === undefined ? MAX_LISTED_ROWS : undefined;

    return (
        <div className="display-flex flex-col gap-1 min-w-0">
            <BatchBlockHeading kind={receipt ? block.kind : undefined} count={headCount}>
                {block.heading}
            </BatchBlockHeading>
            <BatchOutcomeRowList
                entries={rows}
                block={block}
                top={top}
                showMeter={showMeter}
                maxRows={listedRowCap}
                itemFirst={itemFirst}
                operation={operation}
                libraryRef={libraryRef}
                surface={surface}
                population={population}
            />
            {footnote.length > 0 && <BatchBlockFootnote>{footnote.join(' · ')}</BatchBlockFootnote>}
        </div>
    );
};

/** The blocks, with a filter box above them. Owns the filter text. */
const BatchFilteredBlocks: React.FC<{
    batch: BatchProgressEntry;
    items: BatchItemsRecord;
    rows: number;
    maxRows?: number;
    revealTargets?: boolean;
    surface?: BatchSurface;
    population?: BatchPopulationLookup;
}> = ({ batch, items, rows, maxRows, revealTargets, surface, population }) => {
    const [filter, setFilter] = useState('');
    return (
        <>
            <BatchItemFilter count={rows} value={filter} onChange={setFilter} />
            {(batch.blocks ?? []).map((block, index) => (
                <BatchOutcomeBlockView
                    key={`${block.kind}-${index}`}
                    block={block}
                    resolved={batch.resolved ?? 0}
                    operation={revealTargets ? batch.operation : undefined}
                    libraryRef={batch.library_ref}
                    maxRows={maxRows}
                    items={items}
                    filter={filter}
                    surface={surface}
                    population={population}
                />
            ))}
        </>
    );
};

/**
 * Everything a batch has to show, in the order the backend sent it.
 *
 * Renders nothing when there are no blocks — which is how an operation that
 * records no distribution says so, without the client knowing which those are.
 * A batch whose record runs to many rows gets a filter box above its blocks.
 */
export const BatchOutcomeBlocks: React.FC<{
    batch: BatchProgressEntry;
    /** Per-block row cap. See {@link BatchOutcomeBlockView}. */
    maxRows?: number;
    /** When true, rows that name a library object become links. */
    revealTargets?: boolean;
    /** The batch's item record, when it has one. */
    items?: BatchItemsRecord;
    /** See {@link BatchSurface}. */
    surface?: BatchSurface;
    /** How the batch's items look, when the thread carries that record. */
    population?: BatchPopulationLookup;
}> = ({ batch, maxRows, revealTargets, items, surface, population }) => {
    const blocks = batch.blocks ?? [];
    if (blocks.length === 0) return null;
    if (items) {
        const rows = countRows(batch, items);
        if (rows > FILTER_THRESHOLD) {
            return (
                <BatchFilteredBlocks
                    batch={batch}
                    items={items}
                    rows={rows}
                    maxRows={maxRows}
                    revealTargets={revealTargets}
                    surface={surface}
                    population={population}
                />
            );
        }
    }
    return (
        <>
            {blocks.map((block, index) => (
                <BatchOutcomeBlockView
                    key={`${block.kind}-${index}`}
                    block={block}
                    resolved={batch.resolved ?? 0}
                    operation={revealTargets ? batch.operation : undefined}
                    libraryRef={batch.library_ref}
                    maxRows={maxRows}
                    items={items}
                    surface={surface}
                    population={population}
                />
            ))}
        </>
    );
};

/** Layout wording. Everything that describes a batch is composed backend-side. */
const failedLabel = (count: number): string => `${count.toLocaleString()} failed`;

/**
 * The count of what a batch could not do, on its collapsed line.
 *
 * Shared so a batch cannot state its failures on the live bar and then lose
 * them when it settles into a completed row. Renders nothing when a batch has
 * none: one with no failures should not have to mention failure at all.
 */
export const BatchFailureChip: React.FC<{ batch: BatchProgressEntry }> = ({ batch }) => {
    // Backend omits default-valued fields — default here, never test `=== 'active'`.
    const failed = batch.failed ?? 0;
    if (failed === 0 && batch.status !== 'failed_out') return null;
    return (
        <span
            className="text-sm font-color-orange flex-none"
            style={{
                backgroundColor: 'var(--tag-orange-quarternary)',
                border: '1px solid var(--tag-orange-tertiary)',
                borderRadius: '4px',
                padding: '0 4px',
                lineHeight: 1.2,
            }}
        >
            {failedLabel(failed)}
        </span>
    );
};

/**
 * What a batch has done, opened out: its goal, its track, its distribution.
 *
 * The body behind every disclosure that expands a batch, shared for the same
 * reason the blocks are — the live bar and the completed row it turns into must
 * not describe one batch differently.
 */
export const BatchOutcomeBody: React.FC<{
    batch: BatchProgressEntry;
    /**
     * Scroll inside a viewport-relative cap rather than growing. For the
     * composer block, which never shrinks and would otherwise be pushed down
     * the pane. False in the transcript, which scrolls already: a second
     * scroller nested inside it would swallow the wheel, and a `100vh` bound
     * means nothing there.
     *
     * Unbounded leaves overflow alone entirely rather than clipping one axis:
     * `overflow-x: hidden` beside a visible `overflow-y` computes the latter to
     * `auto`, which is a scroll container again the moment anything caps the
     * height. The container clips instead — see `.batch-run-receipt`.
     */
    bounded?: boolean;
    /** Per-block row cap. */
    maxRows?: number;
    /** Click a row that names a collection or tag to go there. */
    revealTargets?: boolean;
    /** The batch's item record, when it has one. */
    items?: BatchItemsRecord;
    /**
     * See {@link BatchSurface}. The receipt's framing is a class on this box
     * as well as a prop to the parts, so its typography can be scoped in CSS
     * without the live bar's changing.
     */
    surface?: BatchSurface;
    /** How the batch's items look, when the thread carries that record. */
    population?: BatchPopulationLookup;
    /** Appended inside the same box — what is one caller's alone. */
    children?: React.ReactNode;
}> = ({ batch, bounded = true, maxRows, revealTargets, items, surface = 'live', population, children }) => (
    <div
        className={[
            'display-flex flex-col gap-5 px-3 pb-3 min-w-0',
            surface === 'receipt' && 'batch-outcome-receipt',
        ]
            .filter(Boolean)
            .join(' ')}
        style={
            bounded
                ? {
                      maxHeight: 'max(120px, calc(100vh - 320px))',
                      overflowY: 'auto',
                      overflowX: 'hidden',
                  }
                : undefined
        }
    >
        {batch.goal && <div className="batch-outcome-goal font-color-secondary text-base">{batch.goal}</div>}
        <BatchProgressTrack batch={batch} legend={surface === 'receipt'} />
        <BatchOutcomeBlocks
            batch={batch}
            maxRows={maxRows}
            revealTargets={revealTargets}
            items={items}
            surface={surface}
            population={population}
        />
        {children}
    </div>
);
