import React, { useCallback, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { AgentRun } from '@beaver/agent-core/agents/types';
import { logger } from '@beaver/agent-core/platform/logger';
import { getAgentActionsByRunAtom, pendingApprovalsAtom } from '../../../../agents/agentActions';
import {
    annotationPanelStateAtom,
    defaultAnnotationPanelState,
    markReviewToolcallResolvedAtom,
    resolvedReviewToolcallsAtom,
    toggleAnnotationPanelVisibilityAtom,
} from '../../../../atoms/messageUIState';
import { applyAgentActionsAtom, rejectAgentActionsAtom } from '../../agentActionExecution';
import { buildReviewRows, getReviewHeaderCopy } from '../reviewChangeRows';
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
}

/**
 * Bottom-of-thread card for a terminal run's undecided agent actions: one row
 * per tool call, plus a collapsible aggregate header with a bulk reject/apply.
 */
export const ReviewChangesCard: React.FC<ReviewChangesCardProps> = ({ run }) => {
    const [isHovered, setIsHovered] = useState(false);
    const [showAllRows, setShowAllRows] = useState(false);
    const [isBulkRunning, setIsBulkRunning] = useState(false);
    const [bulkApplyingToolcallId, setBulkApplyingToolcallId] = useState<string | null>(null);

    const getAgentActionsByRun = useAtomValue(getAgentActionsByRunAtom);
    const pendingApprovals = useAtomValue(pendingApprovalsAtom);
    const resolvedToolcalls = useAtomValue(resolvedReviewToolcallsAtom);

    const applyAgentActions = useSetAtom(applyAgentActionsAtom);
    const rejectAgentActions = useSetAtom(rejectAgentActionsAtom);
    const markResolved = useSetAtom(markReviewToolcallResolvedAtom);

    // Expansion lives in the global panel state so it survives pane switches and
    // the separate window, like the other action cards.
    const groupId = `${run.id}:review`;
    const panelStates = useAtomValue(annotationPanelStateAtom);
    const isExpanded = (panelStates[groupId] ?? defaultAnnotationPanelState).resultsVisible;
    const togglePanelVisibility = useSetAtom(toggleAnnotationPanelVisibilityAtom);

    const actions = useMemo(() => getAgentActionsByRun(run.id), [getAgentActionsByRun, run.id]);

    // Keyed by actionId; those actions belong to the in-stream card and PendingActionsBar.
    const liveApprovalActionIds = useMemo(
        () => new Set(pendingApprovals.keys()),
        [pendingApprovals],
    );

    const resolvedToolcallIds = useMemo(() => {
        const prefix = `${run.id}:`;
        const ids = new Set<string>();
        for (const [key, isResolved] of Object.entries(resolvedToolcalls)) {
            if (isResolved && key.startsWith(prefix)) ids.add(key.slice(prefix.length));
        }
        return ids;
    }, [resolvedToolcalls, run.id]);

    const rows = useMemo(
        () => buildReviewRows(actions, { liveApprovalActionIds, resolvedToolcallIds }),
        [actions, liveApprovalActionIds, resolvedToolcallIds],
    );

    const handleRowResolved = useCallback(
        (toolcallId: string) => markResolved({ runId: run.id, toolcallId }),
        [markResolved, run.id],
    );

    const handleBulkApply = useCallback(async () => {
        if (isBulkRunning) return;
        // Snapshot at click time: every applied row re-renders the card off action
        // status, so the loop must not read a list that changes underneath it.
        // Non-bulk-applicable rows (annotation deletions, destructive note
        // rewrites) are their own approval groups in runApprovalPolicy so that
        // approving annotation or note edits never carries them along — the bulk
        // ✓ must not re-open that. They stay in the card with their own ✓.
        const rowsToApply = rows.filter((row) => row.bulkApplicable && !row.resolved);
        if (rowsToApply.length === 0) return;

        setIsBulkRunning(true);
        try {
            // Sequential on purpose: a 50-action apply must not hammer the Zotero
            // DB, and in-order application keeps multi-step changes (create a
            // collection, then file items into it) coherent.
            for (const row of rowsToApply) {
                setBulkApplyingToolcallId(row.toolcallId);
                try {
                    await applyAgentActions({ actions: row.actions, runId: run.id });
                } catch (error) {
                    // The executor records per-action failures itself; catching
                    // here only keeps one bad row from aborting the rest.
                    logger(`ReviewChangesCard: bulk apply failed for ${row.toolcallId}: ${error}`, 1);
                } finally {
                    // Pin as soon as the row returns so it flips to its resolved
                    // state right away instead of at the end of the whole loop.
                    markResolved({ runId: run.id, toolcallId: row.toolcallId });
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
            rejectAgentActions({ actions: row.actions });
            markResolved({ runId: run.id, toolcallId: row.toolcallId });
        }
    }, [isBulkRunning, markResolved, rejectAgentActions, rows, run.id]);

    const toggleExpanded = useCallback(() => {
        if (isBulkRunning) return;
        togglePanelVisibility(groupId);
    }, [groupId, isBulkRunning, togglePanelVisibility]);

    if (rows.length === 0) return null;

    // A lone row is the whole card: no aggregate header to summarize.
    if (rows.length === 1) {
        return (
            <ReviewActionRow
                runId={run.id}
                row={rows[0]}
                onResolved={handleRowResolved}
                inGroup={false}
            />
        );
    }

    const { text: headerText, tone } = getReviewHeaderCopy(rows);
    const hasPendingRows = rows.some((row) => !row.resolved);
    const allApplied = rows.every((row) => row.actions.every((action) => action.status === 'applied'));
    const showBulkButtons = hasPendingRows && !isBulkRunning;
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
                    disabled={isBulkRunning}
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

                {showBulkButtons && (
                    <div className="display-flex flex-row items-center gap-25 mr-3 mt-015">
                        <Tooltip content="Reject all" showArrow singleLine>
                            <IconButton
                                icon={CancelIcon}
                                variant="ghost-secondary"
                                iconClassName="font-color-red"
                                onClick={handleBulkReject}
                                disabled={isBulkRunning}
                            />
                        </Tooltip>
                        <Tooltip content="Apply all" showArrow singleLine>
                            <IconButton
                                icon={TickIcon}
                                variant="ghost-secondary"
                                iconClassName="font-color-green scale-14"
                                onClick={handleBulkApply}
                                disabled={isBulkRunning}
                            />
                        </Tooltip>
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
                                inGroup
                            />
                        </div>
                    ))}

                    {visibleRows.length < rows.length && (
                        <div className="display-flex flex-row px-2 py-2 border-top-quinary">
                            <Button
                                variant="ghost-secondary"
                                onClick={() => setShowAllRows(true)}
                                disabled={isBulkRunning}
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
