import React from 'react';
import type {
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
                        lineHeight: 1.5,
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
 * The outcome distribution — where items went, which tags were applied, which
 * fields were changed.
 *
 * Renders nothing when the backend sent no heading. An empty heading is how it
 * says this operation records no distribution: every call carries the same
 * outcome label, so a chart of it would be one bar at 100%. Gating on the
 * heading alone is what keeps the client from having to know which operations
 * those are.
 */
export const BatchTallyBlock: React.FC<{
    batch: BatchProgressEntry;
}> = ({ batch }) => {
    const heading = batch.tally_heading?.trim() ?? '';
    const tallies = batch.tallies ?? [];
    if (!heading || tallies.length === 0) return null;

    const resolved = batch.resolved ?? 0;
    const talliesTotal = batch.tallies_total ?? 0;
    const overflow = batch.tallies_overflow ?? 0;
    const top = topCount(tallies);

    // Tallies count MEMBERSHIPS, not items — one item takes several tags — so
    // when the sum runs past the item count, say so rather than leave the user
    // to work out why the numbers add up to more than the population.
    const footnote: string[] = [];
    if (talliesTotal > resolved && resolved > 0) {
        footnote.push(`${talliesTotal.toLocaleString()} across ${resolved.toLocaleString()} items`);
    }
    if (overflow > 0) footnote.push(`+ ${overflow.toLocaleString()} more`);

    return (
        <div className="display-flex flex-col gap-05 min-w-0">
            <BatchBlockHeading>{heading}</BatchBlockHeading>
            {tallies.map((row) => (
                <BatchTallyRow
                    key={row.reference || row.label}
                    row={row}
                    top={top}
                    name={row.label}
                />
            ))}
            {footnote.length > 0 && (
                <div className="text-sm font-color-tertiary">{footnote.join(' · ')}</div>
            )}
        </div>
    );
};

/**
 * Things the batch took away — a collection items were removed from, a tag it
 * cleared.
 *
 * Its own block because these arrive in the same tally as the destinations: a
 * removal rendered as a destination reads as somewhere items went.
 */
export const BatchRemovalBlock: React.FC<{
    batch: BatchProgressEntry;
    heading: string;
}> = ({ batch, heading }) => {
    const removals = batch.removals ?? [];
    if (removals.length === 0) return null;
    const top = topCount(removals);
    return (
        <div className="display-flex flex-col gap-05 min-w-0">
            <BatchBlockHeading>{heading}</BatchBlockHeading>
            {removals.map((row) => (
                <BatchTallyRow
                    key={row.reference || row.label}
                    row={row}
                    top={top}
                    muted
                    name={row.label}
                />
            ))}
        </div>
    );
};

/**
 * Why items could not be processed.
 *
 * Only `extract` reports reasons, and it is the operation where they matter
 * most: it is metered, so "these are scans that need OCR" is worth far more
 * than a count that invites a blind, paid-for retry.
 */
export const BatchFailureReasonBlock: React.FC<{
    batch: BatchProgressEntry;
    heading: string;
}> = ({ batch, heading }) => {
    const reasons = batch.failure_reasons ?? [];
    if (reasons.length === 0) return null;
    return (
        <div className="display-flex flex-col gap-05 min-w-0">
            <BatchBlockHeading>{heading}</BatchBlockHeading>
            {reasons.map((row) => (
                <div
                    key={row.label}
                    className="display-flex flex-row items-baseline gap-2 text-sm min-w-0"
                >
                    <span className="font-color-secondary flex-1 min-w-0">{row.label}</span>
                    <span className="font-color-orange flex-none">{row.count}</span>
                </div>
            ))}
        </div>
    );
};
