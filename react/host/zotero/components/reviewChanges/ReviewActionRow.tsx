import React, { useCallback, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    agentActionItemTitlesAtom,
    toolExpandedAtom,
    setToolExpandedAtom,
} from '../../../../atoms/messageUIState';
import {
    applyAgentActionsAtom,
    inFlightAgentActionIdsAtom,
    rejectAgentActionsAtom,
    undoAgentActionsAtom,
} from '../../agentActionExecution';
import {
    ActionStatus,
    STATUS_CONFIGS,
    getCreateAnnotationsDisplayStatus,
    getOverallStatus,
    getActionLabel,
    getActionTitle,
    buildPreviewData,
} from '../agentActionViewHelpers';
import { ActionPreview } from '../ActionPreview';
import type { ReviewRow } from '../reviewChangeRows';
import {
    TickIcon,
    CancelIcon,
    ClockIcon,
    RepeatIcon,
    Icon,
} from '../../../../components/icons/icons';
import Button from '../../../../components/ui/Button';
import IconButton from '../../../../components/ui/IconButton';
import Tooltip from '../../../../components/ui/Tooltip';

interface ReviewActionRowProps {
    runId: string;
    row: ReviewRow;
    /** True while any card-level bulk operation runs — row buttons are disabled. */
    isBulkRunning?: boolean;
    /** Pins this row visible; called before its own buttons dispatch anything. */
    onResolved?: (toolcallId: string) => void;
    /** True when rendered inside the aggregate card; the parent draws the border/background. */
    inGroup?: boolean;
}

/** Small ghost buttons in the row's action cluster. */
const GHOST_BUTTON_STYLE: React.CSSProperties = { padding: '3px 6px' };

/**
 * One review row per tool call — the same unit `AgentActionView` renders in the
 * stream, reduced to its header plus an opt-in `ActionPreview`. Purely driven by
 * props: the card owns which rows exist and the bulk operations.
 */
export const ReviewActionRow: React.FC<ReviewActionRowProps> = ({
    runId,
    row,
    isBulkRunning = false,
    onResolved,
    inGroup = false,
}) => {
    const [isProcessing, setIsProcessing] = useState(false);
    const [isUndoError, setIsUndoError] = useState(false);
    const [clickedButton, setClickedButton] = useState<'approve' | 'reject' | 'undo' | null>(null);

    const applyAgentActions = useSetAtom(applyAgentActionsAtom);
    const rejectAgentActions = useSetAtom(rejectAgentActionsAtom);
    const undoAgentActions = useSetAtom(undoAgentActionsAtom);

    // Expansion lives in the global panel state so it survives pane switches and
    // the separate window, like every other action card.
    const expansionKey = `${runId}:review:${row.toolcallId}`;
    const expansionState = useAtomValue(toolExpandedAtom);
    const setExpanded = useSetAtom(setToolExpandedAtom);
    const isExpanded = expansionState[expansionKey] ?? false;

    // Read-only: the in-stream card resolves and caches the title under the same
    // key, so this surface shares that one fetch instead of repeating it.
    const itemTitle = useAtomValue(agentActionItemTitlesAtom)[row.toolcallId] ?? null;

    // Read the executor's claim rather than a card-local flag: it is the only
    // signal that sees a write started from another surface (the in-stream card),
    // and it is what keeps this row's buttons from racing that write.
    const inFlightActionIds = useAtomValue(inFlightAgentActionIdsAtom);
    const isWriting = row.actions.some((action) => inFlightActionIds.has(action.id));

    const firstAction = row.actions[0];
    const isBusy = isProcessing || isWriting;
    const isDisabled = isBusy || isBulkRunning;
    // A write this row did not click (a bulk apply, another surface, or its own
    // from before a remount) keeps its button mounted with a spinner instead of
    // the row briefly losing its buttons. An applied row can only be undoing.
    const externalButton = row.actions.some((action) => action.status === 'applied') ? 'undo' : 'approve';
    const activeButton = clickedButton ?? (isWriting ? externalButton : null);

    // 'awaiting' while busy: its STATUS_CONFIGS entry carries the spinner icon
    // and keeps the apply/reject vocabulary the in-stream card uses.
    const status: ActionStatus | 'awaiting' = isBusy
        ? 'awaiting'
        : row.actions.length > 1
            ? getOverallStatus(row.actions)
            : (getCreateAnnotationsDisplayStatus(firstAction) ?? firstAction.status);
    const config = STATUS_CONFIGS[status];

    // Pin before dispatching, never after: an apply flips the action's status
    // synchronously and only then awaits the backend ack, so a row pinned
    // afterwards would drop out of the card for the length of that round trip.
    const handleApply = useCallback(async () => {
        if (isDisabled) return;

        setIsUndoError(false);
        setIsProcessing(true);
        setClickedButton('approve');
        onResolved?.(row.toolcallId);
        try {
            await applyAgentActions({ actions: row.actions, runId });
        } finally {
            setIsProcessing(false);
            setClickedButton(null);
        }
    }, [isDisabled, row, runId, applyAgentActions, onResolved]);

    const handleReject = useCallback(() => {
        if (isDisabled) return;

        // A pinned row carries its non-pending actions too; rejecting an applied one
        // would clear its result data and orphan what it created.
        const actions = row.actions.filter((action) => action.status === 'pending');
        if (actions.length === 0) return;

        setClickedButton('reject');
        onResolved?.(row.toolcallId);
        rejectAgentActions({ actions });
        setTimeout(() => setClickedButton(null), 100);
    }, [isDisabled, row, rejectAgentActions, onResolved]);

    const handleUndo = useCallback(async () => {
        if (isDisabled) return;

        setIsProcessing(true);
        setClickedButton('undo');
        onResolved?.(row.toolcallId);
        try {
            const result = await undoAgentActions({ actions: row.actions });
            if (result.fatalError) setIsUndoError(true);
        } finally {
            setIsProcessing(false);
            setClickedButton(null);
        }
    }, [isDisabled, row, undoAgentActions, onResolved]);

    const handleRetry = useCallback(async () => {
        if (isUndoError) {
            setIsUndoError(false);
            await handleUndo();
        } else {
            await handleApply();
        }
    }, [isUndoError, handleUndo, handleApply]);

    const toggleExpanded = useCallback(
        () => setExpanded({ key: expansionKey, expanded: !isExpanded }),
        [expansionKey, isExpanded, setExpanded],
    );

    const label = getActionLabel(row.actionType, firstAction.proposed_data);
    const title = getActionTitle(row.actionType, firstAction.proposed_data, itemTitle, row.actions);
    const previewData = buildPreviewData(row.actionType, null, firstAction);

    const containerClassName = inGroup
        ? 'display-flex flex-col min-w-0'
        : 'border-popup rounded-md display-flex flex-col min-w-0';
    const headerRowClassName = [
        'display-flex flex-row items-start py-15 gap-1',
        inGroup ? '' : 'bg-senary',
        isExpanded ? 'border-bottom-quinary' : '',
    ].filter(Boolean).join(' ');

    return (
        <div className={containerClassName}>
            <div className={headerRowClassName}>
                <div className="display-flex flex-row ml-3 gap-2 min-w-0">
                    <div className="display-flex mt-015" style={{ flexShrink: 0 }}>
                        <Icon icon={config.icon ?? ClockIcon} className={config.iconClassName} />
                    </div>
                    <div
                        className="min-w-0"
                        style={{
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            wordBreak: 'break-word',
                        }}
                    >
                        <span className="font-color-primary font-medium">{label}</span>
                        {title && <span className="font-color-secondary ml-15">{title}</span>}
                    </div>
                </div>

                <div className="flex-1" />

                <div className="display-flex flex-row items-center gap-1 mr-3 mt-010" style={{ flexShrink: 0 }}>
                    <Button
                        variant="ghost"
                        onClick={toggleExpanded}
                        aria-expanded={isExpanded}
                        style={GHOST_BUTTON_STYLE}
                    >
                        Review
                    </Button>

                    {(config.showUndo || (isBusy && activeButton === 'undo')) && (
                        <Button
                            variant="ghost"
                            onClick={handleUndo}
                            loading={isBusy && activeButton === 'undo'}
                            disabled={isDisabled}
                            style={GHOST_BUTTON_STYLE}
                        >
                            {row.actionType === 'create_note' ? 'Delete' : 'Undo'}
                        </Button>
                    )}

                    {config.showRetry && (
                        <Button
                            variant="ghost"
                            icon={RepeatIcon}
                            onClick={handleRetry}
                            disabled={isDisabled}
                            style={GHOST_BUTTON_STYLE}
                        >
                            {isUndoError ? 'Retry Undo' : 'Try Again'}
                        </Button>
                    )}

                    {config.showReject && (!isBusy || activeButton === 'reject') && (
                        <Tooltip content="Reject" showArrow singleLine>
                            <IconButton
                                icon={CancelIcon}
                                variant="ghost-secondary"
                                iconClassName="font-color-red"
                                onClick={handleReject}
                                disabled={isDisabled}
                                loading={isBusy && activeButton === 'reject'}
                            />
                        </Tooltip>
                    )}

                    {config.showApply && (!isBusy || activeButton === 'approve') && (
                        <Tooltip content="Apply" showArrow singleLine>
                            <IconButton
                                icon={TickIcon}
                                variant="ghost-secondary"
                                iconClassName="font-color-green scale-14"
                                onClick={handleApply}
                                disabled={isDisabled}
                                loading={isBusy && activeButton === 'approve'}
                            />
                        </Tooltip>
                    )}
                </div>
            </div>

            {isExpanded && previewData && (
                <ActionPreview
                    toolName={row.actionType}
                    previewData={previewData}
                    status={status}
                    actions={row.actions}
                />
            )}
        </div>
    );
};

export default ReviewActionRow;
