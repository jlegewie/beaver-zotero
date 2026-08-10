import React, { useCallback, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { AgentRun } from '@beaver/agent-core/agents/types';
import { logger } from '@beaver/agent-core/platform/logger';
import { getAgentActionsByToolcallAtom } from '../../../../agents/agentActions';
import {
    annotationPanelStateAtom,
    defaultAnnotationPanelState,
    markReviewToolcallResolvedAtom,
    toggleAnnotationPanelVisibilityAtom,
} from '../../../../atoms/messageUIState';
import { applyAgentActionsAtom, rejectAgentActionsAtom } from '../../agentActionExecution';
import { getReviewHeaderCopy, ReviewRow } from '../reviewChangeRows';
import { ReviewActionRow } from './ReviewActionRow';
import {
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
import Button from '../../../../components/ui/Button';
import IconButton from '../../../../components/ui/IconButton';
import Tooltip from '../../../../components/ui/Tooltip';

/** Rows shown before the `Show all (N)` affordance. */
const MAX_VISIBLE_ROWS = 20;

interface ReviewChangesCardProps {
    run: AgentRun;
    /** From `useReviewRows`; the caller derives them so it can skip an empty card. */
    rows: ReviewRow[];
}

/**
 * Bottom-of-thread card for a terminal run's undecided agent actions: one row
 * per tool call, plus a collapsible aggregate header with a bulk reject/apply.
 */
export const ReviewChangesCard: React.FC<ReviewChangesCardProps> = ({ run, rows }) => {
    const [isHovered, setIsHovered] = useState(false);
    const [showAllRows, setShowAllRows] = useState(false);
    const [isBulkRunning, setIsBulkRunning] = useState(false);
    const [bulkApplyingToolcallId, setBulkApplyingToolcallId] = useState<string | null>(null);
    // Rows with a Zotero write of their own in flight; the bulk buttons wait them out.
    const [busyToolcallIds, setBusyToolcallIds] = useState<ReadonlySet<string>>(new Set());

    const applyAgentActions = useSetAtom(applyAgentActionsAtom);
    const rejectAgentActions = useSetAtom(rejectAgentActionsAtom);
    const markResolved = useSetAtom(markReviewToolcallResolvedAtom);

    // Read through a ref: the bulk loop needs each tool call's status as it is when
    // its turn comes, not as it was when the loop's closure was created.
    const getActionsByToolcall = useAtomValue(getAgentActionsByToolcallAtom);
    const getActionsByToolcallRef = useRef(getActionsByToolcall);
    getActionsByToolcallRef.current = getActionsByToolcall;

    // Expansion lives in the global panel state so it survives pane switches and
    // the separate window, like the other action cards.
    const groupId = `${run.id}:review`;
    const panelStates = useAtomValue(annotationPanelStateAtom);
    const isExpanded = (panelStates[groupId] ?? defaultAnnotationPanelState).resultsVisible;
    const togglePanelVisibility = useSetAtom(toggleAnnotationPanelVisibilityAtom);

    const handleRowResolved = useCallback(
        (toolcallId: string) => markResolved({ runId: run.id, toolcallId }),
        [markResolved, run.id],
    );

    const handleRowBusyChange = useCallback((toolcallId: string, isBusy: boolean) => {
        setBusyToolcallIds((current) => {
            const next = new Set(current);
            if (isBusy) next.add(toolcallId);
            else next.delete(toolcallId);
            return next;
        });
    }, []);

    const handleBulkApply = useCallback(async () => {
        if (isBulkRunning) return;
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
                // The snapshot's actions never see a status change, so re-read the
                // tool call: another surface (its in-stream card, this row's own ✓
                // just before the click) may have applied it since, and applying
                // the stale copy would write it to Zotero twice.
                const actions = getActionsByToolcallRef.current(
                    row.toolcallId,
                    (action) => action.run_id === run.id,
                );
                if (!actions.some((action) => action.status === 'pending')) continue;

                // Pin before dispatching: an apply flips status synchronously and
                // only then awaits the ack, so pinning afterwards would drop the
                // row out of the card for that round trip.
                markResolved({ runId: run.id, toolcallId: row.toolcallId });
                setBulkApplyingToolcallId(row.toolcallId);
                try {
                    await applyAgentActions({ actions, runId: run.id });
                } catch (error) {
                    // The executor records per-action failures itself; catching
                    // here only keeps one bad row from aborting the rest.
                    logger(`ReviewChangesCard: bulk apply failed for ${row.toolcallId}: ${error}`, 1);
                }
            }
        } finally {
            setBulkApplyingToolcallId(null);
            setIsBulkRunning(false);
        }
    }, [applyAgentActions, isBulkRunning, markResolved, rows, run.id]);

    const handleBulkReject = useCallback(() => {
        if (isBulkRunning) return;
        // A rejection is a local refusal with no Zotero write, so it covers every
        // pending row — including the ones bulk apply has to skip.
        const rowsToReject = rows.filter((row) => !row.resolved);
        if (rowsToReject.length === 0) return;

        for (const row of rowsToReject) {
            markResolved({ runId: run.id, toolcallId: row.toolcallId });
            rejectAgentActions({ actions: row.actions });
        }
    }, [isBulkRunning, markResolved, rejectAgentActions, rows, run.id]);

    // Expanding stays available during a bulk apply: the per-row spinners are the
    // only view of how far a long apply has got.
    const toggleExpanded = useCallback(
        () => togglePanelVisibility(groupId),
        [groupId, togglePanelVisibility],
    );

    if (rows.length === 0) return null;

    // A lone row is the whole card: no aggregate header to summarize.
    if (rows.length === 1) {
        return (
            <ReviewActionRow
                runId={run.id}
                row={rows[0]}
                isBulkApplying={rows[0].toolcallId === bulkApplyingToolcallId}
                isBulkRunning={isBulkRunning}
                onResolved={handleRowResolved}
                onBusyChange={handleRowBusyChange}
                inGroup={false}
            />
        );
    }

    const { text: headerText, tone } = getReviewHeaderCopy(rows);
    const hasPendingRows = rows.some((row) => !row.resolved);
    const allApplied = rows.every((row) => row.actions.every((action) => action.status === 'applied'));
    // A row applying on its own must finish before a bulk run can start, or the
    // same tool call would be written to Zotero twice.
    const bulkAvailable = !isBulkRunning && busyToolcallIds.size === 0;
    const showBulkReject = hasPendingRows && bulkAvailable;
    // Nothing left for the header ✓ once only non-bulk-applicable rows are pending;
    // showing it then would be a dead click.
    const showBulkApply = bulkAvailable && rows.some((row) => !row.resolved && row.bulkApplicable);
    const visibleRows = showAllRows ? rows : rows.slice(0, MAX_VISIBLE_ROWS);

    const headerIcon = (() => {
        if (isBulkRunning) return Spinner;
        if (isHovered && isExpanded) return ArrowDownIcon;
        if (isHovered && !isExpanded) return ArrowRightIcon;
        if (tone === 'review') return ClockIcon;
        return allApplied ? CheckmarkCircleIcon : CancelCircleIcon;
    })();
    const headerIconClassName = !isBulkRunning && !isHovered && tone === 'resolved'
        ? `${allApplied ? 'font-color-green' : 'font-color-red'} scale-11`
        : undefined;

    return (
        <div className="border-popup rounded-md display-flex flex-col min-w-0">
            <div
                className={`display-flex flex-row py-15 bg-senary items-start ${isExpanded ? 'border-bottom-quinary' : ''}`}
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
                        <div className="flex-1 display-flex mt-010 font-color-primary">
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

                {(showBulkReject || showBulkApply) && (
                    <div className="display-flex flex-row items-center gap-25 mr-3 mt-015">
                        {showBulkReject && (
                            <Tooltip content="Reject all" showArrow singleLine>
                                <IconButton
                                    icon={CancelIcon}
                                    variant="ghost-secondary"
                                    iconClassName="font-color-red"
                                    onClick={handleBulkReject}
                                />
                            </Tooltip>
                        )}
                        {showBulkApply && (
                            <Tooltip content="Apply all" showArrow singleLine>
                                <IconButton
                                    icon={TickIcon}
                                    variant="ghost-secondary"
                                    iconClassName="font-color-green scale-14"
                                    onClick={handleBulkApply}
                                />
                            </Tooltip>
                        )}
                    </div>
                )}
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
                                isBulkApplying={row.toolcallId === bulkApplyingToolcallId}
                                isBulkRunning={isBulkRunning}
                                onResolved={handleRowResolved}
                                onBusyChange={handleRowBusyChange}
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

export default ReviewChangesCard;
