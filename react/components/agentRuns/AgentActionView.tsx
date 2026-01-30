import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
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
import { sendApprovalResponseAtom } from '../../atoms/agentRunAtoms';
import {
    agentActionItemTitlesAtom,
    setAgentActionItemTitleAtom,
    toolExpandedAtom,
    setToolExpandedAtom,
} from '../../atoms/messageUIState';
import { EditMetadataPreview } from './EditMetadataPreview';
import { CreateCollectionPreview } from './CreateCollectionPreview';
import { OrganizeItemsPreview } from './OrganizeItemsPreview';
import { CreateItemsPreview } from './CreateItemsPreview';
import { executeEditMetadataAction, undoEditMetadataAction, UndoResult } from '../../utils/editMetadataActions';
import { executeCreateCollectionAction, undoCreateCollectionAction } from '../../utils/createCollectionActions';
import { executeOrganizeItemsAction, undoOrganizeItemsAction } from '../../utils/organizeItemsActions';
import { executeCreateItemActions, undoCreateItemActions } from '../../utils/createItemActions';
import type { CreateItemProposedData, CreateItemResultData } from '../../types/agentActions/items';
import { shortItemTitle } from '../../../src/utils/zoteroUtils';
import { logger } from '../../../src/utils/logger';
import type { OrganizeItemsResultData } from '../../types/agentActions/base';
import {
    TickIcon,
    CancelIcon,
    CheckmarkCircleIcon,
    ChevronIcon,
    CancelCircleIcon,
    AlertIcon,
    ClockIcon,
    Spinner,
    Icon,
    RepeatIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    PropertyEditIcon,
    ArrowUpRightIcon,
    FolderAddIcon,
    TaskDoneIcon,
    DocumentValidationIcon,
} from '../icons/icons';
import { revealSource } from '../../utils/sourceUtils';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';
import DeferredToolPreferenceButton from '../ui/buttons/DeferredToolPreferenceButton';
import { truncateText } from '../../utils/stringUtils';
import { markExternalReferenceImportedAtom } from '../../atoms/externalReferences';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error';

/**
 * Prompt user to confirm overwriting manually modified fields during undo.
 * Returns true if user confirms, false otherwise.
 */
function confirmOverwriteManualChanges(modifiedFields: string[]): boolean {
    const fieldList = modifiedFields.join(', ');
    const title = 'Overwrite manual changes?';
    const message = modifiedFields.length === 1
        ? `The field "${fieldList}" has been manually modified since the edit was applied. Do you want to overwrite your changes and revert to the original value?`
        : `The following fields have been manually modified since the edit was applied: ${fieldList}. Do you want to overwrite your changes and revert to the original values?`;

    const buttonIndex = Zotero.Prompt.confirm({
        window: Zotero.getMainWindow(),
        title,
        text: message,
        button0: Zotero.Prompt.BUTTON_TITLE_YES,
        button1: Zotero.Prompt.BUTTON_TITLE_NO,
        defaultButton: 1,
    });

    return buttonIndex === 0;
}

interface AgentActionViewProps {
    toolcallId: string;
    toolName: string;
    /** Run ID for persisting action state to backend */
    runId: string;
    /** Pending approval request if awaiting user decision */
    pendingApproval: PendingApproval | null;
}

interface StatusConfig {
    icon: React.FC<React.SVGProps<SVGSVGElement>> | null;
    label: string;
    iconClassName?: string;
    showApply: boolean;
    showReject: boolean;
    showUndo: boolean;
    showRetry: boolean;
}

const STATUS_CONFIGS: Record<ActionStatus | 'awaiting', StatusConfig> = {
    awaiting: {
        icon: Spinner,
        label: 'Awaiting approval',
        showApply: true,
        showReject: true,
        showUndo: false,
        showRetry: false,
    },
    pending: {
        icon: null,
        label: 'Pending',
        iconClassName: 'font-color-secondary',
        showApply: true,
        showReject: true,
        showUndo: false,
        showRetry: false,
    },
    applied: {
        icon: CheckmarkCircleIcon,
        label: 'Applied',
        iconClassName: 'font-color-green scale-11',
        showApply: false,
        showReject: false,
        showUndo: true,
        showRetry: false,
    },
    rejected: {
        icon: CancelCircleIcon,
        label: 'Rejected',
        iconClassName: 'font-color-red scale-11',
        showApply: true,
        showReject: false,
        showUndo: false,
        showRetry: false,
    },
    undone: {
        icon: CancelCircleIcon,
        label: 'Undone',
        iconClassName: 'font-color-red scale-11',
        showApply: true,
        showReject: false,
        showUndo: false,
        showRetry: false,
    },
    error: {
        icon: AlertIcon,
        label: 'Failed',
        iconClassName: 'color-error',
        showApply: false,
        showReject: false,
        showUndo: false,
        showRetry: true,
    },
};

/**
 * Compute the overall status for a group of actions.
 * Used for batch operations where we need a single status to display.
 * Priority: pending > applied (even partial) > error (only if none applied) > rejected/undone
 * 
 * Note: We prioritize 'applied' over 'error' when there are mixed results,
 * so users can still undo successfully applied items even if some failed.
 */
function getOverallStatus(actions: AgentAction[]): ActionStatus {
    if (actions.length === 0) return 'pending';
    
    const statuses = actions.map(a => a.status);
    const hasApplied = statuses.some(s => s === 'applied');
    const hasPending = statuses.some(s => s === 'pending');
    const hasError = statuses.some(s => s === 'error');
    
    // If any is pending, show pending (still waiting)
    if (hasPending) return 'pending';
    // If any are applied, show applied (enables Undo for partial success)
    if (hasApplied) return 'applied';
    // If all have errors (none applied), show error
    if (hasError) return 'error';
    // If all are rejected or undone
    if (statuses.every(s => s === 'rejected' || s === 'undone')) return 'rejected';
    
    return 'pending';
}

/**
 * Unified component for displaying agent action states.
 * Handles all states: awaiting approval, applied, rejected, undone, error, and pending.
 */
export const AgentActionView: React.FC<AgentActionViewProps> = ({
    toolcallId,
    toolName,
    runId,
    pendingApproval,
}) => {
    const isAwaitingApproval = pendingApproval !== null;
    const [isHovered, setIsHovered] = useState(false);

    // Use global Jotai atom for expansion state (persists across re-renders and syncs between panes)
    const expansionKey = `${runId}:${toolcallId}`;
    const expansionState = useAtomValue(toolExpandedAtom);
    const setExpanded = useSetAtom(setToolExpandedAtom);
    
    // Check if state exists at render time (not in effect) to avoid dependency on entire expansionState
    const hasExistingState = expansionState[expansionKey] !== undefined;
    const isExpanded = expansionState[expansionKey] ?? isAwaitingApproval;

    // Track previous values to detect actual changes vs re-mounts
    const prevAwaitingRef = useRef(isAwaitingApproval);
    const hasInitializedRef = useRef(false);

    // Sync isExpanded with isAwaitingApproval, but avoid resetting on re-mount
    useEffect(() => {
        if (!hasInitializedRef.current) {
            hasInitializedRef.current = true;
            // On first mount, only set if there's no existing state (preserves state from other pane)
            if (!hasExistingState) {
                setExpanded({ key: expansionKey, expanded: isAwaitingApproval });
            }
            return;
        }
        
        // After first mount, sync when isAwaitingApproval actually changes
        if (prevAwaitingRef.current !== isAwaitingApproval) {
            setExpanded({ key: expansionKey, expanded: isAwaitingApproval });
        }
        prevAwaitingRef.current = isAwaitingApproval;
    }, [isAwaitingApproval, expansionKey, hasExistingState, setExpanded]);

    // Track when we're waiting for approval response from backend
    const [isProcessingApproval, setIsProcessingApproval] = useState(false);
    // Track when we're processing a post-run action (apply/undo/retry)
    const [isProcessingAction, setIsProcessingAction] = useState(false);
    // Track which specific button was clicked ('approve' | 'reject' | null)
    const [clickedButton, setClickedButton] = useState<'approve' | 'reject' | null>(null);
    // Track the action ID we're processing to detect status changes
    const processingActionIdRef = useRef<string | null>(null);

    // Get agent actions for this tool call
    const getAgentActionsByToolcall = useAtomValue(getAgentActionsByToolcallAtom);
    const actions = getAgentActionsByToolcall(toolcallId);
    
    // Determine if this is a multi-action tool call (create_items with multiple items)
    const isMultiAction = (toolName === 'create_items' || toolName === 'create_item') && actions.length > 1;
    
    // Primary action for backward compatibility (used for single-action tools)
    const action = actions.length > 0 ? actions[0] : null;

    // Atoms for state management
    const sendApprovalResponse = useSetAtom(sendApprovalResponseAtom);
    const removePendingApproval = useSetAtom(removePendingApprovalAtom);
    const ackAgentActions = useSetAtom(ackAgentActionsAtom);
    const rejectAgentAction = useSetAtom(rejectAgentActionAtom);
    const setAgentActionsToError = useSetAtom(setAgentActionsToErrorAtom);
    const undoAgentAction = useSetAtom(undoAgentActionAtom);
    const markExternalReferenceImported = useSetAtom(markExternalReferenceImportedAtom);

    // Item title state (shared across panes) - only for actions that have specific items
    const itemTitleMap = useAtomValue(agentActionItemTitlesAtom);
    const itemTitle = itemTitleMap[toolcallId] ?? null;
    const setItemTitle = useSetAtom(setAgentActionItemTitleAtom);

    // Determine if this action type has an associated item
    const hasAssociatedItem =
        toolName === 'edit_metadata' ||
        toolName === 'edit_item';

    // Fetch item title for actions that have specific items
    useEffect(() => {
        if (!hasAssociatedItem || itemTitle) return;

        const fetchTitle = async () => {
            // Get item info from action or pending approval
            const libraryId = action?.proposed_data?.library_id ?? pendingApproval?.actionData?.library_id;
            const zoteroKey = action?.proposed_data?.zotero_key ?? pendingApproval?.actionData?.zotero_key;
            
            if (!libraryId || !zoteroKey) return;
            
            const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, zoteroKey);
            if (item) {
                const title = await shortItemTitle(item);
                setItemTitle({ key: toolcallId, title });
            }
        };
        
        fetchTitle();
    }, [action, pendingApproval, itemTitle, toolcallId, hasAssociatedItem, setItemTitle]);

    // Clear processing state when action status changes from 'pending' to a final state
    useEffect(() => {
        if (isProcessingApproval && action && processingActionIdRef.current === action.id) {
            // If action status is no longer 'pending', the backend has processed the approval
            if (action.status !== 'pending') {
                setIsProcessingApproval(false);
                setClickedButton(null);
                processingActionIdRef.current = null;
            }
        }
    }, [isProcessingApproval, action?.status, action?.id]);

    const isProcessing = isProcessingApproval || isProcessingAction;
    // Show 'awaiting' if we have a pending approval OR if we're processing
    // For multi-action, compute overall status from all actions
    const status: ActionStatus | 'awaiting' = (isAwaitingApproval || isProcessing)
        ? 'awaiting' 
        : isMultiAction 
            ? getOverallStatus(actions)
            : (action?.status ?? 'pending');
    const config = STATUS_CONFIGS[status];

    // Handlers for awaiting approval (during agent run)
    const handleApprove = useCallback(() => {
        if (pendingApproval) {
            // Start processing state before sending response
            setIsProcessingApproval(true);
            setClickedButton('approve');
            processingActionIdRef.current = pendingApproval.actionId;
            sendApprovalResponse({ actionId: pendingApproval.actionId, approved: true });
            removePendingApproval(pendingApproval.actionId);
        }
    }, [pendingApproval, sendApprovalResponse, removePendingApproval]);

    const handleReject = useCallback(() => {
        if (pendingApproval) {
            // Start processing state before sending response
            setIsProcessingApproval(true);
            setClickedButton('reject');
            processingActionIdRef.current = pendingApproval.actionId;
            sendApprovalResponse({ actionId: pendingApproval.actionId, approved: false });
            removePendingApproval(pendingApproval.actionId);
        }
    }, [pendingApproval, sendApprovalResponse, removePendingApproval]);

    // Handlers for post-run actions (after agent run is complete)
    const handleApplyPending = useCallback(async () => {
        if (actions.length === 0 || isProcessing) return;
        
        setIsProcessingAction(true);
        setClickedButton('approve');
        try {
            if (toolName === 'edit_metadata') {
                const result = await executeEditMetadataAction(action!);
                // Acknowledge the action as applied with result data
                await ackAgentActions(runId, [{
                    action_id: action!.id,
                    result_data: result,
                }]);
                logger(`AgentActionView: Applied edit_metadata action ${action!.id}`, 1);
            } else if (toolName === 'create_collection') {
                const result = await executeCreateCollectionAction(action!);
                // Acknowledge the action as applied with result data
                await ackAgentActions(runId, [{
                    action_id: action!.id,
                    result_data: result,
                }]);
                logger(`AgentActionView: Applied create_collection action ${action!.id}`, 1);
            } else if (toolName === 'organize_items') {
                const result = await executeOrganizeItemsAction(action!);
                // Acknowledge the action as applied with result data
                await ackAgentActions(runId, [{
                    action_id: action!.id,
                    result_data: result,
                }]);
                logger(`AgentActionView: Applied organize_items action ${action!.id}`, 1);
            } else if (toolName === 'create_items' || toolName === 'create_item') {
                // Handle batch operations for multiple items
                const actionsToApply = actions.filter(a => a.status !== 'applied');
                if (actionsToApply.length === 0) return;
                
                const batchResult = await executeCreateItemActions(actionsToApply);
                
                // Acknowledge successful actions
                if (batchResult.successes.length > 0) {
                    await ackAgentActions(runId, batchResult.successes.map(s => ({
                        action_id: s.action.id,
                        result_data: s.result,
                    })));
                    logger(`AgentActionView: Applied ${batchResult.successes.length} create_item actions`, 1);
                    
                    // Update external reference mapping for imported items
                    for (const success of batchResult.successes) {
                        const proposedData = success.action.proposed_data as CreateItemProposedData;
                        if (proposedData?.item?.source_id) {
                            markExternalReferenceImported(proposedData.item.source_id, {
                                library_id: success.result.library_id,
                                zotero_key: success.result.zotero_key
                            });
                        }
                    }
                }
                
                // Set error status for failed actions
                if (batchResult.failures.length > 0) {
                    for (const failure of batchResult.failures) {
                        setAgentActionsToError([failure.action.id], failure.error);
                    }
                    logger(`AgentActionView: Failed to apply ${batchResult.failures.length} create_item actions`, 1);
                }
            }
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to apply action';
            logger(`AgentActionView: Failed to apply actions: ${errorMessage}`, 1);
            // Set error on all actions
            const actionIds = actions.map(a => a.id);
            setAgentActionsToError(actionIds, errorMessage);
        } finally {
            setIsProcessingAction(false);
            setClickedButton(null);
        }
    }, [action, actions, isProcessing, toolName, runId, ackAgentActions, setAgentActionsToError, markExternalReferenceImported]);

    const handleRejectPending = useCallback(() => {
        if (actions.length === 0 || isProcessing) return;
        
        setClickedButton('reject');
        // For multi-action, reject all actions
        if (isMultiAction) {
            for (const act of actions) {
                rejectAgentAction(act.id);
            }
            logger(`AgentActionView: Rejected ${actions.length} create_item actions`, 1);
        } else {
            rejectAgentAction(action!.id);
        }
        // Reset clicked button state after a short delay (rejection is synchronous)
        setTimeout(() => setClickedButton(null), 100);
    }, [action, actions, isProcessing, isMultiAction, rejectAgentAction]);

    const handleUndo = useCallback(async () => {
        if (!action || isProcessing) return;
        
        setIsProcessingAction(true);
        try {
            if (toolName === 'edit_metadata') {
                // First pass: check what needs to be reverted without forcing
                let result: UndoResult = await undoEditMetadataAction(action, false);
                
                // If some fields were manually modified, ask for confirmation
                if (result.needsConfirmation && result.manuallyModified.length > 0) {
                    const shouldOverwrite = confirmOverwriteManualChanges(result.manuallyModified);
                    
                    if (shouldOverwrite) {
                        // User confirmed: force revert all fields
                        result = await undoEditMetadataAction(action, true);
                        logger(`AgentActionView: Force-reverted ${result.fieldsReverted} fields after user confirmation`, 1);
                    } else {
                        // User declined: the first pass already reverted non-modified fields
                        logger(`AgentActionView: User declined to overwrite ${result.manuallyModified.length} manually modified fields`, 1);
                    }
                }
                
                // Log edge cases
                if (result.alreadyReverted.length > 0) {
                    logger(`AgentActionView: Fields already at original value: ${result.alreadyReverted.join(', ')}`, 1);
                }
                
                // Update action status to 'undone'
                // Even if some fields were manually modified and user declined,
                // we consider the AI's changes undone (user has taken control)
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
            } else if (toolName === 'create_items' || toolName === 'create_item') {
                // Handle batch undo for multiple items
                const actionsToUndo = actions.filter(a => a.status === 'applied');
                if (actionsToUndo.length === 0) return;
                
                const batchResult = await undoCreateItemActions(actionsToUndo);
                
                // Mark successfully undone actions
                for (const actionId of batchResult.successes) {
                    undoAgentAction(actionId);
                }
                
                // Set error status for failed actions
                for (const failure of batchResult.failures) {
                    setAgentActionsToError([failure.actionId], failure.error);
                }
                
                logger(`AgentActionView: Undone ${batchResult.successes.length} create_item actions`, 1);
                if (batchResult.failures.length > 0) {
                    logger(`AgentActionView: Failed to undo ${batchResult.failures.length} create_item actions`, 1);
                }
            }
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to undo action';
            logger(`AgentActionView: Failed to undo actions: ${errorMessage}`, 1);
            // Set error on all applied actions
            const appliedActionIds = actions.filter(a => a.status === 'applied').map(a => a.id);
            if (appliedActionIds.length > 0) {
                setAgentActionsToError(appliedActionIds, errorMessage);
            }
        } finally {
            setIsProcessingAction(false);
        }
    }, [action, actions, isProcessing, toolName, undoAgentAction, setAgentActionsToError]);

    const handleRetry = useCallback(async () => {
        // Retry is the same as apply for pending/error/undone/rejected actions
        await handleApplyPending();
    }, [handleApplyPending]);

    const toggleExpanded = () => setExpanded({ key: expansionKey, expanded: !isExpanded });

    // Build preview data from either pending approval or agent action
    const previewData = buildPreviewData(toolName, pendingApproval, action);

    // Determine what icon to show in header
    const getHeaderIcon = () => {
        const getToolIcon = () => {
            if (toolName === 'edit_metadata') return PropertyEditIcon;
            if (toolName === 'edit_item') return PropertyEditIcon;
            if (toolName === 'create_collection') return FolderAddIcon;
            if (toolName === 'organize_items') return TaskDoneIcon;
            if (toolName === 'create_items' || toolName === 'create_item') return DocumentValidationIcon;
            return ClockIcon;
        };
        if (isAwaitingApproval) return getToolIcon();
        if (isHovered && isExpanded) return ArrowDownIcon;
        if (isHovered && !isExpanded) return ArrowRightIcon;
        if (config.icon === null) return getToolIcon();
        return config.icon;
    };
    
    // Determine whether to show status icon styling
    const shouldShowStatusIcon = () => {
        // Don't show status styling if we're showing arrows on hover
        if (isHovered) return false;
        // Show status styling if we have a status icon
        return config.icon !== null || !isAwaitingApproval;
    };

    const actionTitle = getActionTitle(toolName, action?.proposed_data, itemTitle, actions);

    return (
        <div className="agent-action-view rounded-md flex flex-col min-w-0 border-popup mb-2">
            {/* Header */}
            <div
                className={`
                    display-flex flex-row py-15 bg-senary items-start
                    ${isExpanded ? 'border-bottom-quinary' : ''}
                `}
            >
                <button
                    type="button"
                    className={`
                        variant-ghost-secondary display-flex flex-row py-15 gap-2 text-left
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
                        <div className={`flex-1 display-flex mt-010 font-color-primary`}>
                            <Icon icon={getHeaderIcon()} className={shouldShowStatusIcon() ? config.iconClassName : undefined} />
                        </div>
                        <div 
                            className="flex-wrap"
                            style={{
                                display: '-webkit-box',
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: 'vertical',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                wordBreak: 'break-word'
                            }}
                        >
                            <span className="font-color-primary font-medium">{getActionLabel(toolName)}</span>
                            {actionTitle && <span className="font-color-secondary ml-15">{actionTitle}</span>}
                        </div>
                    </div>
                    
                </button>
            
                {/* Reveal button */}
                {action?.proposed_data?.library_id && action?.proposed_data?.zotero_key && (
                    <Tooltip content='Reveal in Zotero' singleLine>
                        <IconButton
                            variant="ghost-secondary"
                            icon={ArrowUpRightIcon}
                            className="font-color-secondary ml-2 mt-015 scale-11"
                            onClick={() => revealSource({ library_id: action?.proposed_data?.library_id, zotero_key: action?.proposed_data?.zotero_key })}
                        />
                    </Tooltip>
                )}

                <div className="flex-1" />

                {/* Reject and Apply buttons */}
                {(isAwaitingApproval || status === 'pending') && (
                    <div className="display-flex flex-row items-center gap-25 mr-3 mt-015">
                        {/* Show Reject button only if not processing or if Reject was clicked */}
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
                        {/* Show Apply button only if not processing or if Apply was clicked */}
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

                {!(isAwaitingApproval || status === 'pending') && (
                    <div className="display-flex flex-row items-center gap-25 mr-2 mt-015">
                        <Tooltip content="Expand" showArrow singleLine>
                            <IconButton
                                icon={ChevronIcon}
                                variant="ghost-secondary"
                                iconClassName="scale-12"
                                onClick={toggleExpanded}
                            />
                        </Tooltip>
                    </div>
                )}



            </div>

            {/* Expanded content */}
            {isExpanded && (
                <div className="display-flex flex-col">
                    {/* Preview section */}
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

                    {/* Action buttons */}
                    <div className="display-flex flex-row gap-1 px-2 py-2 mt-1">
                        {/* Preference for applying agent actions */}
                        <DeferredToolPreferenceButton toolName={toolName} />
                        <div className="flex-1" />
                        
                        {/* Processing indicator - shown while waiting for backend response */}
                        {/* {isProcessingApproval && (
                            <div className="display-flex items-center px-3 py-1 text-sm font-color-secondary">
                                <Icon icon={Spinner} className="mr-2" />
                                Processing...
                            </div>
                        )} */}

                        {/* Reject button - for awaiting and pending */}
                        {config.showReject && (!isProcessing || clickedButton === 'reject') && (
                            <Button
                                variant="ghost-secondary"
                                onClick={isAwaitingApproval ? handleReject : handleRejectPending}
                                loading={isProcessing && clickedButton === 'reject'}
                                disabled={isProcessing}
                            >
                                Reject
                            </Button>
                        )}

                        {/* Undo button - for applied */}
                        {config.showUndo && (
                            <Button
                                variant="ghost-secondary"
                                onClick={handleUndo}
                                loading={isProcessing}
                            >
                                Undo
                            </Button>
                        )}

                        {/* Retry button - for error */}
                        {config.showRetry && (
                            <Button
                                variant="outline"
                                icon={RepeatIcon}
                                onClick={handleRetry}
                                loading={isProcessing}
                            >
                                Try Again
                            </Button>
                        )}

                        {/* Apply button - for awaiting, pending, rejected, undone (not while processing) */}
                        {config.showApply && (!isProcessing || clickedButton === 'approve') && (
                            <Button
                                variant={isAwaitingApproval ? 'solid' : 'ghost-secondary'}
                                onClick={isAwaitingApproval ? handleApprove : handleApplyPending}
                                loading={isProcessing && clickedButton === 'approve'}
                                disabled={isProcessing}
                            >
                                <span>Apply
                                    {/* {isAwaitingApproval && <span className="opacity-50 ml-1">⏎</span>} */}
                                </span>
                            </Button>
                        )}

                        {/* Applied badge - for applied state */}
                        {/* {status === 'applied' && (
                            <div className="display-flex items-center px-3 py-1 rounded bg-success-subtle color-success text-sm">
                                <Icon icon={TickIcon} className="mr-1 scale-12" />
                                Success
                            </div>
                        )} */}
                    </div>
                </div>
            )}
        </div>
    );
};

/**
 * Get human-readable label for the action
 */
function getActionLabel(toolName: string): string {
    switch (toolName) {
        case 'edit_metadata':
        case 'edit_item':
            return 'Edit';
        case 'create_item':
        case 'create_items':
            return 'Import';
        case 'create_collection':
            return 'Create';
        case 'organize_items':
            return 'Organize';
        default:
            return toolName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
}

function getActionTitle(
    toolName: string,
    actionData: Record<string, any> | undefined,
    itemTitle: string | null,
    actions: AgentAction[] | undefined
): string | null {
    switch (toolName) {
        case 'edit_metadata':
        case 'edit_item':
            return itemTitle ? itemTitle : null;
        case 'create_collection':
            return actionData?.name ?? actionData?.proposed_data?.name ?? null;
        case 'organize_items': {
            const itemCount = actionData?.item_ids?.length ?? 0;
            if (itemCount === 0) return null;
            return itemCount === 1 && itemTitle
                ? itemTitle
                : `${itemCount} item${itemCount !== 1 ? 's' : ''}`;
        }
        case 'create_item':
        case 'create_items': {
            // For create_item, get title from the item data
            // Check actions first, then fall back to actionData (for pending approvals where actions may be empty)
            if (actions && actions.length === 1) {
                const item = actions[0].proposed_data?.item ?? actionData?.item;
                if (item?.title) {
                    return truncateText(item.title, 70);
                }
            } else if ((!actions || actions.length === 0) && actionData?.item?.title) {
                // Pending approval case: actions not yet stored, but we have item data
                return truncateText(actionData.item.title, 60);
            }
            return `${actions && actions.length > 1 ? `${actions.length} ` : ''}Item${actions && actions.length > 1 ? 's' : ''}`;
        }
        default:
            return null;
    }
}

/**
 * Build preview data from either pending approval or agent action
 */
interface PreviewData {
    actionType: string;
    actionData: Record<string, any>;
    currentValue?: any;
    resultData?: Record<string, any>;
}

function buildPreviewData(
    toolName: string,
    pendingApproval: PendingApproval | null,
    action: AgentAction | null
): PreviewData | null {
    if (pendingApproval) {
        return {
            actionType: pendingApproval.actionType,
            actionData: pendingApproval.actionData,
            currentValue: pendingApproval.currentValue,
        };
    }
    
    if (action) {
        return {
            actionType: action.action_type,
            actionData: action.proposed_data,
            currentValue: undefined, // We don't have this for stored actions
            resultData: action.result_data,
        };
    }
    
    return null;
}

/**
 * Dispatches to action-specific preview components
 */
const ActionPreview: React.FC<{
    toolName: string;
    previewData: PreviewData;
    status: ActionStatus | 'awaiting';
    /** All actions for the tool call (for multi-item create_items) */
    actions?: AgentAction[];
}> = ({ toolName, previewData, status, actions }) => {
    if (toolName === 'edit_metadata' || previewData.actionType === 'edit_metadata') {
        const edits = previewData.actionData.edits || [];
        
        // Get current values from previewData.currentValue (pending approval)
        // or extract from edits[].old_value (stored actions)
        let currentValues = previewData.currentValue || {};
        if (Object.keys(currentValues).length === 0 && edits.length > 0) {
            currentValues = {};
            for (const edit of edits) {
                if (edit.old_value !== undefined) {
                    currentValues[edit.field] = edit.old_value;
                }
            }
        }
        
        // For applied actions, show the applied values if available
        const appliedEdits = previewData.resultData?.applied_edits;
        
        return (
            <EditMetadataPreview
                edits={edits}
                currentValues={currentValues}
                appliedEdits={appliedEdits}
                status={status}
            />
        );
    }

    if (toolName === 'create_collection' || previewData.actionType === 'create_collection') {
        const name = previewData.actionData.name || '';
        const parentKey = previewData.actionData.parent_key;
        const itemIds = previewData.actionData.item_ids || [];
        
        // Get library name and item count from current_value
        const libraryName = previewData.currentValue?.library_name;
        const itemCount = previewData.currentValue?.item_count ?? itemIds.length;
        
        return (
            <CreateCollectionPreview
                name={name}
                libraryName={libraryName}
                parentKey={parentKey}
                itemCount={itemCount}
                status={status}
                resultData={previewData.resultData}
            />
        );
    }

    if (toolName === 'organize_items' || previewData.actionType === 'organize_items') {
        const itemIds = previewData.actionData.item_ids || [];
        const tags = previewData.actionData.tags;
        const collections = previewData.actionData.collections;
        
        return (
            <OrganizeItemsPreview
                itemIds={itemIds}
                tags={tags}
                collections={collections}
                status={status}
                resultData={previewData.resultData as OrganizeItemsResultData | undefined}
            />
        );
    }

    if (toolName === 'create_items' || toolName === 'create_item' || previewData.actionType === 'create_item') {
        // If no actions array provided, return fallback
        if (!actions || actions.length === 0) {
            return (
                <div className="text-sm font-color-secondary px-3 py-2">
                    No item data available
                </div>
            );
        }
        
        return (
            <CreateItemsPreview
                actions={actions}
                status={status}
            />
        );
    }

    // Fallback for unsupported action types
    return (
        <div className="text-sm font-color-secondary">
            <div className="font-medium mb-1">Action: {previewData.actionType}</div>
            <pre className="text-xs overflow-auto max-h-32 p-2 rounded">
                {JSON.stringify(previewData.actionData, null, 2)}
            </pre>
        </div>
    );
};

export default AgentActionView;
