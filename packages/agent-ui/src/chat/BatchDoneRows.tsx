import React, { useCallback, useState } from 'react';
import type { BatchProgressEntry } from '@beaver/agent-core/run-state/batchProgress';
import { ArrowDownIcon, CancelCircleIcon, Icon, LayersIcon, TickIcon } from '../icons';
import { BatchFailureChip, BatchOutcomeBody } from './BatchOutcomeBlocks';

/** Heading copied from the approval card. Keep in step with the backend string. */
const headingLabel = (count: number): string =>
    count === 1 ? 'Batch operation' : 'Batch operations';

/** One finished batch, collapsed until opened. */
const BatchDoneRow: React.FC<{
    batch: BatchProgressEntry;
    /** Whether a rule separates this row from the one above it. */
    ruleAbove: boolean;
}> = ({ batch, ruleAbove }) => {
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
    // Cancelled is not an outcome; a tick would claim one. Neutral icon keeps the column aligned.
    const isCancelled = batch.status === 'cancelled';
    // Older records omit this; fall back to the headline, do not invent a title.
    const title = batch.progress_title?.trim();

    return (
        <div className={['display-flex flex-col min-w-0', ruleAbove && 'border-top-quinary'].filter(Boolean).join(' ')}>
            <div
                className="display-flex flex-col px-3 py-15 min-w-0 cursor-pointer"
                onClick={toggle}
                onKeyDown={onKeyDown}
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
            >
                <div className="display-flex flex-row items-center gap-2 min-w-0">
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
                    className={`font-color-primary font-medium opacity-70 text-base ${title ? 'truncate' : 'flex-none'}`}
                    title={title || undefined}
                >
                    {title || batch.progress_primary}
                </span>
                {!title && batch.progress_secondary && (
                    <span className="font-color-secondary opacity-60 text-sm truncate">
                        {batch.progress_secondary}
                    </span>
                )}
                {title && (
                    <span className="font-color-secondary opacity-70 text-sm flex-none">
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

                {/* Goal when the title alone cannot distinguish two batches of one operation. */}
                {batch.goal && !isExpanded && (
                    <div
                        className="font-color-secondary opacity-70 text-sm truncate"
                        style={{ paddingLeft: 20 }}
                        title={batch.goal}
                    >
                        {batch.goal}
                    </div>
                )}
            </div>

            {isExpanded && <BatchOutcomeBody batch={batch} bounded={false} />}
        </div>
    );
};

export interface BatchDoneRowsProps {
    /** Ended batches, already ordered by `selectRunBatchOutcomes`. */
    batches: readonly BatchProgressEntry[];
}

/**
 * Finished batches under the run in the transcript.
 *
 * The live panel does not keep these. Unbounded: the transcript already scrolls.
 */
export const BatchDoneRows: React.FC<BatchDoneRowsProps> = ({ batches }) => {
    if (batches.length === 0) return null;

    return (
        <div
            // Clip corners here so a client without Zotero's panes gets the same card.
            className="batch-run-receipt bg-senary border-popup rounded-md overflow-hidden display-flex flex-col min-w-0"
            role="group"
            aria-label="Completed batch operations"
        >
            {/* Match the approval card header. */}
            <div className="display-flex flex-row items-center gap-2 px-3 py-15 min-w-0 border-bottom-quinary">
                <Icon
                    icon={LayersIcon}
                    className="font-color-secondary scale-10 flex-none"
                />
                <div className="font-color-primary font-medium truncate">
                    {headingLabel(batches.length)}
                </div>
            </div>
            {batches.map((batch, index) => (
                <BatchDoneRow
                    key={batch.batch_id}
                    batch={batch}
                    ruleAbove={index > 0}
                />
            ))}
        </div>
    );
};

export default BatchDoneRows;
