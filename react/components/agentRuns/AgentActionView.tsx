import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { AgentRunStatus } from '../../agents/types';
import {
    AgentAction,
    PendingApproval,
    getAgentActionsByToolcallAtom,
    removePendingApprovalAtom,
    undoAgentActionAtom,
    ackAgentActionsAtom,
    rejectAgentActionAtom,
    setAgentActionsToErrorAtom,
} from '../../agents/agentActions';
import {
    approvalResponseIntentsAtom,
    isWSChatPendingAtom,
    removeApprovalResponseIntentAtom,
    sendApprovalResponseAtom,
} from '../../atoms/agentRunAtoms';
import {
    agentActionItemTitlesAtom,
    setAgentActionItemTitleAtom,
    toolExpandedAtom,
    setToolExpandedAtom,
} from '../../atoms/messageUIState';
import { executeEditMetadataAction, undoEditMetadataAction, UndoResult } from '../../utils/editMetadataActions';
import { executeCreateCollectionAction, undoCreateCollectionAction } from '../../utils/createCollectionActions';
import { executeOrganizeItemsAction, undoOrganizeItemsAction } from '../../utils/organizeItemsActions';
import { executeCreateItemActions, undoCreateItemActions } from '../../utils/createItemActions';
import { executeCreateNoteAction, undoCreateNoteAction } from '../../utils/createNoteActions';
import { executeManageTagsAction, undoManageTagsAction } from '../../utils/manageTagsActions';
import { executeManageCollectionsAction, undoManageCollectionsAction } from '../../utils/manageCollectionsActions';
import type { CreateItemProposedData } from '../../types/agentActions/items';
import { shortItemTitle } from '../../../src/utils/zoteroUtils';
import { logger } from '../../../src/utils/logger';
import {
    TickIcon,
    CancelIcon,
    ChevronIcon,
    ClockIcon,
    Spinner,
    Icon,
    RepeatIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    PropertyEditIcon,
    ArrowUpRightIcon,
    FolderAddIcon,
    FolderDetailIcon,
    TaskDoneIcon,
    TagIcon,
    DeleteIcon,
    DocumentValidationIcon,
    DollarCircleIcon,
    GlobalSearchIcon,
    FileDiffIcon,
} from '../icons/icons';
import { revealSource, openNoteByKey } from '../../utils/sourceUtils';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';
import DeferredToolPreferenceButton from '../ui/buttons/DeferredToolPreferenceButton';
import ExtractionApprovalButton from '../ui/buttons/ExtractionApprovalButton';
import ExternalSearchApprovalButton from '../ui/buttons/ExternalSearchApprovalButton';
import { markExternalReferenceImportedAtom, markExternalReferenceDeletedAtom } from '../../atoms/externalReferences';
import {
    ActionStatus,
    STATUS_CONFIGS,
    NEVER_AUTO_COLLAPSE_TOOLS,
    confirmOverwriteManualChanges,
    getOverallStatus,
    getActionLabel,
    getActionTitle,
    buildPreviewData,
    PreviewData,
} from './agentActionViewHelpers';
import { ActionPreview } from './ActionPreview';

export { STATUS_CONFIGS, getOverallStatus } from './agentActionViewHelpers';
export type { ActionStatus } from './agentActionViewHelpers';

interface AgentActionViewProps {
    toolcallId: string;
    toolName: string;
    runId: string;
    responseIndex: number;
    pendingApproval: PendingApproval | null;
    hasToolReturn?: boolean;
    streamingArgs?: Record<string, any> | null;
    runStatus?: AgentRunStatus;
}

export const AgentActionView: React.FC<AgentActionViewProps> = ({
    toolcallId,
    toolName,
    runId,
    responseIndex,
    pendingApproval: pendingApprovalProp,
    hasToolReturn = false,
    streamingArgs,
    runStatus,
}) => {
    const [isHovered, setIsHovered] = useState(false);

    const getAgentActionsByToolcall = useAtomValue(getAgentActionsByToolcallAtom);
    const actions = getAgentActionsByToolcall(toolcallId, (a) => a.run_id === runId);
    const action = actions.length > 0 ? actions[0] : null;

    const actionInFinalState = action && action.status !== 'pending';
    const pendingApproval = actionInFinalState ? null : pendingApprovalProp;
    const isAwaitingApproval = pendingApproval !== null;

    const runIsStreamable = runStatus === undefined || runStatus === 'in_progress';
    const isStreaming = !action
        && !pendingApproval
        && !!streamingArgs
        && Object.keys(streamingArgs).length > 0
        && runIsStreamable;

    const expansionKey = `${runId}:${responseIndex}:${toolcallId}`;
    const expansionState = useAtomValue(toolExpandedAtom);
    const setExpanded = useSetAtom(setToolExpandedAtom);
    const hasExistingState = expansionState[expansionKey] !== undefined;
    const neverAutoCollapse = NEVER_AUTO_COLLAPSE_TOOLS.has(toolName);
    const isExpanded = expansionState[expansionKey] ?? (isAwaitingApproval || neverAutoCollapse);

    const prevAwaitingRef = useRef(isAwaitingApproval);
    const hasInitializedRef = useRef(false);
    useEffect(() => {
        if (!hasInitializedRef.current) {
            hasInitializedRef.current = true;
            if (!hasExistingState) {
                setExpanded({ key: expansionKey, expanded: isAwaitingApproval || neverAutoCollapse });
            }
            return;
        }

        if (prevAwaitingRef.current !== isAwaitingApproval) {
            setExpanded({
                key: expansionKey,
                expanded: neverAutoCollapse ? true : isAwaitingApproval,
            });
        }
        prevAwaitingRef.current = isAwaitingApproval;
    }, [isAwaitingApproval, expansionKey, hasExistingState, neverAutoCollapse, setExpanded]);

    const [isProcessingApproval, setIsProcessingApproval] = useState(false);
    const [isProcessingAction, setIsProcessingAction] = useState(false);
    const [isUndoError, setIsUndoError] = useState(false);
    const [isExternallyProcessing, setIsExternallyProcessing] = useState(false);
    const [clickedButton, setClickedButton] = useState<'approve' | 'reject' | 'undo' | null>(null);
    const prevPendingApprovalRef = useRef<PendingApproval | null>(pendingApproval);

    const isRunPending = useAtomValue(isWSChatPendingAtom);
    const approvalResponseIntents = useAtomValue(approvalResponseIntentsAtom);
    const isMultiAction = (toolName === 'create_items' || toolName === 'create_item') && actions.length > 1;

    const sendApprovalResponse = useSetAtom(sendApprovalResponseAtom);
    const removeApprovalResponseIntent = useSetAtom(removeApprovalResponseIntentAtom);
    const removePendingApproval = useSetAtom(removePendingApprovalAtom);
    const ackAgentActions = useSetAtom(ackAgentActionsAtom);
    const rejectAgentAction = useSetAtom(rejectAgentActionAtom);
    const setAgentActionsToError = useSetAtom(setAgentActionsToErrorAtom);
    const undoAgentAction = useSetAtom(undoAgentActionAtom);
    const markExternalReferenceImported = useSetAtom(markExternalReferenceImportedAtom);
    const markExternalReferenceDeleted = useSetAtom(markExternalReferenceDeletedAtom);

    const itemTitleKey = `${responseIndex}:${toolcallId}`;
    const itemTitleMap = useAtomValue(agentActionItemTitlesAtom);
    const itemTitle = itemTitleMap[itemTitleKey] ?? null;
    const setItemTitle = useSetAtom(setAgentActionItemTitleAtom);

    const hasAssociatedItem =
        toolName === 'edit_metadata' ||
        toolName === 'edit_item';

    useEffect(() => {
        if (!hasAssociatedItem || itemTitle) return;

        const fetchTitle = async () => {
            const libraryId: number | undefined =
                action?.proposed_data?.library_id ?? pendingApproval?.actionData?.library_id;
            const zoteroKey: string | undefined =
                action?.proposed_data?.zotero_key ?? pendingApproval?.actionData?.zotero_key;

            if (!libraryId || !zoteroKey) return;

            const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, zoteroKey);
            if (item) {
                const title = await shortItemTitle(item);
                setItemTitle({ key: itemTitleKey, title });
            }
        };

        fetchTitle();
    }, [action, pendingApproval, itemTitle, itemTitleKey, hasAssociatedItem, setItemTitle]);

    useEffect(() => {
        const previousPendingApproval = prevPendingApprovalRef.current;
        const wasAwaiting = previousPendingApproval !== null;
        const isNoLongerAwaiting = pendingApproval === null;

        if (wasAwaiting && isNoLongerAwaiting) {
            const previousActionId = previousPendingApproval.actionId;
            const previousIntent = approvalResponseIntents.get(previousActionId);

            if (!isProcessingApproval && isRunPending && !hasToolReturn) {
                setIsExternallyProcessing(true);
                setClickedButton(previousIntent === false ? 'reject' : 'approve');
            }

            if (previousIntent !== undefined) {
                removeApprovalResponseIntent(previousActionId);
            }
        }

        prevPendingApprovalRef.current = pendingApproval;
    }, [
        pendingApproval,
        isProcessingApproval,
        isRunPending,
        hasToolReturn,
        approvalResponseIntents,
        removeApprovalResponseIntent,
    ]);

    useEffect(() => {
        if ((isProcessingApproval || isExternallyProcessing) && action && action.status !== 'pending') {
            setIsProcessingApproval(false);
            setIsExternallyProcessing(false);
            setClickedButton(null);
        }
        if (isExternallyProcessing && (hasToolReturn || !isRunPending)) {
            setIsExternallyProcessing(false);
            setClickedButton(null);
        }
    }, [isProcessingApproval, isExternallyProcessing, action?.status, hasToolReturn, isRunPending, action]);

    const isProcessing = isProcessingApproval || isProcessingAction || isExternallyProcessing;
    const status: ActionStatus | 'awaiting' = (isAwaitingApproval || isProcessing)
        ? 'awaiting'
        : isMultiAction
            ? getOverallStatus(actions)
            : (action?.status ?? 'pending');
    const isConfirmExtraction = toolName === 'confirm_extraction';
    const isConfirmExternalSearch = toolName === 'confirm_external_search';
    const isConfirmAction = isConfirmExtraction || isConfirmExternalSearch;
    const hasNoActionData = !action && !pendingApproval && !isStreaming;
    const baseConfig = STATUS_CONFIGS[status];
    const config = (isConfirmAction && status !== 'awaiting')
        ? { ...baseConfig, showApply: false, showReject: false, showUndo: false, showRetry: false }
        : baseConfig;

    const handleApprove = useCallback(() => {
        if (!pendingApproval) return;
        setIsProcessingApproval(true);
        setClickedButton('approve');
        sendApprovalResponse({ actionId: pendingApproval.actionId, approved: true });
        removePendingApproval(pendingApproval.actionId);
    }, [pendingApproval, sendApprovalResponse, removePendingApproval]);

    const handleReject = useCallback(() => {
        if (!pendingApproval) return;
        setIsProcessingApproval(true);
        setClickedButton('reject');
        sendApprovalResponse({ actionId: pendingApproval.actionId, approved: false });
        removePendingApproval(pendingApproval.actionId);
    }, [pendingApproval, sendApprovalResponse, removePendingApproval]);

    const handleApplyPending = useCallback(async () => {
        if (actions.length === 0 || isProcessing) return;

        setIsUndoError(false);
        setIsProcessingAction(true);
        setClickedButton('approve');
        try {
            if (toolName === 'edit_metadata') {
                const result = await executeEditMetadataAction(action!);
                await ackAgentActions(runId, [{
                    action_id: action!.id,
                    result_data: result,
                }]);
                logger(`AgentActionView: Applied edit_metadata action ${action!.id}`, 1);
            } else if (toolName === 'create_collection') {
                const result = await executeCreateCollectionAction(action!);
                await ackAgentActions(runId, [{
                    action_id: action!.id,
                    result_data: result,
                }]);
                logger(`AgentActionView: Applied create_collection action ${action!.id}`, 1);
            } else if (toolName === 'organize_items') {
                const result = await executeOrganizeItemsAction(action!);
                await ackAgentActions(runId, [{
                    action_id: action!.id,
                    result_data: result,
                }]);
                logger(`AgentActionView: Applied organize_items action ${action!.id}`, 1);
            } else if (toolName === 'manage_tags') {
                const result = await executeManageTagsAction(action!);
                await ackAgentActions(runId, [{
                    action_id: action!.id,
                    result_data: result,
                }]);
                logger(`AgentActionView: Applied manage_tags action ${action!.id}`, 1);
            } else if (toolName === 'manage_collections') {
                const result = await executeManageCollectionsAction(action!);
                await ackAgentActions(runId, [{
                    action_id: action!.id,
                    result_data: result,
                }]);
                logger(`AgentActionView: Applied manage_collections action ${action!.id}`, 1);
            } else if (toolName === 'create_note') {
                const result = await executeCreateNoteAction(action!, runId);
                await ackAgentActions(runId, [{
                    action_id: action!.id,
                    result_data: result,
                }]);
                logger(`AgentActionView: Applied create_note action ${action!.id}`, 1);
            } else if (toolName === 'create_items' || toolName === 'create_item') {
                const actionsToApply = actions.filter((candidate) => candidate.status !== 'applied');
                if (actionsToApply.length === 0) return;

                const batchResult = await executeCreateItemActions(actionsToApply);
                if (batchResult.successes.length > 0) {
                    await ackAgentActions(runId, batchResult.successes.map((success) => ({
                        action_id: success.action.id,
                        result_data: success.result,
                    })));
                    logger(`AgentActionView: Applied ${batchResult.successes.length} create_item actions`, 1);

                    for (const success of batchResult.successes) {
                        const proposedData = success.action.proposed_data as CreateItemProposedData;
                        if (proposedData?.item?.source_id) {
                            markExternalReferenceImported(proposedData.item.source_id, {
                                library_id: success.result.library_id,
                                zotero_key: success.result.zotero_key,
                            });
                        }
                    }
                }

                if (batchResult.failures.length > 0) {
                    for (const failure of batchResult.failures) {
                        setAgentActionsToError([failure.action.id], failure.error, failure.errorDetails);
                    }
                    logger(`AgentActionView: Failed to apply ${batchResult.failures.length} create_item actions`, 1);
                }
            }
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to apply action';
            const stackTrace = error?.stack || '';
            logger(`AgentActionView: Failed to apply actions: ${errorMessage}\nStack trace:\n${stackTrace}`, 1);
            setAgentActionsToError(actions.map((candidate) => candidate.id), errorMessage, {
                stack_trace: stackTrace,
                error_name: error?.name,
            });
        } finally {
            setIsProcessingAction(false);
            setClickedButton(null);
        }
    }, [
        action,
        actions,
        isProcessing,
        toolName,
        runId,
        ackAgentActions,
        setAgentActionsToError,
        markExternalReferenceImported,
    ]);

    const handleRejectPending = useCallback(() => {
        if (actions.length === 0 || isProcessing) return;

        setClickedButton('reject');
        if (isMultiAction) {
            for (const candidate of actions) {
                rejectAgentAction(candidate.id);
            }
            logger(`AgentActionView: Rejected ${actions.length} create_item actions`, 1);
        } else {
            rejectAgentAction(action!.id);
        }
        setTimeout(() => setClickedButton(null), 100);
    }, [action, actions, isProcessing, isMultiAction, rejectAgentAction]);

    const handleUndo = useCallback(async () => {
        if (!action || isProcessing) return;

        setIsProcessingAction(true);
        setClickedButton('undo');
        try {
            if (toolName === 'edit_metadata') {
                let result: UndoResult = await undoEditMetadataAction(action, false);
                if (result.needsConfirmation && result.manuallyModified.length > 0) {
                    const shouldOverwrite = confirmOverwriteManualChanges(result.manuallyModified);
                    if (shouldOverwrite) {
                        result = await undoEditMetadataAction(action, true);
                        logger(`AgentActionView: Force-reverted ${result.fieldsReverted} fields after user confirmation`, 1);
                    } else {
                        logger(`AgentActionView: User declined to overwrite ${result.manuallyModified.length} manually modified fields`, 1);
                    }
                }
                if (result.alreadyReverted.length > 0) {
                    logger(`AgentActionView: Fields already at original value: ${result.alreadyReverted.join(', ')}`, 1);
                }
                undoAgentAction(action.id);
                logger(`AgentActionView: Undone edit_metadata action ${action.id} (${result.fieldsReverted} fields reverted)`, 1);
            } else if (toolName === 'create_collection') {
                await undoCreateCollectionAction(action);
                undoAgentAction(action.id);
                logger(`AgentActionView: Undone create_collection action ${action.id}`, 1);
            } else if (toolName === 'organize_items') {
                await undoOrganizeItemsAction(action);
                undoAgentAction(action.id);
                logger(`AgentActionView: Undone organize_items action ${action.id}`, 1);
            } else if (toolName === 'manage_tags') {
                await undoManageTagsAction(action);
                undoAgentAction(action.id);
                logger(`AgentActionView: Undone manage_tags action ${action.id}`, 1);
            } else if (toolName === 'manage_collections') {
                await undoManageCollectionsAction(action);
                undoAgentAction(action.id);
                logger(`AgentActionView: Undone manage_collections action ${action.id}`, 1);
            } else if (toolName === 'create_note') {
                await undoCreateNoteAction(action);
                undoAgentAction(action.id);
                logger(`AgentActionView: Undone create_note action ${action.id}`, 1);
            } else if (toolName === 'create_items' || toolName === 'create_item') {
                const actionsToUndo = actions.filter((candidate) => candidate.status === 'applied');
                if (actionsToUndo.length === 0) return;

                const batchResult = await undoCreateItemActions(actionsToUndo);
                for (const actionId of batchResult.successes) {
                    undoAgentAction(actionId);
                    const undoneAction = actionsToUndo.find((candidate) => candidate.id === actionId);
                    if (undoneAction) {
                        const proposedData = undoneAction.proposed_data as CreateItemProposedData;
                        if (proposedData?.item?.source_id) {
                            markExternalReferenceDeleted(proposedData.item.source_id);
                        }
                    }
                }
                for (const failure of batchResult.failures) {
                    setAgentActionsToError([failure.actionId], failure.error, failure.errorDetails);
                }
                logger(`AgentActionView: Undone ${batchResult.successes.length} create_item actions`, 1);
                if (batchResult.failures.length > 0) {
                    logger(`AgentActionView: Failed to undo ${batchResult.failures.length} create_item actions`, 1);
                }
            }
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to undo action';
            const stackTrace = error?.stack || '';
            logger(`AgentActionView: Failed to undo actions: ${errorMessage}\nStack trace:\n${stackTrace}`, 1);

            setIsUndoError(true);
            const appliedActionIds = actions.filter((candidate) => candidate.status === 'applied').map((candidate) => candidate.id);
            if (appliedActionIds.length > 0) {
                setAgentActionsToError(appliedActionIds, errorMessage, {
                    stack_trace: stackTrace,
                    error_name: error?.name,
                });
            }
        } finally {
            setIsProcessingAction(false);
            setClickedButton(null);
        }
    }, [
        action,
        actions,
        isProcessing,
        toolName,
        undoAgentAction,
        setAgentActionsToError,
        markExternalReferenceDeleted,
    ]);

    const handleRetry = useCallback(async () => {
        if (isUndoError) {
            setIsUndoError(false);
            await handleUndo();
        } else {
            await handleApplyPending();
        }
    }, [isUndoError, handleUndo, handleApplyPending]);

    const toggleExpanded = () => setExpanded({ key: expansionKey, expanded: !isExpanded });
    const previewData = buildPreviewData(toolName, pendingApproval, action);

    const getHeaderIcon = () => {
        const getToolIcon = () => {
            if (toolName === 'edit_metadata' || toolName === 'edit_item') return PropertyEditIcon;
            if (toolName === 'create_note') return FileDiffIcon;
            if (toolName === 'create_collection') return FolderAddIcon;
            if (toolName === 'organize_items') return TaskDoneIcon;
            if (toolName === 'manage_tags') return TagIcon;
            if (toolName === 'manage_collections') return FolderDetailIcon;
            if (toolName === 'create_items' || toolName === 'create_item') return DocumentValidationIcon;
            if (toolName === 'confirm_extraction') return DollarCircleIcon;
            if (toolName === 'confirm_external_search') return GlobalSearchIcon;
            return ClockIcon;
        };
        if (isAwaitingApproval) return getToolIcon();
        if (isHovered && isExpanded) return ArrowDownIcon;
        if (isHovered && !isExpanded) return ArrowRightIcon;
        if (config.icon === null) return getToolIcon();
        return config.icon;
    };

    const shouldShowStatusIcon = () => {
        if (isHovered) return false;
        return config.icon !== null || !isAwaitingApproval;
    };

    const actionTitle = getActionTitle(toolName, action?.proposed_data, itemTitle, actions);

    if (isStreaming) {
        const effectiveArgs = streamingArgs ?? {};
        const streamingTitle = getActionTitle(toolName, effectiveArgs, itemTitle, undefined);
        const streamingPreviewData: PreviewData = {
            actionType: toolName,
            actionData: effectiveArgs,
        };

        return (
            <div className="agent-action-view rounded-md flex flex-col min-w-0 border-popup mb-2">
                <div className="display-flex flex-row py-15 bg-senary border-bottom-quinary">
                    <div
                        className="variant-ghost-secondary display-flex flex-row py-15 gap-2 text-left mt-015"
                        style={{ background: 'transparent', border: 0, padding: 0 }}
                    >
                        <div className="display-flex flex-row px-3 gap-2">
                            <div className="flex-1 display-flex mt-010">
                                <Icon icon={Spinner} />
                            </div>
                            <div className="two-line-header shimmer-text">
                                <span className="font-color-primary font-medium" style={{ fontWeight: '500' }}>{getActionLabel(toolName)}</span>
                                {streamingTitle && <span className="font-color-secondary ml-15" style={{ fontWeight: '400' }}>{streamingTitle}</span>}
                            </div>
                        </div>
                    </div>
                </div>
                <ActionPreview
                    toolName={toolName}
                    previewData={streamingPreviewData}
                    status="pending"
                    isStreaming={true}
                />
            </div>
        );
    }

    return (
        <div className="agent-action-view rounded-md flex flex-col min-w-0 border-popup mb-2">
            <div
                className={`
                    display-flex flex-row py-15 bg-senary items-start
                    ${isExpanded ? 'border-bottom-quinary' : ''}
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
                            <Icon icon={getHeaderIcon()} className={shouldShowStatusIcon() ? config.iconClassName : undefined} />
                        </div>
                        <div className="two-line-header">
                            <span className="font-color-primary font-medium">{getActionLabel(toolName)}</span>
                            {actionTitle && <span className="font-color-secondary ml-15">{actionTitle}</span>}
                            {((action?.proposed_data?.library_id && action?.proposed_data?.zotero_key) || (toolName === 'create_note' && action?.status === 'applied' && action?.result_data?.library_id && action?.result_data?.zotero_key)) && (
                                <>
                                    {'\u00A0'}
                                    <Tooltip content={toolName === 'create_note' ? 'Open note' : 'Reveal in Zotero'} singleLine>
                                        <span
                                            className="font-color-secondary scale-10"
                                            style={{ display: 'inline-flex', verticalAlign: 'middle', cursor: 'pointer' }}
                                            role="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                e.preventDefault();
                                                if (toolName === 'create_note' && action?.status === 'applied' && action?.result_data?.library_id && action?.result_data?.zotero_key) {
                                                    openNoteByKey(action.result_data.library_id, action.result_data.zotero_key);
                                                } else {
                                                    revealSource({
                                                        library_id: action?.proposed_data?.library_id,
                                                        zotero_key: action?.proposed_data?.zotero_key,
                                                    });
                                                }
                                            }}
                                        >
                                            <Icon icon={ArrowUpRightIcon} />
                                        </span>
                                    </Tooltip>
                                </>
                            )}
                        </div>
                    </div>
                </button>

                <div className="flex-1" />

                <div
                    className="display-flex flex-row items-center gap-25 mr-2 mt-015"
                    style={{ visibility: !(isAwaitingApproval || status === 'pending') ? 'visible' : 'hidden' }}
                >
                    <Tooltip content="Expand" showArrow singleLine>
                        <IconButton
                            icon={ChevronIcon}
                            variant="ghost-secondary"
                            iconClassName="scale-12"
                            onClick={toggleExpanded}
                        />
                    </Tooltip>
                </div>

                {((isAwaitingApproval || status === 'pending') && !isProcessing && !isConfirmAction && !hasNoActionData) && (
                    <div className="display-flex flex-row items-center gap-25 mr-3 mt-015">
                        {(!isProcessing || clickedButton === 'reject') && (
                            <Tooltip content="Reject" showArrow singleLine>
                                <IconButton
                                    icon={CancelIcon}
                                    variant="ghost-secondary"
                                    iconClassName="font-color-red"
                                    onClick={isAwaitingApproval ? handleReject : handleRejectPending}
                                    disabled={isProcessing}
                                    loading={isProcessing && clickedButton === 'reject'}
                                />
                            </Tooltip>
                        )}
                        {(!isProcessing || clickedButton === 'approve') && (
                            <Tooltip content="Apply" showArrow singleLine>
                                <IconButton
                                    icon={TickIcon}
                                    variant="ghost-secondary"
                                    iconClassName="font-color-green scale-14"
                                    onClick={isAwaitingApproval ? handleApprove : handleApplyPending}
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
                    {previewData ? (
                        <ActionPreview
                            toolName={toolName}
                            previewData={previewData}
                            status={status}
                            actions={actions}
                        />
                    ) : (
                        <div className="text-sm font-color-secondary">
                            No preview available
                        </div>
                    )}

                    <div className="display-flex flex-row gap-2 px-2 py-2">
                        {(isAwaitingApproval || status === 'pending') && !hasNoActionData && (
                            isConfirmExtraction ? (
                                <ExtractionApprovalButton onAlwaysApprove={handleApprove} />
                            ) : isConfirmExternalSearch ? (
                                <ExternalSearchApprovalButton onAlwaysApprove={handleApprove} />
                            ) : (
                                <DeferredToolPreferenceButton toolName={toolName} />
                            )
                        )}
                        <div className="flex-1" />

                        {config.showReject && (!isProcessing || clickedButton === 'reject') && (
                            <Button
                                variant="outline"
                                onClick={isAwaitingApproval ? handleReject : handleRejectPending}
                                loading={isProcessing && clickedButton === 'reject'}
                                disabled={isProcessing}
                            >
                                Reject
                            </Button>
                        )}

                        {(config.showUndo || (isProcessing && clickedButton === 'undo')) && (
                            <Button
                                variant="outline"
                                onClick={handleUndo}
                                loading={isProcessing && clickedButton === 'undo'}
                                disabled={isProcessing}
                            >
                                Undo
                            </Button>
                        )}

                        {config.showRetry && (
                            <Button
                                variant="outline"
                                icon={RepeatIcon}
                                onClick={handleRetry}
                                loading={isProcessing}
                            >
                                {isUndoError ? 'Retry Undo' : 'Try Again'}
                            </Button>
                        )}

                        {config.showApply && (!isProcessing || clickedButton === 'approve') && (
                            <Button
                                variant="solid"
                                onClick={isAwaitingApproval ? handleApprove : handleApplyPending}
                                loading={isProcessing && clickedButton === 'approve'}
                                disabled={isProcessing}
                            >
                                <span>{isConfirmAction ? 'Confirm' : 'Apply'}</span>
                            </Button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default AgentActionView;
