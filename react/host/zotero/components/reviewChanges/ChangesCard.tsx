import React, { useCallback, useEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { AgentRun } from '@beaver/agent-core/agents/types';
import { logger } from '@beaver/agent-core/platform/logger';
import { getAgentActionsByToolcallAtom } from '../../../../agents/agentActions';
import {
    annotationPanelStateAtom,
    clearRetainedReviewActionsForRunAtom,
    defaultAnnotationPanelState,
    dismissAppliedActionsAtom,
    retainReviewActionsAtom,
    setToolExpandedAtom,
    toggleAnnotationPanelVisibilityAtom,
} from '../../../../atoms/messageUIState';
import {
    applyAgentActionsAtom,
    inFlightAgentActionIdsAtom,
    rejectAgentActionsAtom,
} from '../../agentActionExecution';
import { getCompletedHeaderCopy, getReviewHeaderCopy, hasPendingReviewRows, ReviewRow } from '../reviewChangeRows';
import { ReviewActionRow } from './ReviewActionRow';
import {
    AlertIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    CancelCircleIcon,
    CancelIcon,
    CheckmarkCircleIcon,
    ClockIcon,
    Icon,
    Spinner,
    TickIcon,
} from '../../../../components/icons/icons';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';

/** Rows shown before the `Show all (N)` affordance. */
const MAX_VISIBLE_ROWS = 12;
const REVIEW_EXIT_DELAY_MS = 600;
const REVIEW_FADE_MS = 200;

/**
 * Which set of changes the card presents. `'review'` offers the run's undecided
 * actions with a bulk apply/reject; `'completed'` lists what the run has already
 * written, with the per-row undo the rows carry anyway and a dismiss instead of
 * any bulk operation.
 */
export type ChangesCardMode = 'review' | 'completed';

interface ChangesCardProps {
    run: AgentRun;
    /** From `useReviewRows` / `useCompletedRows`; the caller derives them so it can skip an empty card. */
    rows: ReviewRow[];
    /** Defaults to `'review'`. */
    mode?: ChangesCardMode;
}

/**
 * Bottom-of-thread card for a terminal run's agent actions: one row per tool
 * call under a collapsible aggregate header. See `ChangesCardMode` for what the
 * header offers in each mode.
 */
export const ChangesCard: React.FC<ChangesCardProps> = ({ run, rows, mode = 'review' }) => {
    const isCompleted = mode === 'completed';
    const [isHovered, setIsHovered] = useState(false);
    const [showAllRows, setShowAllRows] = useState(false);
    const [isBulkRunning, setIsBulkRunning] = useState(false);
    const [isFadingOut, setIsFadingOut] = useState(false);
    const [isDismissed, setIsDismissed] = useState(false);

    const applyAgentActions = useSetAtom(applyAgentActionsAtom);
    const rejectAgentActions = useSetAtom(rejectAgentActionsAtom);
    const retainActions = useSetAtom(retainReviewActionsAtom);
    const clearRetainedActionsForRun = useSetAtom(clearRetainedReviewActionsForRunAtom);
    const setToolExpanded = useSetAtom(setToolExpandedAtom);
    const dismissAppliedActions = useSetAtom(dismissAppliedActionsAtom);

    // The jotai getter this closure carries reads the store when it is called, so
    // the bulk loop sees each tool call's status as of its turn, not of the click.
    const getActionsByToolcall = useAtomValue(getAgentActionsByToolcallAtom);

    // Expansion lives in the global panel state so it survives pane switches and
    // the separate window, like the other action cards.
    const groupId = `${run.id}:${mode}`;
    const panelStates = useAtomValue(annotationPanelStateAtom);
    const isExpanded = (panelStates[groupId] ?? defaultAnnotationPanelState).resultsVisible;
    const togglePanelVisibility = useSetAtom(toggleAnnotationPanelVisibilityAtom);

    // Whether a write is in flight comes from the executor's claim, which is the
    // only signal that also sees writes started elsewhere (another pane, or the
    // in-stream card for the same tool call). Whether *this* card is running a bulk
    // apply stays local — a shared flag left set by a pane that went away would
    // disable the card for good, since loading a thread does not reset it.
    const inFlightActionIds = useAtomValue(inFlightAgentActionIdsAtom);
    const hasWritingRow = rows.some((row) => row.actions.some((action) => inFlightActionIds.has(action.id)));
    const hasPendingRows = hasPendingReviewRows(rows);

    useEffect(() => {
        // The completed card is dismissed by the user, never by its own contents
        // settling: every row in it is settled from the start.
        if (isCompleted || hasPendingRows) {
            setIsFadingOut(false);
            setIsDismissed(false);
            return;
        }

        // Give the terminal status a brief moment to register, then fade the
        // complete card as one unit so individual rows never shift the layout.
        setIsFadingOut(true);
        const timer = setTimeout(() => {
            setIsDismissed(true);
            // Retention is shared by all Beaver React roots. Clearing it makes
            // dismissal shared too, so a later sidebar/window remount cannot
            // reconstruct and replay this resolved card.
            clearRetainedActionsForRun(run.id);
        }, REVIEW_EXIT_DELAY_MS + REVIEW_FADE_MS);
        return () => clearTimeout(timer);
    }, [clearRetainedActionsForRun, hasPendingRows, isCompleted, run.id]);

    const exitStyle: React.CSSProperties = {
        opacity: isFadingOut ? 0 : 1,
        transition: isFadingOut
            ? `opacity ${REVIEW_FADE_MS}ms ease ${REVIEW_EXIT_DELAY_MS}ms`
            : undefined,
        pointerEvents: isFadingOut ? 'none' : undefined,
    };

    const handleRowResolved = useCallback(
        (actionIds: string[]) => retainActions({ runId: run.id, actionIds }),
        [retainActions, run.id],
    );

    const handleBulkApply = useCallback(async () => {
        if (isBulkRunning || hasWritingRow) return;
        // Snapshot at click time. Non-bulk-applicable rows (annotation deletions,
        // destructive note rewrites) are their own approval groups in
        // runApprovalPolicy so that approving annotation or note edits never
        // carries them along — the bulk ✓ must not re-open that. They stay in the
        // card with their own ✓.
        const rowsToApply = rows.filter((row) => row.bulkApplicable && !row.resolved);
        if (rowsToApply.length === 0) return;

        setIsBulkRunning(true);
        try {
            // Sequential on purpose: a 50-action apply must not hammer the Zotero
            // DB, and in-order application keeps multi-step changes (create a
            // collection, then file items into it) coherent.
            for (const row of rowsToApply) {
                // Re-read, and take only what is still pending: the click-time
                // snapshot can never see a status change, so applying it could
                // re-run a tool call another surface has since applied — or worse,
                // re-create an item the user undone or rejected in the meantime.
                const actions = getActionsByToolcall(
                    row.toolcallId,
                    (action) => action.run_id === run.id && action.status === 'pending',
                );
                if (actions.length === 0) continue;

                retainActions({ runId: run.id, actionIds: actions.map((action) => action.id) });
                try {
                    await applyAgentActions({ actions, runId: run.id });
                } catch (error) {
                    // The executor records per-action failures itself; catching
                    // here only keeps one bad row from aborting the rest.
                    logger(`ChangesCard: bulk apply failed for ${row.toolcallId}: ${error}`, 1);
                }
            }
        } finally {
            setIsBulkRunning(false);
        }
    }, [applyAgentActions, getActionsByToolcall, hasWritingRow, isBulkRunning, retainActions, rows, run.id]);

    const handleBulkReject = useCallback(() => {
        if (isBulkRunning || hasWritingRow) return;
        // A rejection is a local refusal with no Zotero write, so it covers every
        // pending row — including the ones bulk apply has to skip.
        const rowsToReject = rows.filter((row) => !row.resolved);
        if (rowsToReject.length === 0) return;

        for (const row of rowsToReject) {
            const actions = row.actions.filter((action) => action.status === 'pending');
            if (actions.length === 0) continue;
            retainActions({ runId: run.id, actionIds: actions.map((action) => action.id) });
            rejectAgentActions({ actions });
        }
    }, [hasWritingRow, isBulkRunning, rejectAgentActions, retainActions, rows, run.id]);

    // Dismissal only drops the run's changes from this session's snapshot. The
    // changes stay applied in Zotero and in the thread's history — the card is a
    // post-run affordance, not the record.
    const handleDismiss = useCallback(() => {
        dismissAppliedActions(rows.flatMap((row) => row.actions.map((action) => action.id)));
    }, [dismissAppliedActions, rows]);

    // Expanding stays available during a bulk apply: the per-row spinners are the
    // only view of how far a long apply has got. When there is only one row, open
    // its preview along with the card; multiple rows stay collapsed for scanning.
    const toggleExpanded = useCallback(() => {
        if (!isExpanded && rows.length === 1) {
            setToolExpanded({
                key: `${run.id}:${mode}:${rows[0].toolcallId}`,
                expanded: true,
            });
        }
        togglePanelVisibility(groupId);
    }, [groupId, isExpanded, mode, rows, run.id, setToolExpanded, togglePanelVisibility]);

    if (rows.length === 0 || (isDismissed && !hasPendingRows)) return null;

    // A one-row completed card would print its aggregate header above a row
    // saying the same thing ("Organized 1 item" over "Organize 1 item"), so the
    // row is the card: it already carries the icon, the title of what changed,
    // and the undo/retry cluster the header would have to borrow anyway.
    if (isCompleted && rows.length === 1) {
        return (
            <ReviewActionRow
                runId={run.id}
                row={rows[0]}
                expansionScope={mode}
                onDismiss={handleDismiss}
            />
        );
    }

    const reviewCopy = getReviewHeaderCopy(rows);
    const headerText = isCompleted ? getCompletedHeaderCopy(rows) : reviewCopy.text;
    // The completed header names live changes, so it keeps the emphasis the
    // review header only has while something is still pending.
    const tone = isCompleted ? 'review' : reviewCopy.tone;
    const allApplied = rows.every((row) => row.actions.every((action) => action.status === 'applied'));
    const hasFailedRow = rows.some((row) => row.actions.some((action) => action.status === 'error'));
    // A row applying on its own must finish before a bulk run starts, or the same
    // tool call would be written to Zotero twice. Disabled rather than unmounted:
    // the buttons keep their place, and a write that never reports back leaves the
    // card looking busy instead of looking like it has no controls at all.
    const bulkDisabled = isBulkRunning || hasWritingRow;
    // Nothing left for the header ✓ once only non-bulk-applicable rows are pending;
    // showing it then would be a dead click.
    const showBulkApply = rows.some((row) => !row.resolved && row.bulkApplicable);
    const visibleRows = showAllRows ? rows : rows.slice(0, MAX_VISIBLE_ROWS);

    // Completed rows can have been undone or have failed an undo since they were
    // applied, so the icon reports the card's current state rather than assuming
    // everything in it is still applied.
    const completedIcon = hasFailedRow ? AlertIcon : allApplied ? CheckmarkCircleIcon : CancelCircleIcon;
    const completedIconClassName = hasFailedRow
        ? 'color-error'
        : allApplied ? 'font-color-green' : 'font-color-red';

    const headerIcon = (() => {
        if (isBulkRunning || hasWritingRow) return Spinner;
        if (isHovered && isExpanded) return ArrowDownIcon;
        if (isHovered && !isExpanded) return ArrowRightIcon;
        if (isCompleted) return completedIcon;
        if (tone === 'review') return ClockIcon;
        return allApplied ? CheckmarkCircleIcon : CancelCircleIcon;
    })();
    const headerIconClassName = (() => {
        if (isBulkRunning || hasWritingRow || isHovered) return undefined;
        if (isCompleted) return completedIconClassName;
        if (tone === 'resolved') return allApplied ? 'font-color-green' : 'font-color-red';
        return undefined;
    })();

    return (
        <div className="border-popup rounded-md display-flex flex-col min-w-0" style={exitStyle}>
            <div
                className={`display-flex flex-row py-15 bg-senary items-center ${isExpanded ? 'border-bottom-quinary' : ''}`}
            >
                <button
                    type="button"
                    className="variant-ghost-secondary display-flex flex-row py-15 gap-2 text-left mt-015"
                    style={{ fontSize: '0.95rem', background: 'transparent', border: 0, padding: 0 }}
                    aria-expanded={isExpanded}
                    onClick={toggleExpanded}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                >
                    <div className="display-flex flex-row ml-3 gap-2">
                        <div className="flex-1 display-flex font-color-primary scale-11">
                            <Icon icon={headerIcon} className={headerIconClassName} />
                        </div>
                        <div className="display-flex">
                            <span className={tone === 'resolved' ? 'font-color-secondary' : 'font-color-primary font-medium'}>
                                {headerText}
                            </span>
                        </div>
                    </div>
                </button>

                <div className="flex-1" />

                {isCompleted && (
                    <div className="display-flex flex-row items-center gap-25 mr-3 mt-015">
                        <Tooltip content="Dismiss" showArrow singleLine>
                            <IconButton
                                icon={CancelIcon}
                                variant="ghost-secondary"
                                onClick={handleDismiss}
                                ariaLabel="Dismiss"
                            />
                        </Tooltip>
                    </div>
                )}

                {!isCompleted && hasPendingRows && <div className="display-flex flex-row items-center gap-25 mr-3 mt-015">
                    <Tooltip content="Reject all" showArrow singleLine>
                        <IconButton
                            icon={CancelIcon}
                            variant="ghost-secondary"
                            iconClassName="font-color-red"
                            onClick={handleBulkReject}
                            disabled={bulkDisabled}
                        />
                    </Tooltip>
                    {showBulkApply && (
                        <Tooltip content="Apply all" showArrow singleLine>
                            <IconButton
                                icon={TickIcon}
                                variant="ghost-secondary"
                                iconClassName="font-color-green scale-14"
                                onClick={handleBulkApply}
                                disabled={bulkDisabled}
                            />
                        </Tooltip>
                    )}
                </div>}
            </div>

            {isExpanded && (
                <div className="display-flex flex-col">
                    {visibleRows.map((row, idx) => (
                        <div
                            key={row.toolcallId}
                            className={idx > 0 ? 'border-top-quinary' : undefined}
                        >
                            <ReviewActionRow
                                runId={run.id}
                                row={row}
                                expansionScope={mode}
                                isBulkRunning={isBulkRunning}
                                // The completed card's snapshot is the session's
                                // applied set, which a status change does not
                                // touch — retaining here would instead hide the
                                // row from its own card.
                                onResolved={isCompleted ? undefined : handleRowResolved}
                                inGroup
                            />
                        </div>
                    ))}

                    {visibleRows.length < rows.length && (
                        <div className="display-flex flex-row px-2 py-2 border-top-quinary">
                            <Button
                                variant="ghost-secondary"
                                onClick={() => setShowAllRows(true)}
                            >
                                {`Show all (${rows.length})`}
                            </Button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default ChangesCard;
