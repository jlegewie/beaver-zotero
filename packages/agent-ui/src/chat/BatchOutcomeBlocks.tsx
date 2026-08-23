import React from 'react';
import type {
    BatchOutcomeBlock,
    BatchOutcomeTally,
    BatchProgressEntry,
} from '@beaver/agent-core/run-state/batchProgress';

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
 */

const NEW_BADGE = 'new';

/** Rows are scaled against the top row, so a bar means "share of the largest". */
function topCount(rows: readonly BatchOutcomeTally[]): number {
    return rows.reduce((max, row) => (row.count > max ? row.count : max), 0);
}

/** A block heading, in the voice the batch approval and result cards use. */
export const BatchBlockHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div
        className="text-sm font-semibold uppercase font-color-secondary"
        style={{ letterSpacing: '0.06em' }}
    >
        {children}
    </div>
);

/** The line under a block's rows. */
export const BatchBlockFootnote: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="text-sm font-color-secondary">{children}</div>
);

/** What a truncated list hides. Every capped block says this, or it reads complete. */
function moreLabel(overflow: number): string {
    return `+ ${overflow.toLocaleString()} more`;
}

/**
 * The segmented progress track: changed, examined-and-left-alone, failed.
 *
 * Both kinds of decision fill the track, because both are results — a track
 * that counted only changes would report an honest no-change batch as having
 * done nothing.
 */
export const BatchProgressTrack: React.FC<{
    batch: BatchProgressEntry;
    height?: string;
    /** Adds the backend's breakdown line under the track. */
    showDetail?: boolean;
}> = ({ batch, height = '6px', showDetail = true }) => {
    const total = batch.total ?? 0;
    const resolved = batch.resolved ?? 0;
    const noChange = batch.no_change ?? 0;
    const failed = batch.failed ?? 0;
    const share = (count: number) => (total > 0 ? (count / total) * 100 : 0);
    // Nothing decided yet on a batch that is still running: a determinate track
    // at zero reads as stalled, which is wrong at the one moment the model is
    // busiest — working out what the first slice should get.
    const isIndeterminate =
        (batch.status ?? 'active') === 'active' && resolved + noChange + failed === 0;

    if (isIndeterminate) {
        return (
            <div className="display-flex flex-col gap-1 min-w-0">
                <div
                    className="rounded-sm overflow-hidden"
                    style={{ height, backgroundColor: 'var(--fill-quinary)' }}
                >
                    <div className="batch-progress-indeterminate" />
                </div>
                {showDetail && batch.detail_label && (
                    <div className="text-sm font-color-secondary">{batch.detail_label}</div>
                )}
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
                        width: `${share(failed)}%`,
                        backgroundColor: 'var(--tag-orange)',
                    }}
                />
            </div>
            {showDetail && batch.detail_label && (
                <div className="text-sm font-color-secondary">{batch.detail_label}</div>
            )}
        </div>
    );
};

/** One tally row: label, share-of-top bar, count. */
export const BatchTallyRow: React.FC<{
    row: BatchOutcomeTally;
    top: number;
    muted?: boolean;
    name: string;
}> = ({ row, top, muted, name }) => (
    <div className="display-flex flex-row items-center gap-2 text-sm min-w-0">
        {/* The label takes the room, not the bar: in a sidebar the name is what
            the user reads and the bar is only a shape beside it. A fixed label
            column truncated "AI and labor market" to "AI and labor ..." while
            leaving half the row empty. The badge rides inside this group so it
            sits against the name it qualifies rather than drifting to the bar. */}
        <div className="display-flex flex-row items-center gap-1 flex-1 min-w-0">
            <span
                className={`${muted ? 'font-color-secondary' : 'font-color-primary'} truncate min-w-0`}
                title={name}
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
        <div
            className="flex-none rounded-sm overflow-hidden"
            style={{ width: '4.5rem', height: '4px', backgroundColor: 'var(--fill-quinary)' }}
        >
            <div
                style={{
                    height: '4px',
                    width: `${top > 0 ? Math.max(4, (row.count / top) * 100) : 0}%`,
                    backgroundColor: muted ? 'var(--fill-tertiary)' : 'var(--accent-blue)',
                    opacity: muted ? 1 : 0.55,
                }}
            />
        </div>
        <span className="font-color-secondary text-right flex-none" style={{ width: '1.6rem' }}>
            {row.count.toLocaleString()}
        </span>
    </div>
);

/**
 * One labelled group of outcome rows.
 *
 * `kind` is the only thing that varies: destinations get an accent bar and a
 * `new` badge, removals the same bar muted, failure reasons no bar at all. The
 * heading and every label arrive composed — nothing here is per-operation.
 */
export const BatchOutcomeBlockView: React.FC<{
    block: BatchOutcomeBlock;
    /** Items a call changed, for the memberships footnote. Destinations only. */
    resolved?: number;
}> = ({ block, resolved = 0 }) => {
    const rows = block.rows ?? [];
    if (rows.length === 0) return null;

    const overflow = block.overflow ?? 0;
    const total = block.total ?? 0;

    // Destination rows count MEMBERSHIPS, not items — one item takes several
    // tags — so when the sum runs past the item count, say so rather than leave
    // the user to work out why the numbers exceed the population.
    const footnote: string[] = [];
    if (block.kind === 'destination' && total > resolved && resolved > 0) {
        footnote.push(`${total.toLocaleString()} across ${resolved.toLocaleString()} items`);
    }
    if (overflow > 0) footnote.push(moreLabel(overflow));

    return (
        <div className="display-flex flex-col gap-1 min-w-0">
            <BatchBlockHeading>{block.heading}</BatchBlockHeading>
            {rows.map((row) =>
                block.kind === 'failure' ? (
                    <div
                        key={row.label}
                        className="display-flex flex-row items-baseline gap-2 text-sm min-w-0"
                    >
                        <span className="font-color-secondary flex-1 min-w-0">{row.label}</span>
                        <span className="font-color-secondary flex-none">{row.count}</span>
                    </div>
                ) : (
                    <BatchTallyRow
                        key={row.reference || row.label}
                        row={row}
                        top={topCount(rows)}
                        muted={block.kind === 'removal'}
                        name={row.label}
                    />
                ),
            )}
            {footnote.length > 0 && <BatchBlockFootnote>{footnote.join(' · ')}</BatchBlockFootnote>}
        </div>
    );
};

/**
 * Everything a batch has to show, in the order the backend sent it.
 *
 * Renders nothing when there are no blocks — which is how an operation that
 * records no distribution says so, without the client knowing which those are.
 */
export const BatchOutcomeBlocks: React.FC<{
    batch: BatchProgressEntry;
}> = ({ batch }) => {
    const blocks = batch.blocks ?? [];
    if (blocks.length === 0) return null;
    return (
        <>
            {blocks.map((block, index) => (
                <BatchOutcomeBlockView
                    key={`${block.kind}-${index}`}
                    block={block}
                    resolved={batch.resolved ?? 0}
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
 *
 * Bounded: the composer block this sits in never shrinks.
 */
export const BatchOutcomeBody: React.FC<{
    batch: BatchProgressEntry;
    /** Appended inside the same scroll box — what is one caller's alone. */
    children?: React.ReactNode;
}> = ({ batch, children }) => (
    <div
        className="display-flex flex-col gap-5 px-3 pb-3 min-w-0"
        style={{
            maxHeight: 'max(120px, calc(100vh - 320px))',
            overflowY: 'auto',
            overflowX: 'hidden',
        }}
    >
        {batch.goal && <div className="font-color-secondary text-base">{batch.goal}</div>}
        <BatchProgressTrack batch={batch} />
        <BatchOutcomeBlocks batch={batch} />
        {children}
    </div>
);
