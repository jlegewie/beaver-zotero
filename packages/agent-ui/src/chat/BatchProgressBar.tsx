import React, { useCallback, useState } from 'react';
import type { BatchProgressEntry } from '@beaver/agent-core/run-state/batchProgress';
import { ArrowDownIcon, Icon, LayersIcon, TickIcon } from '../icons';
import {
    BatchBlockHeading,
    BatchFailureReasonBlock,
    BatchProgressTrack,
    BatchRemovalBlock,
    BatchTallyBlock,
} from './BatchOutcomeBlocks';
import type { BatchLabelNames } from './BatchOutcomeBlocks';

/**
 * Labels for the slots this bar lays out, as opposed to what goes in them.
 * Naming a slot is chrome; everything the slots hold is composed backend-side
 * and rendered verbatim, so the bar, the approval card and the result card
 * cannot describe one batch differently.
 */
const ALSO_RUNNING_HEADING = 'Also running';
const REMOVED_HEADING = 'Also removed';
const FAILURE_HEADING = 'Could not be read';
const REVIEW_HEADING = 'Needs your review';
/**
 * Changes this batch proposed that the user has not applied yet.
 *
 * Deliberately NOT part of the backend stamp. The batch ledger counts an item
 * resolved once the agent has PROPOSED the edit — applied, queued for review
 * and rejected all end the agent's work on it — which is right for the ledger
 * and misleading on its own: a batch can read "184 of 184" while 184 changes
 * sit unreviewed. Only the client knows what happened to them afterwards, so
 * the host supplies this and the bar renders it beside the count.
 */
export interface BatchReviewStatus {
    /** Proposed, awaiting the user's decision. */
    pending: number;
    /** The user declined them. */
    rejected: number;
    /** Opens whatever review surface the host has. Omitted: no link is shown. */
    onReview?: () => void;
}

export interface BatchProgressBarProps {
    /** The batch the bar tracks — the one being worked. */
    batch: BatchProgressEntry;
    /** Every other batch still open, for the "also running" list. */
    otherBatches?: readonly BatchProgressEntry[];
    /** What the user still has to review, when the host can say. */
    review?: BatchReviewStatus | null;
    /**
     * Resolved display text per tally label, keyed by `label`. A `sort` batch
     * tallies by collection KEY, which is not something to show a user; a host
     * with a library resolves them and passes the names in here. Anything
     * missing falls back to the tally's own `display`, then to the key — a
     * client without a library still renders, just less helpfully.
     */
    labelNames?: BatchLabelNames;
}

/**
 * Live progress for a batch operation, shown above the composer.
 *
 * The bar exists because a batch's work happens between its `batch_start`
 * calls: the model files a hundred items across a dozen turns and the only
 * thing the transcript shows is tool rows scrolling past. Pinning progress to
 * the composer puts it where the user is already looking and keeps it from
 * scrolling away.
 *
 * Collapsed it is one line and a 2px segmented hairline. Expanded it adds the
 * goal, the counts, and — for the operations that have one — the distribution
 * of where items are actually going, which is the signal that catches a run
 * collapsing every item onto one destination while it is still running.
 *
 * Read-only by design. Stopping is the composer's Stop button, and cancelling
 * a batch is the model's own `batch_start(status='cancelled')`; a third control
 * here would be a fourth way to halt the same run.
 *
 * Host-agnostic: pure view data, no client lookups. Collection names are
 * resolved by the host and passed in as `labelNames`.
 */
export const BatchProgressBar: React.FC<BatchProgressBarProps> = ({
    batch,
    otherBatches = [],
    review = null,
    labelNames,
}) => {
    // Collapsed by default: during a run the user is reading the answer, and a
    // panel that opened itself would push the composer down every turn.
    const [isExpanded, setIsExpanded] = useState(false);
    const toggle = useCallback(() => setIsExpanded((open) => !open), []);
    const onKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsExpanded((open) => !open);
        }
    }, []);

    // The backend omits default-valued fields, so every optional is defaulted
    // here and gated on the NON-default state — never on `=== 'active'`.
    const status = batch.status ?? 'active';
    const total = batch.total ?? 0;
    const resolved = batch.resolved ?? 0;
    const noChange = batch.no_change ?? 0;
    const failed = batch.failed ?? 0;
    const isFinished = status === 'completed';
    const hasFailures = failed > 0 || status === 'failed_out';

    const share = (count: number) => (total > 0 ? (count / total) * 100 : 0);
    // Same rule as the expanded track: before the first outcome lands there is
    // no progress to draw, and a determinate hairline at zero reads as stalled.
    const isIndeterminate = status === 'active' && resolved + noChange + failed === 0;
    const segments = isIndeterminate ? (
        <div className="batch-progress-indeterminate" />
    ) : (
        <>
            <div style={{ width: `${share(resolved)}%`, backgroundColor: 'var(--accent-blue)' }} />
            <div style={{ width: `${share(noChange)}%`, backgroundColor: 'var(--fill-tertiary)' }} />
            <div style={{ width: `${share(failed)}%`, backgroundColor: 'var(--tag-orange)' }} />
        </>
    );

    const otherShown = otherBatches.filter((entry) => entry.show_progress);
    const reviewPending = review?.pending ?? 0;
    const reviewRejected = review?.rejected ?? 0;
    const hasReview = reviewPending > 0 || reviewRejected > 0;

    return (
        <div
            className="batch-progress-bar bg-senary border-bottom-quinary overflow-hidden"
            role="group"
            aria-label="Batch operation progress"
        >
            {/* The hairline: the same segmentation as the expanded track, at the
                bar's top edge, so progress reads before a single word does. */}
            <div
                className="display-flex flex-row"
                style={{ height: '2px', backgroundColor: 'var(--fill-quinary)' }}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={resolved + noChange}
                aria-valuetext={`${batch.progress_primary} ${batch.progress_secondary ?? ''}`.trim()}
            >
                {segments}
            </div>

            <div
                className="display-flex flex-row items-center gap-2 px-3 py-2 cursor-pointer"
                onClick={toggle}
                onKeyDown={onKeyDown}
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
            >
                <Icon icon={LayersIcon} className="font-color-secondary flex-none" />
                <span className="font-color-primary font-medium text-sm">
                    {batch.progress_primary}
                </span>
                {batch.progress_secondary && (
                    <span className="font-color-secondary text-sm truncate">
                        {batch.progress_secondary}
                    </span>
                )}
                {/* Only a non-default state earns a chip. */}
                {hasFailures && (
                    <span
                        className="text-xs font-color-orange flex-none"
                        style={{
                            backgroundColor: 'var(--tag-orange-quarternary)',
                            border: '1px solid var(--tag-orange-tertiary)',
                            borderRadius: '4px',
                            padding: '0 4px',
                            lineHeight: 1.5,
                        }}
                    >
                        {`${failed.toLocaleString()} failed`}
                    </span>
                )}
                {isFinished && !hasFailures && (
                    <Icon icon={TickIcon} className="font-color-green flex-none scale-85" />
                )}
                {otherShown.length > 0 && (
                    <span
                        className="text-xs font-color-secondary flex-none"
                        style={{
                            backgroundColor: 'var(--fill-quinary)',
                            border: '1px solid var(--fill-quarternary)',
                            borderRadius: '4px',
                            padding: '0 4px',
                            lineHeight: 1.5,
                        }}
                    >
                        {`+${otherShown.length} batch${otherShown.length === 1 ? '' : 'es'}`}
                    </span>
                )}
                <div className="flex-1" />
                <Icon
                    icon={ArrowDownIcon}
                    className="font-color-secondary flex-none scale-85 transition"
                    style={{ transform: isExpanded ? 'rotate(180deg)' : undefined }}
                />
            </div>

            {isExpanded && (
                <div className="display-flex flex-col gap-3 px-3 pb-3 min-w-0">
                    {batch.goal && (
                        <div className="font-color-secondary text-sm">{batch.goal}</div>
                    )}

                    <BatchProgressTrack batch={batch} />

                    <BatchTallyBlock batch={batch} labelNames={labelNames} />

                    <BatchRemovalBlock
                        batch={batch}
                        heading={REMOVED_HEADING}
                        labelNames={labelNames}
                    />

                    <BatchFailureReasonBlock batch={batch} heading={FAILURE_HEADING} />

                    {hasReview && (
                        <div className="display-flex flex-col gap-05 min-w-0 pt-2 border-top-quinary">
                            <BatchBlockHeading>{REVIEW_HEADING}</BatchBlockHeading>
                            {reviewPending > 0 && (
                                <div className="display-flex flex-row items-center gap-2 text-sm min-w-0">
                                    <span className="font-color-primary font-medium flex-none">
                                        {reviewPending.toLocaleString()}
                                    </span>
                                    <span className="font-color-secondary truncate">
                                        proposed, not yet applied
                                    </span>
                                    <div className="flex-1" />
                                    {review?.onReview && (
                                        <a
                                            href="#"
                                            className="text-xs font-color-accent-blue flex-none"
                                            onClick={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                review.onReview?.();
                                            }}
                                        >
                                            Review
                                        </a>
                                    )}
                                </div>
                            )}
                            {reviewRejected > 0 && (
                                <div className="text-sm font-color-secondary">
                                    {`${reviewRejected.toLocaleString()} you rejected`}
                                </div>
                            )}
                        </div>
                    )}

                    {otherShown.length > 0 && (
                        <div className="display-flex flex-col gap-05 min-w-0">
                            <BatchBlockHeading>{ALSO_RUNNING_HEADING}</BatchBlockHeading>
                            {otherShown.map((entry) => (
                                <div
                                    key={entry.batch_id}
                                    className="display-flex flex-row items-center gap-2 text-sm min-w-0"
                                >
                                    <Icon
                                        icon={LayersIcon}
                                        className="font-color-tertiary flex-none scale-85"
                                    />
                                    <span className="font-color-primary font-medium flex-none">
                                        {entry.progress_primary}
                                    </span>
                                    <span className="font-color-secondary truncate">
                                        {entry.progress_secondary}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default BatchProgressBar;
