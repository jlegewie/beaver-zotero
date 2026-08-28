import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { AgentRun } from '@beaver/agent-core/agents/types';
import { logger } from '@beaver/agent-core/platform/logger';
import { getAgentActionsByToolcallAtom } from '../../../../agents/agentActions';
import {
    annotationPanelStateAtom,
    defaultAnnotationPanelState,
    setToolExpandedAtom,
    toggleAnnotationPanelVisibilityAtom,
} from '../../../../atoms/messageUIState';
import {
    applyAgentActionsAtom,
    inFlightAgentActionIdsAtom,
    rejectAgentActionsAtom,
} from '../../agentActionExecution';
import { getChangesCardHeading, hasPendingReviewRows, ReviewRow } from '../reviewChangeRows';
import { ReviewActionRow } from './ReviewActionRow';
import {
    ArrowDownIcon,
    CancelIcon,
    Icon,
    LibraryIcon,
    TickIcon,
} from '../../../../components/icons/icons';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';

/** Rows shown before the `Show all (N)` affordance. */
const MAX_VISIBLE_ROWS = 10;

interface ChangesCardProps {
    run: AgentRun;
    /** From `useChangesRows`; the caller derives them so it can skip an empty card. */
    rows: ReviewRow[];
}

/**
 * Bottom-of-thread card for a terminal run's agent actions: one row per tool
 * call under a collapsible heading, whatever became of the change.
 *
 * The run's durable record, rebuilt from the thread's actions rather than from
 * session state, so reopening a thread shows what the run did and still offers
 * the undo. Every run with changes gets one, under the same label and with the
 * same controls, and nothing dismisses it. What the run *produced* is not in
 * here — `ArtifactsList` has it, so nothing is reported twice.
 */
export const ChangesCard: React.FC<ChangesCardProps> = ({ run, rows }) => {
    const [showAllRows, setShowAllRows] = useState(false);
    const [isBulkRunning, setIsBulkRunning] = useState(false);
    // Only meaningful while a bulk apply runs; it drives the header's progress
    // trail, which is the sole view of a long apply on a collapsed card.
    const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 });

    const applyAgentActions = useSetAtom(applyAgentActionsAtom);
    const rejectAgentActions = useSetAtom(rejectAgentActionsAtom);
    const setToolExpanded = useSetAtom(setToolExpandedAtom);

    // The jotai getter this closure carries reads the store when it is called, so
    // the bulk loop sees each tool call's status as of its turn, not of the click.
    const getActionsByToolcall = useAtomValue(getAgentActionsByToolcallAtom);

    // Expansion lives in the global panel state so it survives pane switches and
    // the separate window, like the other action cards.
    const groupId = `${run.id}:changes`;
    const panelStates = useAtomValue(annotationPanelStateAtom);
    const isExpanded = (panelStates[groupId] ?? defaultAnnotationPanelState).resultsVisible;
    const togglePanelVisibility = useSetAtom(toggleAnnotationPanelVisibilityAtom);

    // Whether a write is in flight comes from the executor's claim, which is the
    // only signal that also sees writes started elsewhere (another pane, or the
    // in-stream card for the same tool call). Whether *this* card is running a bulk
    // apply stays local — a shared flag left set by a pane that went away would
    // disable the card for good, since loading a thread does not reset it.
    const inFlightActionIds = useAtomValue(inFlightAgentActionIdsAtom);
    const writingRows = rows.filter((row) => row.actions.some((action) => inFlightActionIds.has(action.id)));
    const hasWritingRow = writingRows.length > 0;
    // The executor claims a row for an undo the same way it claims one for an
    // apply, so the claim alone cannot name the operation — the row's own
    // statuses have to. A row is being undone only if it has an applied action
    // and nothing that would make the write an apply instead: a pending action
    // is one the ✓ is writing now, and an error with no result is a failed apply
    // whose Try Again re-applies (an error that kept its result is a failed
    // undo, whose retry undoes again).
    const isUndoingRow = writingRows.some((row) =>
        row.actions.some((action) => action.status === 'applied')
        && !row.actions.some((action) => action.status === 'pending'
            || (action.status === 'error' && action.result_data == null)));
    const hasPendingRows = hasPendingReviewRows(rows);

    // Row order is fixed when the card mounts, to the undecided-first order
    // `buildReviewRows` hands over. Re-deriving it as rows settle would slide the
    // list under the cursor on every apply — each resolved row leaves the top
    // block and everything below it moves up a line, so the next row's ✓ lands
    // where the user just clicked.
    const rowOrder = useRef<Map<string, number> | null>(null);
    if (rowOrder.current === null) {
        rowOrder.current = new Map(rows.map((row, index) => [row.toolcallId, index]));
    }
    const orderedRows = useMemo(() => {
        const order = rowOrder.current!;
        // A tool call the card has not seen before sorts to the end.
        const rank = (row: ReviewRow) => order.get(row.toolcallId) ?? Number.MAX_SAFE_INTEGER;
        return [...rows].sort((left, right) => rank(left) - rank(right));
    }, [rows]);

    const handleBulkApply = useCallback(async () => {
        if (isBulkRunning || hasWritingRow) return;
        // Snapshot at click time. Non-bulk-applicable rows (annotation deletions,
        // destructive note rewrites) are their own approval groups in
        // runApprovalPolicy so that approving annotation or note edits never
        // carries them along — the bulk ✓ must not re-open that. They stay in the
        // card with their own ✓.
        const rowsToApply = rows.filter((row) => row.bulkApplicable && !row.resolved);
        if (rowsToApply.length === 0) return;

        setBulkProgress({ done: 0, total: rowsToApply.length });
        setIsBulkRunning(true);
        try {
            // Sequential on purpose: a 50-action apply must not hammer the Zotero
            // DB, and in-order application keeps multi-step changes (create a
            // collection, then file items into it) coherent.
            for (const [index, row] of rowsToApply.entries()) {
                setBulkProgress({ done: index, total: rowsToApply.length });
                // Re-read, and take only what is still pending: the click-time
                // snapshot can never see a status change, so applying it could
                // re-run a tool call another surface has since applied — or worse,
                // re-create an item the user undone or rejected in the meantime.
                const actions = getActionsByToolcall(
                    row.toolcallId,
                    (action) => action.run_id === run.id && action.status === 'pending',
                );
                if (actions.length === 0) continue;

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
    }, [applyAgentActions, getActionsByToolcall, hasWritingRow, isBulkRunning, rows, run.id]);

    const handleBulkReject = useCallback(() => {
        if (isBulkRunning || hasWritingRow) return;
        // A rejection is a local refusal with no Zotero write, so it covers every
        // pending row — including the ones bulk apply has to skip.
        const rowsToReject = rows.filter((row) => !row.resolved);
        if (rowsToReject.length === 0) return;

        for (const row of rowsToReject) {
            const actions = row.actions.filter((action) => action.status === 'pending');
            if (actions.length === 0) continue;
            rejectAgentActions({ actions });
        }
    }, [hasWritingRow, isBulkRunning, rejectAgentActions, rows]);

    // Expanding stays available during a bulk apply: the per-row spinners are the
    // only view of which tool call is being written. When there is only one row,
    // open its preview along with the card; multiple rows stay collapsed for
    // scanning.
    const toggleExpanded = useCallback(() => {
        if (!isExpanded && rows.length === 1) {
            setToolExpanded({
                key: `${run.id}:changes:${rows[0].toolcallId}`,
                expanded: true,
            });
        }
        togglePanelVisibility(groupId);
    }, [groupId, isExpanded, rows, run.id, setToolExpanded, togglePanelVisibility]);

    if (rows.length === 0) return null;

    const { lead, trail } = getChangesCardHeading(rows);
    // A bulk apply replaces the trail: mid-run the status counts are a moving
    // target, and how far the apply has got is what the user is waiting on.
    const headingTrail = isBulkRunning
        ? `applying ${Math.min(bulkProgress.done + 1, bulkProgress.total)} of ${bulkProgress.total}`
        // A write started elsewhere (the in-stream card, another pane) disables
        // this card's buttons, so the header has to say why.
        : hasWritingRow ? (isUndoingRow ? 'undoing…' : 'applying…') : trail;
    // A row applying on its own must finish before a bulk run starts, or the same
    // tool call would be written to Zotero twice. Disabled rather than unmounted:
    // the buttons keep their place, and a write that never reports back leaves the
    // card looking busy instead of looking like it has no controls at all.
    const bulkDisabled = isBulkRunning || hasWritingRow;
    // Nothing left for the header ✓ once only non-bulk-applicable rows are pending;
    // showing it then would be a dead click.
    const showBulkApply = rows.some((row) => !row.resolved && row.bulkApplicable);
    const visibleRows = showAllRows ? orderedRows : orderedRows.slice(0, MAX_VISIBLE_ROWS);
    // The row cap can outlive the order that was frozen around it: rows resolved
    // since the card mounted keep their place, so undecided ones can end up
    // behind `Show all`. Naming them there is cheaper than re-sorting the list
    // under the user's cursor.
    const hiddenPendingCount = orderedRows.slice(visibleRows.length).filter((row) => !row.resolved).length;

    return (
        <div className="border-card rounded-card display-flex flex-col min-w-0">
            <div
                className={`display-flex flex-row py-15 bg-senary items-center min-w-0 ${isExpanded ? 'border-bottom-quinary' : ''}`}
            >
                <button
                    type="button"
                    className="variant-ghost-secondary display-flex flex-row items-center gap-2 ml-3 min-w-0 text-left"
                    style={{ background: 'transparent', border: 0, padding: 0, flex: '1 1 0%' }}
                    aria-expanded={isExpanded}
                    onClick={toggleExpanded}
                >
                    <div className="display-flex items-center scale-11" style={{ flexShrink: 0 }}>
                        <Icon icon={LibraryIcon} className="font-color-secondary" />
                    </div>
                    {/* The lead is fixed copy; the trail is the run's state and
                        the only place it is reported. Both may shrink, but the
                        lead's shrink factor is far larger, so a narrow pane eats
                        into "Library changes" long before it touches the counts.
                        The lead keeps a floor, or it would shrink past the width
                        an ellipsis needs and vanish without a trace. */}
                    <span
                        className="font-color-primary text-base truncate"
                        style={{ flex: '0 100 auto', minWidth: '3rem' }}
                        title={lead}
                    >
                        {lead}
                    </span>
                    <span
                        className="font-color-secondary opacity-70 text-sm truncate min-w-0"
                        style={{ flex: '0 1 auto' }}
                        title={headingTrail || undefined}
                    >
                        {headingTrail}
                    </span>
                </button>

                {hasPendingRows && <div className="display-flex flex-row items-center gap-25 mr-2" style={{ flexShrink: 0 }}>
                    <Tooltip content="Reject all" showArrow singleLine>
                        <IconButton
                            icon={CancelIcon}
                            variant="ghost-secondary"
                            iconClassName="font-color-red"
                            onClick={handleBulkReject}
                            disabled={bulkDisabled}
                            ariaLabel="Reject all"
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
                                ariaLabel="Apply all"
                            />
                        </Tooltip>
                    )}
                </div>}

                {/* The heading button covers the row's text, but the chevron is
                    the affordance people aim at, so it toggles as well. Not a
                    second tab stop: the heading button already carries the
                    keyboard path and `aria-expanded`. */}
                <button
                    type="button"
                    // `beaver.css` resets every bare button in a pane with
                    // `all: revert`, which costs this one its pointer cursor —
                    // the variant class is what restores it.
                    className="variant-ghost-secondary display-flex items-center mr-3"
                    style={{ background: 'transparent', border: 0, padding: 0, flexShrink: 0 }}
                    tabIndex={-1}
                    aria-hidden
                    // Gecko focuses a button on mousedown, and focus must not
                    // land on an element hidden from assistive tech.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={toggleExpanded}
                >
                    <Icon
                        icon={ArrowDownIcon}
                        // Sized in `rem`, not the inherited `em`: the variant
                        // class that gives this button its pointer cursor also
                        // shrinks its font, which would leave this chevron
                        // smaller than the identical one on the batch receipt
                        // directly above.
                        size="1rem"
                        className="font-color-secondary scale-85 transition"
                        style={{ transform: isExpanded ? 'rotate(180deg)' : undefined }}
                    />
                </button>
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
                                {hiddenPendingCount > 0
                                    ? `Show all (${rows.length}) — ${hiddenPendingCount} pending`
                                    : `Show all (${rows.length})`}
                            </Button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default ChangesCard;
