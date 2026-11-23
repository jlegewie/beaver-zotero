import { useSurfaceWindow } from '../../../../runtime/SurfaceWindowContext';
import React, { useCallback, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    agentActionItemTitleAtom,
    getAgentActionItemTitleKey,
    toolExpandedAtom,
    setToolExpandedAtom,
} from '../../../../atoms/messageUIState';
import {
    applyAgentActionsAtom,
    inFlightAgentActionIdsAtom,
    refreshMergeProposalsAtom,
    rejectAgentActionsAtom,
    undoAgentActionsAtom,
} from '../../agentActionExecution';
import {
    ActionStatus,
    getCreateAnnotationsDisplayStatus,
    getOverallStatus,
    hasFailedUndo,
    getActionLabel,
    getActionTitle,
    buildPreviewData,
    getAgentActionToolIcon,
    getStatusConfig,
    isStaleProposal,
    STALE_APPLY_ANYWAY_TOOLTIP,
    staleProposalDetail,
    wasRefusedAsStale,
    unconfirmedCaption,
} from '../agentActionViewHelpers';
import { StaleProposalNote } from '../StaleProposalNote';
import { ActionPreview } from '../ActionPreview';
import type { ReviewRow } from '../reviewChangeRows';
import {
    TickIcon,
    CancelIcon,
    ClockIcon,
    RepeatIcon,
    UndoIcon,
    Icon,
    ArrowDownIcon,
    ArrowRightIcon,
    ArrowUpRightIcon,
} from '../../../../components/icons/icons';
import { getZoteroItemReferenceFromAgentAction, isCreateAnnotationsAgentAction } from '../../../../agents/agentActions';
import { getCreateAnnotationsOpenLink } from '../createAnnotationsNavigation';
import { getCurrentCollectionKeyForItem, revealSource } from '../../../../utils/sourceUtils';
import { getMergedItemReference } from '../../../../atoms/mergeItemsChoices';
import { isStaleMergeProposal } from '../mergeItemsErrors';
import { isStaleNoteEdit } from '../editNoteErrors';
import { resolveLibraryRef } from '../../../../../src/utils/libraryIdentity';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';

interface ReviewActionRowProps {
    row: ReviewRow;
    /** True while any card-level bulk operation runs — row buttons are disabled. */
    isBulkRunning?: boolean;
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
    row,
    isBulkRunning = false,
    inGroup = false,
}) => {
    const runId = row.runId;
    const [isProcessing, setIsProcessing] = useState(false);
    const [isUndoError, setIsUndoError] = useState(false);
    const [clickedButton, setClickedButton] = useState<'approve' | 'applyAnyway' | 'reject' | 'undo' | 'refresh' | null>(null);
    const [isHovered, setIsHovered] = useState(false);

    const applyAgentActions = useSetAtom(applyAgentActionsAtom);
    const refreshMergeProposals = useSetAtom(refreshMergeProposalsAtom);
    const rejectAgentActions = useSetAtom(rejectAgentActionsAtom);
    const surfaceWindow = useSurfaceWindow();
    const undoAgentActions = useSetAtom(undoAgentActionsAtom);

    // Expansion lives in the global panel state so it survives pane switches and
    // the separate window, like every other action card. Scoped to the bottom-of-
    // run surfaces so a tool call opened here does not open the in-stream card
    // too; one tool call is never on both of those surfaces, so one scope does.
    const expansionKey = `${runId}:changes:${row.toolcallId}`;
    const isExpanded = useAtomValue(useMemo(() => toolExpandedAtom(expansionKey), [expansionKey])) ?? false;
    const setExpanded = useSetAtom(setToolExpandedAtom);

    // Read-only: the in-stream card resolves and caches the title under the same
    // run-scoped key, so this surface shares that one fetch without colliding
    // with an identically named tool call from a continuation run.
    const itemTitleKey = getAgentActionItemTitleKey(runId, row.toolcallId);
    const itemTitle = useAtomValue(useMemo(() => agentActionItemTitleAtom(itemTitleKey), [itemTitleKey]));

    // Read the executor's claim rather than a card-local flag: it is the only
    // signal that sees a write started from another surface (the in-stream card),
    // and it is what keeps this row's buttons from racing that write.
    const inFlightActionIds = useAtomValue(inFlightAgentActionIdsAtom);
    const isWriting = row.actions.some((action) => inFlightActionIds.has(action.id));

    const firstAction = row.actions[0];
    // Local state alone would send Retry into a fresh apply after a remount, or
    // after an undo that failed in another pane.
    const isUndoRetry = isUndoError || hasFailedUndo(row.actions);
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
    // A merge or note edit refused because its target changed since the
    // proposal fails the same way on every retry; only a new proposal helps.
    // A merge can be proposed again from here (Refresh).
    const isStaleMerge = row.actions.some(isStaleMergeProposal);
    const showRefresh = isStaleMerge && status === 'error';
    const baseConfig = getStatusConfig(status, row.actions);
    const config = isStaleMerge || row.actions.some(isStaleNoteEdit)
        ? { ...baseConfig, showRetry: false }
        : baseConfig;
    const headerIcon = isBusy
        ? config.icon ?? ClockIcon
        : isHovered
            ? (isExpanded ? ArrowDownIcon : ArrowRightIcon)
            : config.icon ?? getAgentActionToolIcon(row.actionType);
    // AgentActionView intentionally enlarges its resolved icons. Normalize only
    // the compact review-row icons without changing that existing surface.
    const headerIconClassName = config.iconClassName
        ?.split(/\s+/)
        .filter((className) => className !== 'scale-11')
        .join(' ');

    // `skipStaleCheck` is "Apply anyway" for a proposal the library has
    // moved away from.
    const applyRow = useCallback(async (skipStaleCheck: boolean) => {
        if (isDisabled) return;

        setIsUndoError(false);
        setIsProcessing(true);
        setClickedButton(skipStaleCheck ? 'applyAnyway' : 'approve');
        try {
            const result = await applyAgentActions({ actions: row.actions, runId, skipStaleCheck });
            // Refused because the library changed: open the row on what changed.
            if (wasRefusedAsStale(result)) {
                setExpanded({ key: expansionKey, expanded: true });
            }
        } finally {
            setIsProcessing(false);
            setClickedButton(null);
        }
    }, [isDisabled, row, runId, applyAgentActions, setExpanded, expansionKey]);
    const handleApply = useCallback(() => applyRow(false), [applyRow]);
    const handleApplyAnyway = useCallback(() => applyRow(true), [applyRow]);

    const handleReject = useCallback(() => {
        if (isDisabled) return;

        // A row can mix settled and undecided actions. Reject only the ones
        // that still await a decision, including an apply refused because the
        // library changed since the proposal.
        const pendingActions = row.actions.filter((action) => action.status === 'pending' || isStaleProposal(action));
        if (pendingActions.length === 0) return;

        setClickedButton('reject');
        rejectAgentActions({ actions: pendingActions });
        setTimeout(() => setClickedButton(null), 100);
    }, [isDisabled, row, rejectAgentActions]);

    const handleUndo = useCallback(async () => {
        if (isDisabled) return;

        setIsProcessing(true);
        setClickedButton('undo');
        try {
            const result = await undoAgentActions({ actions: row.actions, window: surfaceWindow });
            if (result.fatalError) setIsUndoError(true);
        } finally {
            setIsProcessing(false);
            setClickedButton(null);
        }
    }, [isDisabled, row, undoAgentActions]);

    const handleRefresh = useCallback(async () => {
        if (isDisabled) return;

        setIsProcessing(true);
        setClickedButton('refresh');
        try {
            await refreshMergeProposals({ actions: row.actions });
        } finally {
            setIsProcessing(false);
            setClickedButton(null);
        }
    }, [isDisabled, row, refreshMergeProposals]);

    const handleRetry = useCallback(async () => {
        if (isUndoRetry) {
            setIsUndoError(false);
            await handleUndo();
        } else {
            await handleApply();
        }
    }, [isUndoRetry, handleUndo, handleApply]);

    // Reveal is offered per row rather than by making the header text clickable,
    // which already toggles the preview. Only a single-action row has one item to
    // reveal; a multi-item create_items row does not.
    const revealReference = row.actions.length === 1
        ? getZoteroItemReferenceFromAgentAction(firstAction) ?? getMergedItemReference(firstAction)
        : null;

    const handleReveal = useCallback(async () => {
        if (!revealReference) return;
        // Reveal within the current collection when the item belongs to it,
        // instead of switching to the library root.
        // The collection lookup needs this device's rowid; a reference may
        // carry only the portable library_ref.
        const libraryId = resolveLibraryRef(revealReference) ?? revealReference.library_id;
        const collectionKey = await getCurrentCollectionKeyForItem(libraryId, revealReference.zotero_key);
        revealSource(revealReference, collectionKey);
    }, [revealReference]);

    // The row's open link (↗), with the same destination as the action's card
    // in the response: annotations open in the reader, and any other single
    // item is shown in the library.
    const annotationOpenLink = row.actions.length === 1 && isCreateAnnotationsAgentAction(firstAction)
        ? getCreateAnnotationsOpenLink(
            firstAction.action_type === 'create_highlight_annotations' ? 'highlight' : 'note',
            firstAction.proposed_data,
            firstAction.result_data,
            firstAction.status === 'applied',
        )
        : null;
    const openLink = annotationOpenLink ?? (revealReference ? { tooltip: 'Reveal in library', onClick: handleReveal } : null);

    const toggleExpanded = useCallback(
        () => setExpanded({ key: expansionKey, expanded: !isExpanded }),
        [expansionKey, isExpanded, setExpanded],
    );

    // Past tense once the change is in the library, so the row does not read as a
    // proposal ("Organize") for something that has already happened. An undone or
    // rejected row keeps the imperative: its ✓ would apply it anew.
    const isInEffect = row.actions.some((action) => action.status === 'applied'
        || (action.status === 'error' && action.result_data != null));
    const label = getActionLabel(row.actionType, firstAction.proposed_data, isInEffect);
    const title = getActionTitle(row.actionType, firstAction.proposed_data, itemTitle, row.actions);
    const previewData = buildPreviewData(row.actionType, null, firstAction);
    // An unconfirmed change offers nothing to click; this says what to do.
    const unconfirmedNote = isBusy ? null : unconfirmedCaption(row.actions);
    const staleDetail = isBusy ? null : staleProposalDetail(row.actions);

    const containerClassName = inGroup
        ? 'display-flex flex-col min-w-0'
        : 'border-card rounded-card display-flex flex-col min-w-0';
    const headerRowClassName = [
        'display-flex flex-row items-center py-15 gap-1',
        inGroup ? '' : 'bg-senary',
        isExpanded ? 'border-bottom-quinary' : '',
    ].filter(Boolean).join(' ');

    return (
        <div className={containerClassName}>
            <div className={headerRowClassName}>
                <button
                    type="button"
                    className="variant-ghost-secondary display-flex flex-row items-start ml-3 gap-2 min-w-0 text-left"
                    style={{
                        fontSize: '0.95rem',
                        background: 'transparent',
                        border: 0,
                        padding: 0,
                        alignItems: 'flex-start',
                    }}
                    aria-expanded={isExpanded}
                    onClick={toggleExpanded}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                >
                    <div className="display-flex items-center scale-11 mt-010" style={{ flexShrink: 0 }}>
                        <Icon icon={headerIcon} className={!isHovered ? headerIconClassName : undefined} />
                    </div>
                    <div className="display-flex flex-col min-w-0 gap-1">
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
                        {unconfirmedNote && (
                            <span className="font-color-secondary text-sm" role="status">{unconfirmedNote}</span>
                        )}
                    </div>
                </button>

                <div className="flex-1" />

                <div className="display-flex flex-row items-center gap-2 mr-3 mt-010" style={{ flexShrink: 0 }}>
                    {(config.showUndo || (isBusy && activeButton === 'undo')) && (
                        <Tooltip content="Undo" showArrow singleLine>
                            <IconButton
                                icon={UndoIcon}
                                variant="ghost-secondary"
                                iconClassName="font-color-secondary scale-10"
                                onClick={handleUndo}
                                loading={isBusy && activeButton === 'undo'}
                                disabled={isDisabled}
                                ariaLabel="Undo"
                            />
                        </Tooltip>
                    )}

                    {config.showRetry && (
                        <Button
                            variant="ghost"
                            icon={RepeatIcon}
                            onClick={handleRetry}
                            disabled={isDisabled}
                            style={GHOST_BUTTON_STYLE}
                        >
                            {isUndoRetry ? 'Retry Undo' : 'Try Again'}
                        </Button>
                    )}

                    {showRefresh && (
                        <Tooltip content="Check the records again and show the current merge for review" showArrow>
                            <Button
                                variant="ghost"
                                icon={RepeatIcon}
                                onClick={handleRefresh}
                                disabled={isDisabled}
                                loading={isBusy && activeButton === 'refresh'}
                                style={GHOST_BUTTON_STYLE}
                            >
                                Refresh
                            </Button>
                        </Tooltip>
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

                    {/* A refused stale proposal: its ✓ applies it anyway. */}
                    {((config.showApplyAnyway && !isBusy) || (isBusy && activeButton === 'applyAnyway')) && (
                        <Tooltip content={STALE_APPLY_ANYWAY_TOOLTIP} showArrow singleLine>
                            <IconButton
                                icon={TickIcon}
                                variant="ghost-secondary"
                                iconClassName={`${isBusy ? 'font-color-secondary' : 'font-color-green'} scale-14`}
                                onClick={handleApplyAnyway}
                                disabled={isDisabled}
                                loading={isBusy && activeButton === 'applyAnyway'}
                                ariaLabel="Apply anyway"
                            />
                        </Tooltip>
                    )}

                    {config.showApply && (!isBusy || activeButton === 'approve') && (
                        <Tooltip content="Apply" showArrow singleLine>
                            <IconButton
                                icon={TickIcon}
                                variant="ghost-secondary"
                                iconClassName={`${isBusy && activeButton === 'approve' ? 'font-color-secondary' : 'font-color-green'} scale-14`}
                                onClick={handleApply}
                                disabled={isDisabled}
                                loading={isBusy && activeButton === 'approve'}
                            />
                        </Tooltip>
                    )}

                    {/* The open / reveal link is the rightmost icon, and stays out of
                        an open decision so Apply / Reject stand alone. */}
                    {openLink && !isBusy && status !== 'awaiting' && status !== 'pending' && (
                        <Tooltip content={openLink.tooltip} showArrow singleLine>
                            <IconButton
                                icon={ArrowUpRightIcon}
                                variant="ghost-secondary"
                                iconClassName="font-color-secondary scale-10"
                                onClick={() => void openLink.onClick()}
                                disabled={isDisabled}
                                ariaLabel={openLink.tooltip}
                            />
                        </Tooltip>
                    )}
                </div>
            </div>

            {isExpanded && staleDetail && <StaleProposalNote detail={staleDetail} />}
            {isExpanded && previewData && (
                <ActionPreview
                    toolName={row.actionType}
                    previewData={previewData}
                    status={status}
                    actions={row.actions}
                    disabled={isDisabled || isBusy}
                    compact
                />
            )}
        </div>
    );
};

export default ReviewActionRow;
