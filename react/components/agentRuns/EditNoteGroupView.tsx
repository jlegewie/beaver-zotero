import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { AgentRunStatus, ToolCallPart } from '../../agents/types';
import { getToolCallStatus, toolResultsMapAtom } from '../../agents/atoms';
import {
    AgentAction,
    PendingApproval,
    getAgentActionsByToolcallAtom,
    pendingApprovalsAtom,
    removePendingApprovalAtom,
    ackAgentActionsAtom,
    rejectAgentActionAtom,
    setAgentActionsToErrorAtom,
    undoAgentActionAtom,
} from '../../agents/agentActions';
import { isWSChatPendingAtom, sendApprovalResponseAtom } from '../../atoms/agentRunAtoms';
import {
    agentActionItemTitlesAtom,
    setAgentActionItemTitleAtom,
    toolExpandedAtom,
    setToolExpandedAtom,
} from '../../atoms/messageUIState';
import { addAutoApproveNoteKeyAtom, makeNoteKey } from '../../atoms/editNoteAutoApprove';
import { STATUS_CONFIGS, type ActionStatus } from './agentActionViewHelpers';
import {
    ArrowDownIcon,
    ArrowRightIcon,
    ArrowUpRightIcon,
    CancelIcon,
    ChevronIcon,
    EditIcon,
    FileDiffIcon,
    Icon,
    RepeatIcon,
    Spinner,
    TickIcon,
} from '../icons/icons';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';
import SplitApplyButton from '../ui/buttons/SplitApplyButton';
import { openNoteByKey } from '../../utils/sourceUtils';
import { executeEditNoteAction, undoEditNoteAction } from '../../utils/editNoteActions';
import { logger } from '../../../src/utils/logger';
import { EditNoteRowView } from './EditNoteRowView';
import { DIFF_PREVIEW_ENABLED } from '../../utils/diffPreviewCoordinator';
import {
    buildPreviewableEditOperations,
    dismissActiveEditNotePreview,
    showEditNotePreviewForEdits,
} from './useEditNoteActions';
import {
    type EditNoteResolvedTarget,
    findPendingApprovalForToolcall,
    getEditNoteDisplayStatus,
    getEffectiveEditNotePendingApproval,
    getEditNoteGroupExpansionKey,
    getOverallEditNoteDisplayStatus,
    isEditNoteStreamingPlaceholder,
    parseEditNoteToolCallArgs,
    resolveEditNoteTargetFromData,
} from './editNoteShared';

interface EditNoteGroupViewProps {
    parts: ToolCallPart[];
    target: EditNoteResolvedTarget | null;
    runId: string;
    responseIndex: number;
    runStatus: AgentRunStatus;
}

/**
 * Container for an edit_note run. Single note edits and grouped same-note
 * edit runs both render through this component so note-edit UI has one path.
 */
export const EditNoteGroupView: React.FC<EditNoteGroupViewProps> = ({
    parts,
    target,
    runId,
    responseIndex,
    runStatus,
}) => {
    const isRunStreaming = runStatus === 'in_progress';
    const [isHovered, setIsHovered] = useState(false);

    const resultsMap = useAtomValue(toolResultsMapAtom);
    const getAgentActionsByToolcall = useAtomValue(getAgentActionsByToolcallAtom);
    const allPendingApprovals = useAtomValue(pendingApprovalsAtom);
    const sendApprovalResponse = useSetAtom(sendApprovalResponseAtom);
    const isRunPending = useAtomValue(isWSChatPendingAtom);
    const removePendingApproval = useSetAtom(removePendingApprovalAtom);
    const ackAgentActions = useSetAtom(ackAgentActionsAtom);
    const rejectAgentAction = useSetAtom(rejectAgentActionAtom);
    const setAgentActionsToError = useSetAtom(setAgentActionsToErrorAtom);
    const undoAgentAction = useSetAtom(undoAgentActionAtom);
    const addAutoApproveNoteKey = useSetAtom(addAutoApproveNoteKeyAtom);

    const partStates = useMemo(() => {
        return parts.map((part) => {
            const actions = getAgentActionsByToolcall(part.tool_call_id, (a) => a.run_id === runId);
            const action = actions.length > 0 ? actions[0] : null;
            const rawPendingApproval = findPendingApprovalForToolcall(
                part.tool_call_id,
                allPendingApprovals.values(),
            );
            const pendingApproval = getEffectiveEditNotePendingApproval(action, rawPendingApproval);
            const toolCallStatus = getToolCallStatus(part.tool_call_id, resultsMap, runStatus);
            const effectiveStatus = getEditNoteDisplayStatus({
                action,
                pendingApproval,
                toolCallStatus,
            });
            return {
                part,
                actions,
                action,
                pendingApproval,
                toolCallStatus,
                effectiveStatus,
            };
        });
    }, [parts, runId, getAgentActionsByToolcall, allPendingApprovals, resultsMap, runStatus]);

    const allActions: AgentAction[] = useMemo(
        () => partStates.flatMap((state) => state.actions),
        [partStates],
    );

    const pendingApprovalsForGroup: PendingApproval[] = useMemo(
        () => partStates.flatMap((state) => (state.pendingApproval ? [state.pendingApproval] : [])),
        [partStates],
    );

    const resolvedTarget = useMemo(() => {
        if (target) return target;
        for (const pending of pendingApprovalsForGroup) {
            const pendingTarget = resolveEditNoteTargetFromData(pending.actionData);
            if (pendingTarget) return pendingTarget;
        }
        for (const action of allActions) {
            const actionTarget = resolveEditNoteTargetFromData(action.proposed_data)
                ?? resolveEditNoteTargetFromData(action.result_data);
            if (actionTarget) return actionTarget;
        }
        for (const part of parts) {
            const partTarget = resolveEditNoteTargetFromData(part.streaming_args)
                ?? resolveEditNoteTargetFromData(parseEditNoteToolCallArgs(part.args))
                ?? resolveEditNoteTargetFromData(part.args);
            if (partTarget) return partTarget;
        }
        return null;
    }, [target, pendingApprovalsForGroup, allActions, parts]);

    const noteKeyLabel = resolvedTarget
        ? `${resolvedTarget.libraryId}-${resolvedTarget.zoteroKey}`
        : `pending:${parts[0]?.tool_call_id ?? 'unknown'}`;

    const itemTitleKey = resolvedTarget
        ? `${responseIndex}:group:${resolvedTarget.libraryId}-${resolvedTarget.zoteroKey}`
        : null;
    const itemTitleMap = useAtomValue(agentActionItemTitlesAtom);
    const noteTitle = itemTitleKey ? (itemTitleMap[itemTitleKey] ?? null) : null;
    const setItemTitle = useSetAtom(setAgentActionItemTitleAtom);

    const pendingApprovalCount = pendingApprovalsForGroup.length;
    const hasPendingApprovals = pendingApprovalCount > 0;
    const appliedCount = allActions.filter((a) => a.status === 'applied').length;
    const editCount = parts.length;

    const reapplicableActions = useMemo(
        () => allActions.filter((a) => a.status === 'pending' || a.status === 'rejected' || a.status === 'undone'),
        [allActions],
    );
    const errorActions = useMemo(
        () => allActions.filter((a) => a.status === 'error'),
        [allActions],
    );
    const rowStatuses = useMemo(
        () => partStates.map((state) => state.effectiveStatus),
        [partStates],
    );
    const errorCount = rowStatuses.filter((status) => status === 'error').length;

    const hasStreamingChild = useMemo(() => {
        if (!isRunStreaming) return false;
        return partStates.some((state) => isEditNoteStreamingPlaceholder({
            action: state.action,
            pendingApproval: state.pendingApproval,
            toolCallStatus: state.toolCallStatus,
        }));
    }, [partStates, isRunStreaming]);
    const hasUnsettledProcessingChild = useMemo(() => (
        partStates.some((state) => (
            state.pendingApproval === null
            && (
                state.action?.status === 'pending'
                || (!state.action && resultsMap.get(state.part.tool_call_id) === undefined)
            )
        ))
    ), [partStates, resultsMap]);

    const aggregateStatus: ActionStatus | 'awaiting' = getOverallEditNoteDisplayStatus(rowStatuses);

    const expansionKey = getEditNoteGroupExpansionKey(runId, responseIndex, parts);
    const expansionState = useAtomValue(toolExpandedAtom);
    const setExpanded = useSetAtom(setToolExpandedAtom);
    const hasExistingExpandState = expansionState[expansionKey] !== undefined;
    const isExpanded =
        expansionState[expansionKey]
        ?? (hasPendingApprovals || (errorCount > 0 && reapplicableActions.length === 0 && appliedCount === 0));

    const prevHasPendingApprovalsRef = useRef(hasPendingApprovals);
    const hasInitializedRef = useRef(false);
    useEffect(() => {
        if (!hasInitializedRef.current) {
            hasInitializedRef.current = true;
            if (!hasExistingExpandState) {
                setExpanded({
                    key: expansionKey,
                    expanded: hasPendingApprovals || (errorCount > 0 && reapplicableActions.length === 0 && appliedCount === 0),
                });
            }
            prevHasPendingApprovalsRef.current = hasPendingApprovals;
            return;
        }

        if (prevHasPendingApprovalsRef.current && !hasPendingApprovals) {
            setExpanded({ key: expansionKey, expanded: false });
        } else if (!prevHasPendingApprovalsRef.current && hasPendingApprovals) {
            setExpanded({ key: expansionKey, expanded: true });
        }
        prevHasPendingApprovalsRef.current = hasPendingApprovals;
    }, [
        hasPendingApprovals,
        errorCount,
        reapplicableActions.length,
        appliedCount,
        expansionKey,
        hasExistingExpandState,
        setExpanded,
    ]);

    useEffect(() => {
        if (!resolvedTarget || !itemTitleKey || noteTitle) return;
        let cancelled = false;
        (async () => {
            try {
                const item = await Zotero.Items.getByLibraryAndKeyAsync(
                    resolvedTarget.libraryId,
                    resolvedTarget.zoteroKey,
                );
                if (!item || cancelled) return;
                setItemTitle({
                    key: itemTitleKey,
                    title: item.isNote?.() ? (item.getNoteTitle?.() || '(untitled)') : '(untitled)',
                });
            } catch {
                /* best-effort */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [resolvedTarget, itemTitleKey, noteTitle, setItemTitle]);

    const [isLocallyProcessing, setIsLocallyProcessing] = useState(false);
    const [isExternallyProcessing, setIsExternallyProcessing] = useState(false);
    const [clickedButton, setClickedButton] = useState<'approve' | 'reject' | 'undo' | 'retry' | null>(null);
    const [perEditUndoErrors, setPerEditUndoErrors] = useState<Record<string, string>>({});
    const isProcessing = isLocallyProcessing || isExternallyProcessing;

    useEffect(() => {
        if (!isExternallyProcessing) return;
        if (!isRunPending || !hasUnsettledProcessingChild) {
            setIsExternallyProcessing(false);
            setClickedButton(null);
        }
    }, [isExternallyProcessing, isRunPending, hasUnsettledProcessingChild]);

    const handleApplyAll = useCallback(async () => {
        if (isProcessing) return;
        setIsLocallyProcessing(true);
        setClickedButton('approve');
        const shouldWaitForExternalProcessing = hasPendingApprovals && isRunPending;
        try {
            if (hasPendingApprovals) {
                for (const pending of pendingApprovalsForGroup) {
                    sendApprovalResponse({ actionId: pending.actionId, approved: true });
                    removePendingApproval(pending.actionId);
                }
                if (shouldWaitForExternalProcessing) {
                    setIsExternallyProcessing(true);
                }
                logger(`EditNoteGroupView: Approved ${pendingApprovalsForGroup.length} edit_note actions for ${noteKeyLabel}`, 1);
                return;
            }

            if (reapplicableActions.length === 0) return;
            await dismissActiveEditNotePreview();

            for (const action of reapplicableActions) {
                try {
                    const result = await executeEditNoteAction(action);
                    await ackAgentActions(runId, [{
                        action_id: action.id,
                        result_data: result,
                    }]);
                    logger(`EditNoteGroupView: Applied edit_note action ${action.id}`, 1);
                } catch (error: any) {
                    const errorMessage = error?.message || 'Failed to apply edit_note';
                    const stackTrace = error?.stack || '';
                    logger(`EditNoteGroupView: Failed to apply edit_note action ${action.id}: ${errorMessage}\n${stackTrace}`, 1);
                    setAgentActionsToError([action.id], errorMessage, {
                        stack_trace: stackTrace,
                        error_name: error?.name,
                    });
                }
            }
        } finally {
            setIsLocallyProcessing(false);
            if (!shouldWaitForExternalProcessing) {
                setClickedButton(null);
            }
        }
    }, [
        isProcessing,
        hasPendingApprovals,
        isRunPending,
        pendingApprovalsForGroup,
        reapplicableActions,
        noteKeyLabel,
        sendApprovalResponse,
        removePendingApproval,
        ackAgentActions,
        runId,
        setAgentActionsToError,
    ]);

    const handleApproveAllForNote = useCallback(() => {
        if (!resolvedTarget) return;
        const noteKey = makeNoteKey(resolvedTarget.libraryId, resolvedTarget.zoteroKey);
        addAutoApproveNoteKey(noteKey);

        for (const [, pending] of allPendingApprovals) {
            if (pending.actionType !== 'edit_note') continue;
            const pendingTarget = resolveEditNoteTargetFromData(pending.actionData);
            if (!pendingTarget) continue;
            if (makeNoteKey(pendingTarget.libraryId, pendingTarget.zoteroKey) !== noteKey) continue;
            if (pendingApprovalsForGroup.some((groupPending) => groupPending.actionId === pending.actionId)) continue;
            sendApprovalResponse({ actionId: pending.actionId, approved: true });
            removePendingApproval(pending.actionId);
        }

        handleApplyAll();
    }, [
        resolvedTarget,
        addAutoApproveNoteKey,
        allPendingApprovals,
        pendingApprovalsForGroup,
        sendApprovalResponse,
        removePendingApproval,
        handleApplyAll,
    ]);

    const handleRejectAll = useCallback(() => {
        if (isProcessing) return;
        setClickedButton('reject');
        if (hasPendingApprovals) {
            for (const pending of pendingApprovalsForGroup) {
                sendApprovalResponse({ actionId: pending.actionId, approved: false });
                removePendingApproval(pending.actionId);
            }
            logger(`EditNoteGroupView: Rejected ${pendingApprovalsForGroup.length} edit_note actions for ${noteKeyLabel}`, 1);
        } else {
            for (const action of reapplicableActions) {
                rejectAgentAction(action.id);
            }
            logger(`EditNoteGroupView: Rejected ${reapplicableActions.length} edit_note actions for ${noteKeyLabel}`, 1);
        }
        setTimeout(() => setClickedButton(null), 100);
    }, [
        isProcessing,
        hasPendingApprovals,
        pendingApprovalsForGroup,
        noteKeyLabel,
        sendApprovalResponse,
        removePendingApproval,
        reapplicableActions,
        rejectAgentAction,
    ]);

    const handleUndoAll = useCallback(async () => {
        if (isProcessing) return;
        const appliedActions = allActions.filter((a) => a.status === 'applied');
        if (appliedActions.length === 0) return;

        setIsLocallyProcessing(true);
        setClickedButton('undo');
        setPerEditUndoErrors((prev) => {
            const next = { ...prev };
            for (const action of appliedActions) {
                if (action.toolcall_id) delete next[action.toolcall_id];
            }
            return next;
        });

        const newFailures: Record<string, string> = {};
        try {
            await dismissActiveEditNotePreview();

            for (const action of [...appliedActions].reverse()) {
                try {
                    await undoEditNoteAction(action);
                    undoAgentAction(action.id);
                    logger(`EditNoteGroupView: Undone edit_note action ${action.id}`, 1);
                } catch (error: any) {
                    const errorMessage = error?.message || 'Failed to undo edit_note';
                    const stackTrace = error?.stack || '';
                    logger(`EditNoteGroupView: Failed to undo edit_note action ${action.id}: ${errorMessage}\n${stackTrace}`, 1);
                    if (action.toolcall_id) {
                        newFailures[action.toolcall_id] = errorMessage;
                    }
                }
            }
        } finally {
            setIsLocallyProcessing(false);
            setClickedButton(null);
            const failureCount = Object.keys(newFailures).length;
            if (failureCount > 0) {
                setPerEditUndoErrors((prev) => ({ ...prev, ...newFailures }));
                setExpanded({ key: expansionKey, expanded: true });
                logger(`EditNoteGroupView: ${failureCount} edit_note undo(s) failed for ${noteKeyLabel}`, 1);
            }
        }
    }, [
        isProcessing,
        allActions,
        undoAgentAction,
        setExpanded,
        expansionKey,
        noteKeyLabel,
    ]);

    const handleRetryAll = useCallback(async () => {
        if (isProcessing || errorActions.length === 0) return;

        setIsLocallyProcessing(true);
        setClickedButton('retry');
        try {
            await dismissActiveEditNotePreview();

            for (const action of errorActions) {
                try {
                    const result = await executeEditNoteAction(action);
                    await ackAgentActions(runId, [{
                        action_id: action.id,
                        result_data: result,
                    }]);
                    logger(`EditNoteGroupView: Retried + applied edit_note action ${action.id}`, 1);
                } catch (error: any) {
                    const errorMessage = error?.message || 'Failed to retry edit_note';
                    const stackTrace = error?.stack || '';
                    logger(`EditNoteGroupView: Retry failed for edit_note action ${action.id}: ${errorMessage}\n${stackTrace}`, 1);
                    setAgentActionsToError([action.id], errorMessage, {
                        stack_trace: stackTrace,
                        error_name: error?.name,
                    });
                }
            }
        } finally {
            setIsLocallyProcessing(false);
            setClickedButton(null);
        }
    }, [isProcessing, errorActions, ackAgentActions, runId, setAgentActionsToError]);

    const handleChildUndoErrorChange = useCallback((childToolcallId: string, error: string | null) => {
        setPerEditUndoErrors((prev) => {
            if (error === null) {
                if (!(childToolcallId in prev)) return prev;
                const next = { ...prev };
                delete next[childToolcallId];
                return next;
            }
            if (prev[childToolcallId] === error) return prev;
            return { ...prev, [childToolcallId]: error };
        });
        if (error !== null) {
            setExpanded({ key: expansionKey, expanded: true });
        }
    }, [setExpanded, expansionKey]);

    useEffect(() => {
        setPerEditUndoErrors((prev) => {
            const keys = Object.keys(prev);
            if (keys.length === 0) return prev;
            const stillApplied = new Set(
                allActions
                    .filter((a) => a.status === 'applied' && a.toolcall_id)
                    .map((a) => a.toolcall_id as string),
            );
            let changed = false;
            const next: Record<string, string> = {};
            for (const key of keys) {
                if (stillApplied.has(key)) {
                    next[key] = prev[key];
                } else {
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [allActions]);

    const handlePreviewInEditor = useCallback(async () => {
        if (!DIFF_PREVIEW_ENABLED || !resolvedTarget) return;
        const edits = hasPendingApprovals
            ? buildPreviewableEditOperations(pendingApprovalsForGroup.map((pending) => pending.actionData))
            : buildPreviewableEditOperations(reapplicableActions.map((action) => action.proposed_data));
        if (edits.length === 0) {
            logger(`EditNoteGroupView: handlePreviewInEditor — no previewable edits for ${noteKeyLabel}`, 1);
            return;
        }

        await showEditNotePreviewForEdits(resolvedTarget, edits, (bannerAction) => {
            if (bannerAction === 'approve') {
                handleApplyAll();
            } else {
                handleRejectAll();
            }
        });
    }, [
        resolvedTarget,
        hasPendingApprovals,
        pendingApprovalsForGroup,
        reapplicableActions,
        noteKeyLabel,
        handleApplyAll,
        handleRejectAll,
    ]);

    const toggleExpanded = useCallback(() => {
        setExpanded({ key: expansionKey, expanded: !isExpanded });
    }, [setExpanded, expansionKey, isExpanded]);

    const baseConfig = STATUS_CONFIGS[aggregateStatus];
    const headerIcon = (() => {
        if (isProcessing) return Spinner;
        if (isHovered && isExpanded) return ArrowDownIcon;
        if (isHovered && !isExpanded) return ArrowRightIcon;
        if (hasStreamingChild) return Spinner;
        if (aggregateStatus === 'awaiting') return EditIcon;
        if (baseConfig.icon === null) return EditIcon;
        return baseConfig.icon;
    })();
    const headerIconClassName = isProcessing
        ? 'font-color-secondary scale-10'
        : (!isHovered && (baseConfig.icon !== null || aggregateStatus !== 'awaiting')
            ? baseConfig.iconClassName
            : undefined);
    const groupLabel = editCount === 1 ? 'Note Edit' : `${editCount} Note Edits`;
    const showCollapsedHeaderActions =
        !isProcessing && !hasStreamingChild && (aggregateStatus === 'awaiting' || aggregateStatus === 'pending') && !isExpanded;
    const rejectableActionCount = useMemo(
        () => pendingApprovalsForGroup.length + allActions.filter((a) => a.status === 'pending').length,
        [pendingApprovalsForGroup, allActions],
    );

    const showFooterApply =
        reapplicableActions.length > 0 || hasPendingApprovals || (isProcessing && clickedButton === 'approve');
    const showFooterReject =
        rejectableActionCount > 0 || (isProcessing && clickedButton === 'reject');
    const showFooterUndo =
        appliedCount > 0 || (isProcessing && clickedButton === 'undo');
    const showFooterRetry =
        errorActions.length > 0 || (isProcessing && clickedButton === 'retry');
    const canShowPreview =
        !isProcessing
        && DIFF_PREVIEW_ENABLED
        && (
        resolvedTarget !== null
        && (hasPendingApprovals || reapplicableActions.length > 0)
        );

    return (
        <div
            className="agent-action-view agent-action-group rounded-md flex flex-col min-w-0 border-popup mb-2"
            data-edit-count={editCount}
            data-note-key={resolvedTarget ? `${resolvedTarget.libraryId}-${resolvedTarget.zoteroKey}` : 'pending'}
        >
            <div
                className={`
                    display-flex flex-row py-15 bg-senary items-start
                    ${isExpanded ? 'border-bottom-quarternary' : ''}
                `}
            >
                <button
                    type="button"
                    className={`
                        variant-ghost-secondary display-flex flex-row py-15 gap-2 text-left mt-015
                        ${isProcessing ? 'opacity-80' : ''}
                    `}
                    style={{ fontSize: '0.95rem', background: 'transparent', border: 0, padding: 0 }}
                    aria-expanded={isExpanded}
                    onClick={isProcessing ? () => {} : toggleExpanded}
                    disabled={isProcessing}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                >
                    <div className="display-flex flex-row ml-3 gap-2">
                        <div className="flex-1 display-flex mt-010 font-color-primary">
                            <Icon
                                icon={headerIcon}
                                className={headerIconClassName}
                            />
                        </div>
                        <div className="two-line-header">
                            <span className="font-color-primary font-medium">{groupLabel}</span>
                            {noteTitle && (
                                <>
                                    <span className="font-color-secondary ml-15">{noteTitle}</span>
                                    {'\u00A0'}
                                    {resolvedTarget && (
                                        <Tooltip content="Open note" singleLine>
                                            <span
                                                className="font-color-secondary scale-10"
                                                style={{ display: 'inline-flex', verticalAlign: 'middle', cursor: 'pointer' }}
                                                role="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    e.preventDefault();
                                                    openNoteByKey(resolvedTarget.libraryId, resolvedTarget.zoteroKey);
                                                }}
                                            >
                                                <Icon icon={ArrowUpRightIcon} />
                                            </span>
                                        </Tooltip>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </button>

                <div className="flex-1" />

                <div
                    className="display-flex flex-row items-center gap-25 mr-2 mt-015"
                    style={{ visibility: !(aggregateStatus === 'awaiting' || aggregateStatus === 'pending') ? 'visible' : 'hidden' }}
                >
                    <Tooltip content={isExpanded ? 'Collapse' : 'Expand'} showArrow singleLine>
                        <IconButton
                            icon={ChevronIcon}
                            variant="ghost-secondary"
                            iconClassName="scale-12"
                            onClick={toggleExpanded}
                        />
                    </Tooltip>
                </div>

                {showCollapsedHeaderActions && (
                    <div className="display-flex flex-row items-center gap-25 mr-3 mt-015">
                        {(!isProcessing || clickedButton === 'reject') && (
                            <Tooltip content="Reject all" showArrow singleLine>
                                <IconButton
                                    icon={CancelIcon}
                                    variant="ghost-secondary"
                                    iconClassName="font-color-red"
                                    onClick={handleRejectAll}
                                    disabled={isProcessing}
                                    loading={isProcessing && clickedButton === 'reject'}
                                />
                            </Tooltip>
                        )}
                        {(!isProcessing || clickedButton === 'approve') && (
                            <Tooltip content="Apply all" showArrow singleLine>
                                <IconButton
                                    icon={TickIcon}
                                    variant="ghost-secondary"
                                    iconClassName="font-color-green scale-14"
                                    onClick={handleApplyAll}
                                    disabled={isProcessing}
                                    loading={isProcessing && clickedButton === 'approve'}
                                />
                            </Tooltip>
                        )}
                    </div>
                )}
            </div>

            {isExpanded && (
                <div className="display-flex flex-col">
                    <div className="display-flex flex-col">
                        {parts.map((part, idx) => (
                            <div
                                key={`tool-${part.tool_call_id}`}
                                className={idx > 0 ? 'border-top-quinary' : undefined}
                            >
                                <EditNoteRowView
                                    part={part}
                                    runId={runId}
                                    runStatus={runStatus}
                                    disabled={isProcessing}
                                    externalUndoError={perEditUndoErrors[part.tool_call_id] ?? null}
                                    onUndoErrorChange={handleChildUndoErrorChange}
                                />
                            </div>
                        ))}
                    </div>

                    {(showFooterApply || showFooterReject || showFooterUndo || showFooterRetry || canShowPreview) && (
                        <div className="display-flex flex-row gap-2 px-2 py-2">
                            <div className="flex-1" />

                            {canShowPreview && (
                                <Button
                                    variant="ghost"
                                    icon={FileDiffIcon}
                                    onClick={handlePreviewInEditor}
                                    style={{ padding: '3px 6px' }}
                                    disabled={isProcessing}
                                >
                                    Preview
                                </Button>
                            )}

                            {showFooterReject && (!isProcessing || clickedButton === 'reject') && (
                                <Button
                                    variant="outline"
                                    onClick={handleRejectAll}
                                    loading={isProcessing && clickedButton === 'reject'}
                                    disabled={isProcessing}
                                >
                                    Reject All
                                </Button>
                            )}

                            {showFooterUndo && (!isProcessing || clickedButton === 'undo') && (
                                <Button
                                    variant="outline"
                                    onClick={handleUndoAll}
                                    loading={isProcessing && clickedButton === 'undo'}
                                    disabled={isProcessing}
                                >
                                    Undo All
                                </Button>
                            )}

                            {showFooterRetry && (!isProcessing || clickedButton === 'retry') && (
                                <Button
                                    variant="outline"
                                    icon={RepeatIcon}
                                    onClick={handleRetryAll}
                                    loading={isProcessing && clickedButton === 'retry'}
                                    disabled={isProcessing}
                                >
                                    Retry All
                                </Button>
                            )}

                            {showFooterApply && (!isProcessing || clickedButton === 'approve') && (
                                hasPendingApprovals ? (
                                    <SplitApplyButton
                                        onApply={handleApplyAll}
                                        onApplyAll={handleApproveAllForNote}
                                        loading={isProcessing && clickedButton === 'approve'}
                                        disabled={isProcessing}
                                        primaryLabel="Apply All"
                                        applyAllLabel="Always apply for this note"
                                    />
                                ) : (
                                    <Button
                                        variant="solid"
                                        onClick={handleApplyAll}
                                        loading={isProcessing && clickedButton === 'approve'}
                                        disabled={isProcessing}
                                    >
                                        <span>Apply All</span>
                                    </Button>
                                )
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default EditNoteGroupView;
