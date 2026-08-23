import React, { useCallback, useState } from 'react';
import type { BatchProgressEntry } from '@beaver/agent-core/run-state/batchProgress';
import { hasBatchEnded } from '@beaver/agent-core/run-state/batchProgress';
import { ArrowDownIcon, Icon, LayersIcon, TickIcon } from '../icons';
import {
    BatchBlockHeading,
    BatchOutcomeBlocks,
    BatchProgressTrack,
} from './BatchOutcomeBlocks';

const WAITING_HEADING = 'Waiting';
/** Lower case: continues the line above it. */
const QUEUE_PREFIX = 'then ';

/** Remaining batches as "then Filing items, Tagging items ×2". */
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

export interface BatchProgressBarProps {
    /** The batch the bar tracks — the one being worked. */
    batch: BatchProgressEntry;
    /**
     * Other batches on the stamp. Ended ones are filtered out here — a stamp
     * can carry a batch that finished on the same call that moved this one.
     */
    otherBatches?: readonly BatchProgressEntry[];
}

/**
 * Live progress for a batch operation, shown above the composer.
 *
 * Collapsed: one line and a 2px segmented hairline. Expanded: goal, counts,
 * and (when the operation has one) the outcome distribution.
 *
 * Read-only — stopping is the composer's Stop button. Silent about review
 * status: the ledger counts an item resolved once the agent has proposed the
 * edit, so "184 of 184" can sit next to 184 unreviewed changes. That belongs
 * on the run's review card.
 */
export const BatchProgressBar: React.FC<BatchProgressBarProps> = ({
    batch,
    otherBatches = [],
}) => {
    // Collapsed by default so the panel does not push the composer down mid-run.
    const [isExpanded, setIsExpanded] = useState(false);
    const toggle = useCallback(() => setIsExpanded((open) => !open), []);
    const onKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsExpanded((open) => !open);
        }
    }, []);

    // Backend omits default-valued fields — default here, never test `=== 'active'`.
    const status = batch.status ?? 'active';
    const total = batch.total ?? 0;
    const resolved = batch.resolved ?? 0;
    const noChange = batch.no_change ?? 0;
    const failed = batch.failed ?? 0;
    // `cancelled` batches are dropped from the stamp backend-side.
    const isOver = status === 'completed' || status === 'failed_out';
    const hasFailures = failed > 0 || status === 'failed_out';

    const share = (count: number) => (total > 0 ? (count / total) * 100 : 0);
    // A determinate track at zero reads as stalled before the first outcome.
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

    // Older records omit this; fall back to the headline, do not invent a title.
    const title = batch.progress_title?.trim();

    // A stamp can carry a batch that finished on the same call as this one.
    const otherShown = otherBatches.filter(
        (entry) => entry.show_progress && !hasBatchEnded(entry),
    );
    const queued = queueSummary(otherShown);

    return (
        <div
            className="batch-progress-bar bg-senary border-bottom-quinary"
            style={{ position: 'relative' }}
            role="group"
            aria-label="Batch operation progress"
        >
            {/* Overlay so it does not stack on the composer's 1px top border. */}
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
                {/* Title is the only part of the line that may truncate. */}
                <span
                    className={`font-color-primary font-medium text-base ${title ? 'truncate' : 'flex-none'}`}
                    title={title || undefined}
                >
                    {title || batch.progress_primary}
                </span>
                {!title && batch.progress_secondary && (
                    <span className="font-color-secondary text-sm truncate">
                        {batch.progress_secondary}
                    </span>
                )}
                {title && (
                    <span className="font-color-secondary text-sm flex-none">
                        {batch.progress_primary}
                    </span>
                )}
                {hasFailures && (
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
                        {`${failed.toLocaleString()} failed`}
                    </span>
                )}
                {/* Orange on failure so a green tick does not claim success. */}
                {isOver && (
                    <Icon
                        icon={TickIcon}
                        className={`flex-none scale-12 ${hasFailures ? 'font-color-orange' : 'font-color-green'}`}
                    />
                )}
                <div className="flex-1" />
                <Icon
                    icon={ArrowDownIcon}
                    className="font-color-secondary flex-none scale-85 transition"
                    style={{ transform: isExpanded ? 'rotate(180deg)' : undefined }}
                />
                </div>

                {queued && (
                    <div
                        className="font-color-secondary text-sm truncate opacity-60"
                        style={{ paddingLeft: 20 }}
                    >
                        {queued}
                    </div>
                )}
            </div>

            {isExpanded && (
                /* Bounded: the composer block this sits in never shrinks. */
                <div
                    className="display-flex flex-col gap-5 px-3 pb-3 min-w-0"
                    style={{
                        maxHeight: 'max(120px, calc(100vh - 320px))',
                        overflowY: 'auto',
                        overflowX: 'hidden',
                    }}
                >
                    {batch.goal && (
                        <div className="font-color-secondary text-base">{batch.goal}</div>
                    )}

                    <BatchProgressTrack batch={batch} />

                    <BatchOutcomeBlocks batch={batch} />

                    {otherShown.length > 0 && (
                        <div className="display-flex flex-col gap-1 min-w-0">
                            <BatchBlockHeading>{WAITING_HEADING}</BatchBlockHeading>
                            {otherShown.map((entry) => (
                                <div
                                    key={entry.batch_id}
                                    className="display-flex flex-col min-w-0 text-sm"
                                >
                                    <div className="display-flex flex-row items-center gap-2 min-w-0">
                                        <Icon
                                            icon={LayersIcon}
                                            className="font-color-secondary flex-none scale-90"
                                        />
                                        <span className="font-color-primary font-medium opacity-80 truncate">
                                            {entry.progress_title?.trim() ||
                                                entry.progress_primary}
                                        </span>
                                        <span className="font-color-secondary flex-none">
                                            {entry.progress_title?.trim()
                                                ? entry.progress_primary
                                                : entry.progress_secondary}
                                        </span>
                                        <div className="flex-1" />
                                    </div>
                                    {entry.goal && (
                                        <div
                                            className="font-color-secondary truncate opacity-60"
                                            style={{ paddingLeft: 18 }}
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
