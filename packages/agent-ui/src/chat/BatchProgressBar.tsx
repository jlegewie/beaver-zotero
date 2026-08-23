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

/**
 * Labels for the slots this bar lays out, as opposed to what goes in them.
 * Naming a slot is chrome; everything the slots hold is composed backend-side
 * and rendered verbatim, so the bar, the approval card and the result card
 * cannot describe one batch differently.
 */
const WAITING_HEADING = 'Waiting';
const REMOVED_HEADING = 'Also removed';
const FAILURE_HEADING = 'Could not be read';
const REVIEW_HEADING = 'Needs your review';
/** Introduces the queue. Lower case: it continues the line above it. */
const QUEUE_PREFIX = 'then ';

/**
 * The queue, named rather than counted.
 *
 * Only one batch is ever worked — the backend hands over a single batch's ids
 * per turn — so the others are not running alongside it, they are waiting their
 * turn. Saying WHICH costs the same line a bare count would and answers the
 * question the count only raises.
 *
 * Batches that share a title collapse into "Editing items x2". Two batches of
 * one operation over different populations are a real case, and a list that
 * repeated the same words would read as a rendering bug. What actually tells
 * them apart is their goal, which has no room here — the expanded list gives
 * each its own row and shows it there.
 */
function queueSummary(entries: readonly BatchProgressEntry[]): string {
    const counts = new Map<string, number>();
    for (const entry of entries) {
        const label = entry.progress_title?.trim() || entry.progress_primary;
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const parts = [...counts].map(([label, count]) =>
        count > 1 ? `${label} ×${count}` : label,
    );
    return parts.length ? QUEUE_PREFIX + parts.join(', ') : '';
}

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
 * Host-agnostic: pure view data, no client lookups — every label the backend
 * sends is already the name a user knows.
 */
export const BatchProgressBar: React.FC<BatchProgressBarProps> = ({
    batch,
    otherBatches = [],
    review = null,
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
    // The two terminal states that reach a client (`cancelled` batches are
    // dropped from the stamp backend-side). Both are over, and the bar must say
    // so: without this a finished batch with failures is indistinguishable from
    // one still failing its way through the population.
    const isOver = status === 'completed' || status === 'failed_out';
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

    // Absent from a record written before the field existed, and from any
    // backend older than this client. The bar then falls back to the headline
    // it has always shown rather than naming the operation itself: a title
    // composed here could disagree with the approval and result cards, which
    // is the one thing this record's wording rules exist to prevent.
    const title = batch.progress_title?.trim();

    const otherShown = otherBatches.filter((entry) => entry.show_progress);
    const queued = queueSummary(otherShown);
    const reviewPending = review?.pending ?? 0;
    const reviewRejected = review?.rejected ?? 0;
    const hasReview = reviewPending > 0 || reviewRejected > 0;

    return (
        <div
            className="batch-progress-bar bg-senary border-bottom-quarternary"
            style={{ position: 'relative' }}
            role="group"
            aria-label="Batch operation progress"
        >
            {/* Overlay, not in-flow: the composer already has a 1px top border,
                so a hairline in the layout stacks on it and the edge reads as
                2px. Completing the batch just fades this away. */}
            <div
                className="display-flex flex-row batch-progress-hairline"
                style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: 2,
                    opacity: isOver ? 0 : 1,
                    overflow: 'hidden',
                    pointerEvents: 'none',
                    transition: 'opacity 0.7s ease',
                }}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={resolved + noChange}
                aria-valuetext={[title, batch.progress_primary, title ? '' : batch.progress_secondary]
                    .filter(Boolean)
                    .join(' ')}
            >
                {segments}
            </div>

            <div
                className="display-flex flex-col px-3 py-2 cursor-pointer"
                onClick={toggle}
                onKeyDown={onKeyDown}
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
            >
                <div className="display-flex flex-row items-center gap-2 min-w-0">
                <Icon icon={LayersIcon} className="font-color-secondary flex-none" />
                {/* What the batch is doing leads, because the counts already
                    answer "how far" and nothing else answers "at what". It is
                    also the only part of the line that may be cut: the count
                    and the chips are each a fact that survives truncation
                    badly. */}
                <span
                    className={`font-color-primary font-medium text-sm ${title ? 'truncate' : 'flex-none'}`}
                    // The one label here that is allowed to be cut, so the one
                    // that needs a way back to the full text. Worst case is a
                    // narrow pane carrying both chips at once.
                    title={title || undefined}
                >
                    {title || batch.progress_primary}
                </span>
                {/* Without a title the headline keeps the shape it had: the
                    count leads and its context follows. */}
                {!title && batch.progress_secondary && (
                    <span className="font-color-secondary text-sm truncate">
                        {batch.progress_secondary}
                    </span>
                )}
                {/* Against the title, not opposite it. "Editing items" and
                    "94 of 184" are one statement; a justified row sets them
                    200px apart in a pane barely wider than that, and the pair
                    stops reading as a sentence. Everything the line has to say
                    is one left-flowing group; only the chevron is furniture and
                    only the chevron is anchored right. */}
                {title && (
                    <span className="font-color-secondary text-sm flex-none">
                        {batch.progress_primary}
                    </span>
                )}
                {/* Only a non-default state earns a chip. */}
                {hasFailures && (
                    <span
                        className="text-sm font-color-orange flex-none"
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
                {/* The mark answers "is it over"; the colour answers "how did
                    it go". Withholding it on failures left the only end-of-run
                    signal missing exactly when the run had something to report,
                    and a green tick beside a failure chip would claim the batch
                    was done rather than merely finished. */}
                {isOver && (
                    <Icon
                        icon={TickIcon}
                        className={`flex-none scale-11 ${hasFailures ? 'font-color-orange' : 'font-color-green'}`}
                    />
                )}
                <div className="flex-1" />
                <Icon
                    icon={ArrowDownIcon}
                    className="font-color-secondary flex-none scale-85 transition"
                    style={{ transform: isExpanded ? 'rotate(180deg)' : undefined }}
                />
                </div>

                {/* Indented to the title, so the queue reads as a continuation
                    of the line above rather than as a second batch. */}
                {queued && (
                    <div
                        className="font-color-tertiary text-sm truncate"
                        style={{ paddingLeft: 24 }}
                    >
                        {queued}
                    </div>
                )}
            </div>

            {isExpanded && (
                <div className="display-flex flex-col gap-4 px-3 pb-3 min-w-0">
                    {batch.goal && (
                        <div className="font-color-secondary text-sm">{batch.goal}</div>
                    )}

                    <BatchProgressTrack batch={batch} />

                    <BatchTallyBlock batch={batch} />

                    <BatchRemovalBlock batch={batch} heading={REMOVED_HEADING} />

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
                                            className="text-sm font-color-accent-blue flex-none"
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
                            <BatchBlockHeading>{WAITING_HEADING}</BatchBlockHeading>
                            {otherShown.map((entry) => (
                                <div
                                    key={entry.batch_id}
                                    className="display-flex flex-col min-w-0 text-sm"
                                >
                                    <div className="display-flex flex-row items-center gap-2 min-w-0">
                                        <Icon
                                            icon={LayersIcon}
                                            className="font-color-tertiary flex-none scale-85"
                                        />
                                        {/* Same order as the tracked bar. */}
                                        <span className="font-color-primary font-medium truncate">
                                            {entry.progress_title?.trim() ||
                                                entry.progress_primary}
                                        </span>
                                        {/* Grouped left like the tracked row.
                                            A right-aligned column would scan
                                            marginally better across rows, but
                                            not at the price of the list and the
                                            line above it being set differently. */}
                                        <span className="font-color-secondary flex-none">
                                            {entry.progress_title?.trim()
                                                ? entry.progress_primary
                                                : entry.progress_secondary}
                                        </span>
                                        <div className="flex-1" />
                                    </div>
                                    {/* The only thing that separates two
                                        batches of one operation over different
                                        populations, and the reason this list
                                        exists rather than a longer teaser. */}
                                    {entry.goal && (
                                        <div
                                            className="font-color-tertiary truncate"
                                            style={{ paddingLeft: 22 }}
                                        >
                                            {entry.goal}
                                        </div>
                                    )}
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
