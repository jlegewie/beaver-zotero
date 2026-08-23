import React, { useCallback, useState } from 'react';
import type { BatchProgressEntry } from '@beaver/agent-core/run-state/batchProgress';
import { ArrowDownIcon, CancelCircleIcon, Icon, LayersIcon, TickIcon } from '../icons';
import { BatchFailureChip, BatchOutcomeBody } from './BatchOutcomeBlocks';

/**
 * Where a stack of finished batches is drawn, which is all that separates the
 * two: the same rows, opening onto the same record.
 *
 * `panel` sits on top of the composer for the rest of the live run. `receipt`
 * is what the run keeps afterwards, in the transcript.
 */
export type BatchDoneRowsVariant = 'panel' | 'receipt';

interface DoneRowsChrome {
    /** Container classes. */
    className: string;
    /**
     * Rows shown before the rest fold behind one line, or unbounded.
     *
     * Folding only pays where a row costs something. The overflow line IS a
     * row, so hiding one behind it saves nothing at all and hiding two saves
     * one line — worth it only where the stack pushes the composer down the
     * pane, which the transcript does not.
     */
    maxVisible: number;
    /** Row height. */
    rowPadding: string;
    /** Whether rows are ruled off from one another. */
    ruled: boolean;
    /**
     * Whether a row carries its batch's goal under the title.
     *
     * Titles are per-operation, not per-batch: a run that edits metadata twice
     * writes "Edited items" twice, and only the goal says which was the DOI
     * pass and which the abstracts. In the panel one of the two is usually the
     * bar's own, and the space above the composer is dearer than the ambiguity.
     */
    showGoal: boolean;
    /**
     * Whether the stack names itself. The panel does not need to: the live bar
     * sits directly above it carrying the same icon and the batch it tracks.
     * The receipt has no bar, so without this its rows are ticks and numbers
     * with nothing saying what kind of thing they are — beside a review card
     * counting changes, that is a real ambiguity.
     */
    heading: boolean;
    /** See `BatchOutcomeBody`'s `bounded`. */
    boundBody: boolean;
}

const CHROME: Record<BatchDoneRowsVariant, DoneRowsChrome> = {
    // Above the composer in a sidebar, past a couple of rows the stack costs
    // more room than the receipt is worth — and the rest is one line away.
    panel: {
        className: 'batch-done-rows bg-senary border-bottom-quinary',
        maxVisible: 2,
        rowPadding: 'py-1',
        ruled: false,
        showGoal: false,
        heading: false,
        boundBody: true,
    },
    // A card in the transcript scrolls away instead of pushing the composer
    // down, so it hides nothing and can afford the room the run's other cards take.
    receipt: {
        // Clips its own corners rather than leaning on a host stylesheet, so a
        // client without Zotero's panes gets the same card.
        className: 'batch-run-receipt bg-senary border-popup rounded-md overflow-hidden',
        maxVisible: Number.POSITIVE_INFINITY,
        rowPadding: 'py-15',
        ruled: true,
        showGoal: true,
        heading: true,
        // The transcript is the scroller here; a second one nested in it would
        // swallow the wheel.
        boundBody: false,
    },
};

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
 * What the receipt calls itself.
 *
 * The words the approval card is titled with, which is where the user first
 * meets one of these — the backend owns that string and this is the client's
 * matching slot heading, so the two must be kept in step by hand. A third name
 * for the same thing is worse than a plain one.
 */
const headingLabel = (count: number): string =>
    count === 1 ? 'Batch operation' : 'Batch operations';

/**
 * One finished batch, collapsed to a line that can be opened for its outcome.
 *
 * Deliberately quieter than the live bar: no progress hairline, since there is
 * nothing left to watch. Everything the bar states about an ended batch it
 * still states — the failure count included — from the same record and the same
 * components, so a batch cannot lose its numbers by finishing.
 */
const BatchDoneRow: React.FC<{
    batch: BatchProgressEntry;
    chrome: DoneRowsChrome;
    /** Whether a rule separates this row from the one above it. */
    ruleAbove: boolean;
}> = ({ batch, chrome, ruleAbove }) => {
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
        <div className={['display-flex flex-col min-w-0', ruleAbove && 'border-top-quinary'].filter(Boolean).join(' ')}>
            <div
                className={`display-flex flex-col px-3 ${chrome.rowPadding} min-w-0 cursor-pointer`}
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
                    <span className="font-color-secondary opacity-60 text-sm flex-none">
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

                {/* What this batch was for, when the title alone cannot say —
                    two batches of one operation share a title. Aligned under it,
                    and clipped to one line: the whole goal is a click away. */}
                {chrome.showGoal && batch.goal && !isExpanded && (
                    <div
                        className="font-color-tertiary text-sm truncate"
                        style={{ paddingLeft: 20 }}
                        title={batch.goal}
                    >
                        {batch.goal}
                    </div>
                )}
            </div>

            {isExpanded && <BatchOutcomeBody batch={batch} bounded={chrome.boundBody} />}
        </div>
    );
};

export interface BatchDoneRowsProps {
    /**
     * Batches that have ended. Already grouped by `selectBatchPanelGroups` or
     * `selectRunBatchOutcomes` — this filters nothing, and renders them in the
     * order it is handed them.
     */
    batches: readonly BatchProgressEntry[];
    /** Defaults to `'panel'`. See {@link BatchDoneRowsVariant}. */
    variant?: BatchDoneRowsVariant;
}

/**
 * A stack of finished batches, each opening onto what it did.
 *
 * A batch used to vanish the instant it ended: the bar tracks one batch, so the
 * moment a sibling took over, the one that just finished — and its numbers —
 * were gone. These rows are where it lands instead, first under the live bar
 * for the rest of the run (`panel`), then under the run itself once that run is
 * over (`receipt`). One stack, drawn twice, so a batch reads the same either
 * side of the handover.
 *
 * Capped in both places, so a run with many batches cannot bury what is under
 * it.
 */
export const BatchDoneRows: React.FC<BatchDoneRowsProps> = ({ batches, variant = 'panel' }) => {
    const [showAll, setShowAll] = useState(false);
    const toggle = useCallback(() => setShowAll((open) => !open), []);
    const onKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setShowAll((open) => !open);
        }
    }, []);

    if (batches.length === 0) return null;

    const chrome = CHROME[variant];
    const overflow = batches.length - chrome.maxVisible;
    const visible = showAll || overflow <= 0 ? batches : batches.slice(0, chrome.maxVisible);

    return (
        <div
            className={`${chrome.className} display-flex flex-col min-w-0`}
            role="group"
            aria-label="Completed batch operations"
        >
            {/* Same icon and treatment as the approval card's header, so the
                run's receipt reads as the same feature the user approved. */}
            {chrome.heading && (
                <div className="display-flex flex-row items-center gap-2 px-3 py-15 min-w-0 border-bottom-quinary">
                    <Icon
                        icon={LayersIcon}
                        className="font-color-secondary scale-10 flex-none"
                    />
                    <div
                        className="font-color-primary text-sm font-medium uppercase truncate"
                        style={{ letterSpacing: '0.05em' }}
                    >
                        {headingLabel(batches.length)}
                    </div>
                </div>
            )}
            {visible.map((batch, index) => (
                <BatchDoneRow
                    key={batch.batch_id}
                    batch={batch}
                    chrome={chrome}
                    ruleAbove={chrome.ruled && index > 0}
                />
            ))}
            {overflow > 0 && (
                <div
                    className={[
                        'display-flex flex-row items-center gap-2 px-3 min-w-0 cursor-pointer',
                        chrome.rowPadding,
                        chrome.ruled && 'border-top-quinary',
                    ]
                        .filter(Boolean)
                        .join(' ')}
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
