import React, { useCallback, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { AgentRun } from '@beaver/agent-core/agents/types';
import { logger } from '@beaver/agent-core/platform/logger';
import { getAgentActionsByToolcallAtom } from '../../../../agents/agentActions';
import {
    annotationPanelStateAtom,
    defaultAnnotationPanelState,
    retainReviewActionsAtom,
    toggleAnnotationPanelVisibilityAtom,
} from '../../../../atoms/messageUIState';
import {
    applyAgentActionsAtom,
    inFlightAgentActionIdsAtom,
    rejectAgentActionsAtom,
} from '../../agentActionExecution';
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

    const applyAgentActions = useSetAtom(applyAgentActionsAtom);
    const rejectAgentActions = useSetAtom(rejectAgentActionsAtom);
    const retainActions = useSetAtom(retainReviewActionsAtom);

    // The jotai getter this closure carries reads the store when it is called, so
    // the bulk loop sees each tool call's status as of its turn, not of the click.
    const getActionsByToolcall = useAtomValue(getAgentActionsByToolcallAtom);

    // Expansion lives in the global panel state so it survives pane switches and
    // the separate window, like the other action cards.
    const groupId = `${run.id}:review`;
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
                    logger(`ReviewChangesCard: bulk apply failed for ${row.toolcallId}: ${error}`, 1);
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
                isBulkRunning={isBulkRunning}
                onResolved={handleRowResolved}
                inGroup={false}
            />
        );
    }

    const { text: headerText, tone } = getReviewHeaderCopy(rows);
    const hasPendingRows = rows.some((row) => !row.resolved);
    const allApplied = rows.every((row) => row.actions.every((action) => action.status === 'applied'));
    // A row applying on its own must finish before a bulk run starts, or the same
    // tool call would be written to Zotero twice. Disabled rather than unmounted:
    // the buttons keep their place, and a write that never reports back leaves the
    // card looking busy instead of looking like it has no controls at all.
    const bulkDisabled = isBulkRunning || hasWritingRow;
    // Nothing left for the header ✓ once only non-bulk-applicable rows are pending;
    // showing it then would be a dead click.
    const showBulkApply = rows.some((row) => !row.resolved && row.bulkApplicable);
    const visibleRows = showAllRows ? rows : rows.slice(0, MAX_VISIBLE_ROWS);

    const headerIcon = (() => {
        if (isBulkRunning || hasWritingRow) return Spinner;
        if (isHovered && isExpanded) return ArrowDownIcon;
        if (isHovered && !isExpanded) return ArrowRightIcon;
        if (tone === 'review') return ClockIcon;
        return allApplied ? CheckmarkCircleIcon : CancelCircleIcon;
    })();
    const headerIconClassName = !isBulkRunning && !hasWritingRow && !isHovered && tone === 'resolved'
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

                {hasPendingRows && <div className="display-flex flex-row items-center gap-25 mr-3 mt-015">
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
