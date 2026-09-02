import React, { useCallback } from 'react';
import type { BatchProgressEntry } from '@beaver/agent-core/run-state/batchProgress';
import { ArrowDownIcon, Icon, LayersIcon, TickIcon } from '../icons';
import {
    BatchBlockHeading,
    BatchFailureChip,
    BatchOutcomeBody,
} from './BatchOutcomeBlocks';

const WAITING_HEADING = 'Waiting';
/** Per-block row cap for the live panel. Hidden rows still count in "+ N more". */
const PANEL_MAX_TALLY_ROWS = 5;
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
     * Batches still waiting their turn, in the order they will be worked.
     * Already grouped by `selectBatchPanelGroups` — this filters nothing.
     * Finished batches are not here; they belong to `BatchDoneRows`.
     */
    queuedBatches?: readonly BatchProgressEntry[];
    /**
     * Whether the outcome body is open. The panel owns this so completion
     * cannot close it on the user.
     */
    expanded?: boolean;
    onExpandedChange?: (expanded: boolean) => void;
}

/**
 * Live progress for a batch job, shown above the composer.
 *
 * Collapsed (the default): one line and a 2px segmented hairline. Expanded:
 * goal, counts, and (when the operation has one) the outcome distribution.
 * Expansion is owned by the caller.
 *
 * Read-only — stopping is the composer's Stop button. Silent about review
 * status: the ledger counts an item resolved once the agent has proposed the
 * edit, so "184 of 184" can sit next to 184 unreviewed changes. That belongs
 * on the run's changes card.
 */
export const BatchProgressBar: React.FC<BatchProgressBarProps> = ({
    batch,
    queuedBatches = [],
    expanded = false,
    onExpandedChange,
}) => {
    const toggle = useCallback(() => onExpandedChange?.(!expanded), [expanded, onExpandedChange]);
    const onKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onExpandedChange?.(!expanded);
        }
    }, [expanded, onExpandedChange]);

    // Backend omits default-valued fields — default here, never test `=== 'active'`.
    const status = batch.status ?? 'active';
    const total = batch.total ?? 0;
    const resolved = batch.resolved ?? 0;
    const noChange = batch.no_change ?? 0;
    const findings = batch.findings ?? 0;
    const failed = batch.failed ?? 0;
    // `cancelled` batches are dropped from the stamp backend-side.
    const isOver = status === 'completed' || status === 'failed_out';
    const hasFailures = failed > 0 || status === 'failed_out';

    const share = (count: number) => (total > 0 ? (count / total) * 100 : 0);
    // A determinate track at zero reads as stalled before the first outcome.
    const isIndeterminate =
        status === 'active' && resolved + noChange + findings + failed === 0;
    const segments = isIndeterminate ? (
        <div className="batch-progress-indeterminate" />
    ) : (
        <>
            <div style={{ width: `${share(resolved)}%`, backgroundColor: 'var(--accent-blue)' }} />
            <div style={{ width: `${share(noChange)}%`, backgroundColor: 'var(--fill-tertiary)' }} />
            <div style={{ width: `${share(findings)}%`, backgroundColor: 'var(--tag-purple)' }} />
            <div style={{ width: `${share(failed)}%`, backgroundColor: 'var(--tag-orange)' }} />
        </>
    );

    // Older records omit this; fall back to the headline, do not invent a title.
    const title = batch.progress_title?.trim();

    const queued = queueSummary(queuedBatches);

    return (
        <div
            className="composer-docked-bar batch-progress-bar border-bottom-quinary"
            style={{ position: 'relative' }}
            role="group"
            aria-label="Batch job progress"
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
                aria-valuenow={resolved + noChange + findings}
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
                aria-expanded={expanded}
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
                <BatchFailureChip batch={batch} />
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
                    style={{ transform: expanded ? 'rotate(180deg)' : undefined }}
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

            {expanded && (
                <BatchOutcomeBody batch={batch} maxRows={PANEL_MAX_TALLY_ROWS}>
                    {queuedBatches.length > 0 && (
                        <div className="display-flex flex-col gap-1 min-w-0">
                            <BatchBlockHeading>{WAITING_HEADING}</BatchBlockHeading>
                            {queuedBatches.map((entry) => (
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
                </BatchOutcomeBody>
            )}
        </div>
    );
};

export default BatchProgressBar;
