import React, { useCallback, useState } from 'react';
import type { BatchProgressEntry } from '@beaver/agent-core/run-state/batchProgress';
import { ArrowDownIcon, CancelCircleIcon, Icon, LayersIcon, TickIcon } from '../icons';
import { BatchFailureChip, BatchOutcomeBody } from './BatchOutcomeBlocks';

/** Heading copied from the approval card. Keep in step with the backend string. */
const headingLabel = (count: number): string =>
    count === 1 ? 'Batch job' : 'Batch jobs';

/**
 * What names this row. Older records carry no title, so the headline stands in.
 */
function leadLabel(batch: BatchProgressEntry): string {
    return batch.progress_title?.trim() || batch.progress_primary;
}

/** The outcome half of the row. */
function trailLabel(batch: BatchProgressEntry): string | undefined {
    if (batch.detail_label) return batch.detail_label;
    return batch.progress_title?.trim() ? batch.progress_primary : batch.progress_secondary;
}

/** Labels more than one row in the same card carries. */
function duplicateLeadLabels(batches: readonly BatchProgressEntry[]): Set<string> {
    const counts = new Map<string, number>();
    for (const batch of batches) {
        const label = leadLabel(batch);
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return new Set([...counts].filter(([, count]) => count > 1).map(([label]) => label));
}

/** One finished batch, collapsed until opened. */
const BatchDoneRow: React.FC<{
    batch: BatchProgressEntry;
    /** Whether a rule separates this row from the one above it. */
    ruleAbove: boolean;
    /** Whether to spend a second line on the goal. */
    showGoal: boolean;
}> = ({ batch, ruleAbove, showGoal }) => {
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
    const lead = leadLabel(batch);
    const trail = trailLabel(batch);

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
                {/* Both halves may shrink, but the trail is the longer string and
                    so gives way first. */}
                <span
                    className="font-color-primary text-base truncate min-w-0"
                    style={{ flex: '0 1 auto' }}
                    title={lead}
                >
                    {lead}
                </span>
                {/* Present even when empty: it is also the spacer that pushes the
                    chip and the chevron to the end of the row. */}
                <span
                    className="font-color-secondary opacity-70 text-sm truncate flex-1 min-w-0"
                    title={trail || undefined}
                >
                    {trail}
                </span>
                <BatchFailureChip batch={batch} />
                <Icon
                    icon={ArrowDownIcon}
                    className="font-color-secondary flex-none scale-85 transition"
                    style={{ transform: isExpanded ? 'rotate(180deg)' : undefined }}
                />
                </div>

                {/* Goal when the label alone cannot distinguish two batches of one operation. */}
                {showGoal && batch.goal && !isExpanded && (
                    <div
                        className="font-color-secondary opacity-70 text-sm truncate"
                        style={{ paddingLeft: 20 }}
                        title={batch.goal}
                    >
                        {batch.goal}
                    </div>
                )}
            </div>

            {isExpanded && <BatchOutcomeBody batch={batch} bounded={false} revealTargets />}
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

    // Two batches of one operation share a label ("Edited items" twice), and
    // then only the goal tells them apart.
    const ambiguousLabels = duplicateLeadLabels(batches);

    return (
        <div
            // Clip corners here so a client without Zotero's panes gets the same card.
            className="batch-run-receipt bg-senary border-popup rounded-md overflow-hidden display-flex flex-col min-w-0"
            role="group"
            aria-label="Completed batch jobs"
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
                    showGoal={ambiguousLabels.has(leadLabel(batch))}
                />
            ))}
        </div>
    );
};

export default BatchDoneRows;
