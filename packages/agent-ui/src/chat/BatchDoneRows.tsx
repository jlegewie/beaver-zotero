import React, { useCallback, useState } from 'react';
import type { BatchProgressEntry } from '@beaver/agent-core/run-state/batchProgress';
import { ArrowDownIcon, CancelCircleIcon, Icon, TickIcon } from '../icons';
import { BatchFailureChip, BatchOutcomeBody } from './BatchOutcomeBlocks';

/**
 * Completed batches shown at once, before the rest fold behind one line.
 *
 * The panel sits on top of the composer in a sidebar; past a couple of rows it
 * costs more room than the receipt is worth. The newest completions are the
 * ones kept — they are what just happened.
 */
const MAX_VISIBLE_ROWS = 2;

/**
 * Layout wording, the same class of copy as the bar's own "then" and "Waiting".
 * Everything that describes a batch is composed backend-side.
 *
 * The open row cannot keep the closed one's words: "2 more completed" beside
 * the rows it just revealed reads as two further batches nobody can see.
 */
const COLLAPSE_LABEL = 'Show fewer';
const overflowLabel = (count: number): string => `${count.toLocaleString()} more completed`;

/**
 * One finished batch, collapsed to a line that can be opened for its outcome.
 *
 * Deliberately quieter than the live bar: no progress hairline, since there is
 * nothing left to watch. Everything the bar states about an ended batch it
 * still states — the failure count included — from the same record and the same
 * components, so a batch cannot lose its numbers by finishing.
 */
const BatchDoneRow: React.FC<{ batch: BatchProgressEntry }> = ({ batch }) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const toggle = useCallback(() => setIsExpanded((open) => !open), []);
    const onKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsExpanded((open) => !open);
        }
    }, []);

    // Backend omits default-valued fields — default here, never test `=== 'active'`.
    const hasFailures = (batch.failed ?? 0) > 0 || batch.status === 'failed_out';
    // Being stopped is not an outcome, and a tick would claim one. The bar
    // draws no mark at all for a cancelled batch; a row keeps its glyph column
    // aligned, so it takes a neutral one instead.
    const isCancelled = batch.status === 'cancelled';
    // Older records omit this; fall back to the headline, do not invent a title.
    const title = batch.progress_title?.trim();

    return (
        <div className="display-flex flex-col min-w-0">
            <div
                className="display-flex flex-row items-center gap-2 px-3 py-1 min-w-0 cursor-pointer"
                onClick={toggle}
                onKeyDown={onKeyDown}
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
            >
                {/* Orange on failure so a green tick does not claim success. */}
                <Icon
                    icon={isCancelled ? CancelCircleIcon : TickIcon}
                    className={`flex-none scale-12 ${
                        isCancelled
                            ? 'font-color-tertiary'
                            : hasFailures
                              ? 'font-color-orange'
                              : 'font-color-green'
                    }`}
                />
                {/* Title is the only part of the line that may truncate. */}
                <span
                    className={`font-color-secondary text-sm ${title ? 'truncate' : 'flex-none'}`}
                    title={title || undefined}
                >
                    {title || batch.progress_primary}
                </span>
                {!title && batch.progress_secondary && (
                    <span className="font-color-tertiary text-sm truncate">
                        {batch.progress_secondary}
                    </span>
                )}
                {title && (
                    <span className="font-color-tertiary text-sm flex-none">
                        {batch.progress_primary}
                    </span>
                )}
                <BatchFailureChip batch={batch} />
                <div className="flex-1" />
                <Icon
                    icon={ArrowDownIcon}
                    className="font-color-secondary flex-none scale-85 transition"
                    style={{ transform: isExpanded ? 'rotate(180deg)' : undefined }}
                />
            </div>

            {isExpanded && <BatchOutcomeBody batch={batch} />}
        </div>
    );
};

export interface BatchDoneRowsProps {
    /**
     * Batches that have ended, newest first. Already grouped by
     * `selectBatchPanelGroups` — this filters nothing.
     */
    batches: readonly BatchProgressEntry[];
}

/**
 * The batches this run has finished, stacked under the live bar.
 *
 * A batch used to vanish the instant it ended: the bar tracks one batch, so the
 * moment a sibling took over, the one that just finished — and its numbers —
 * were gone. These rows are what it settles into for the rest of the run, and
 * they retire with the rest of the panel when the next run starts.
 *
 * Kept below the bar so the bar's progress hairline stays the top edge of the
 * composer, and capped so a run with many batches cannot push the composer down
 * the pane.
 */
export const BatchDoneRows: React.FC<BatchDoneRowsProps> = ({ batches }) => {
    const [showAll, setShowAll] = useState(false);
    const toggle = useCallback(() => setShowAll((open) => !open), []);
    const onKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setShowAll((open) => !open);
        }
    }, []);

    if (batches.length === 0) return null;

    const overflow = batches.length - MAX_VISIBLE_ROWS;
    const visible = showAll || overflow <= 0 ? batches : batches.slice(0, MAX_VISIBLE_ROWS);

    return (
        <div
            className="batch-done-rows bg-senary border-bottom-quinary display-flex flex-col min-w-0"
            role="group"
            aria-label="Completed batch operations"
        >
            {visible.map((batch) => (
                <BatchDoneRow key={batch.batch_id} batch={batch} />
            ))}
            {overflow > 0 && (
                <div
                    className="display-flex flex-row items-center gap-2 px-3 py-1 min-w-0 cursor-pointer"
                    onClick={toggle}
                    onKeyDown={onKeyDown}
                    role="button"
                    tabIndex={0}
                    aria-expanded={showAll}
                >
                    <span className="font-color-tertiary text-sm truncate">
                        {showAll ? COLLAPSE_LABEL : overflowLabel(overflow)}
                    </span>
                    <div className="flex-1" />
                    <Icon
                        icon={ArrowDownIcon}
                        className="font-color-secondary flex-none scale-85 transition"
                        style={{ transform: showAll ? 'rotate(180deg)' : undefined }}
                    />
                </div>
            )}
        </div>
    );
};

export default BatchDoneRows;
