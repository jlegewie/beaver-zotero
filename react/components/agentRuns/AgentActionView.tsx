import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    AgentAction,
    PendingApproval,
    getAgentActionsByToolcallAtom,
    clearPendingApprovalAtom,
    undoAgentActionAtom,
    ackAgentActionsAtom,
    rejectAgentActionAtom,
    setAgentActionsToErrorAtom,
} from '../../agents/agentActions';
import { sendApprovalResponseAtom } from '../../atoms/agentRunAtoms';
import {
    editMetadataItemTitlesAtom,
    setEditMetadataItemTitleAtom,
    toolExpandedAtom,
    setToolExpandedAtom,
} from '../../atoms/messageUIState';
import { EditMetadataPreview } from './EditMetadataPreview';
import { executeEditMetadataAction, undoEditMetadataAction, UndoResult } from '../../utils/editMetadataActions';
import { shortItemTitle } from '../../../src/utils/zoteroUtils';
import { logger } from '../../../src/utils/logger';
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
} from '../icons/icons';
import { revealSource } from '../../utils/sourceUtils';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';
import DeferredToolPreferenceButton from '../ui/buttons/DeferredToolPreferenceButton';

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
    // Track the action ID we're processing to detect status changes
    const processingActionIdRef = useRef<string | null>(null);

    // Get agent action for this tool call
    const getAgentActionsByToolcall = useAtomValue(getAgentActionsByToolcallAtom);
    const actions = getAgentActionsByToolcall(toolcallId);
    const action = actions.length > 0 ? actions[0] : null;

    // Atoms for state management
    const sendApprovalResponse = useSetAtom(sendApprovalResponseAtom);
    const clearPendingApproval = useSetAtom(clearPendingApprovalAtom);
    const ackAgentActions = useSetAtom(ackAgentActionsAtom);
    const rejectAgentAction = useSetAtom(rejectAgentActionAtom);
    const setAgentActionsToError = useSetAtom(setAgentActionsToErrorAtom);
    const undoAgentAction = useSetAtom(undoAgentActionAtom);

    // Item title state (shared across panes)
    const itemTitleMap = useAtomValue(editMetadataItemTitlesAtom);
    const itemTitle = itemTitleMap[toolcallId] ?? null;
    const setItemTitle = useSetAtom(setEditMetadataItemTitleAtom);

    // Fetch item title for edit_metadata actions
    useEffect(() => {
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
        
        if (!itemTitle && toolName === 'edit_metadata') {
            fetchTitle();
        }
    }, [action, pendingApproval, itemTitle, toolcallId, toolName, setItemTitle]);

    // Clear processing state when action status changes from 'pending' to a final state
    useEffect(() => {
        if (isProcessingApproval && action && processingActionIdRef.current === action.id) {
            // If action status is no longer 'pending', the backend has processed the approval
            if (action.status !== 'pending') {
                setIsProcessingApproval(false);
                processingActionIdRef.current = null;
            }
        }
    }, [isProcessingApproval, action?.status, action?.id]);

    const isProcessing = isProcessingApproval || isProcessingAction;
    // Show 'awaiting' if we have a pending approval OR if we're processing
    const status: ActionStatus | 'awaiting' = (isAwaitingApproval || isProcessing)
        ? 'awaiting' 
        : (action?.status ?? 'pending');
    const config = STATUS_CONFIGS[status];

    // Handlers for awaiting approval (during agent run)
    const handleApprove = useCallback(() => {
        if (pendingApproval) {
            // Start processing state before sending response
            setIsProcessingApproval(true);
            processingActionIdRef.current = pendingApproval.actionId;
            sendApprovalResponse({ actionId: pendingApproval.actionId, approved: true });
            clearPendingApproval();
        }
    }, [pendingApproval, sendApprovalResponse, clearPendingApproval]);

    const handleReject = useCallback(() => {
        if (pendingApproval) {
            // Start processing state before sending response
            setIsProcessingApproval(true);
            processingActionIdRef.current = pendingApproval.actionId;
            sendApprovalResponse({ actionId: pendingApproval.actionId, approved: false });
            clearPendingApproval();
        }
    }, [pendingApproval, sendApprovalResponse, clearPendingApproval]);

    // Handlers for post-run actions (after agent run is complete)
    const handleApplyPending = useCallback(async () => {
        if (!action || isProcessing) return;
        
        setIsProcessingAction(true);
        try {
            if (toolName === 'edit_metadata') {
                const result = await executeEditMetadataAction(action);
                // Acknowledge the action as applied with result data
                await ackAgentActions(runId, [{
                    action_id: action.id,
                    result_data: result,
                }]);
                logger(`AgentActionView: Applied edit_metadata action ${action.id}`, 1);
            }
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to apply action';
            logger(`AgentActionView: Failed to apply ${action.id}: ${errorMessage}`, 1);
            setAgentActionsToError([action.id], errorMessage);
        } finally {
            setIsProcessingAction(false);
        }
    }, [action, isProcessing, toolName, runId, ackAgentActions, setAgentActionsToError]);

    const handleRejectPending = useCallback(() => {
        if (!action || isProcessing) return;
        rejectAgentAction(action.id);
    }, [action, isProcessing, rejectAgentAction]);

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
            }
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to undo action';
            logger(`AgentActionView: Failed to undo ${action.id}: ${errorMessage}`, 1);
            setAgentActionsToError([action.id], errorMessage);
        } finally {
            setIsProcessingAction(false);
        }
    }, [action, isProcessing, toolName, undoAgentAction, setAgentActionsToError]);

    const handleRetry = useCallback(async () => {
        // Retry is the same as apply for pending/error/undone/rejected actions
        await handleApplyPending();
    }, [handleApplyPending]);

    const toggleExpanded = () => setExpanded({ key: expansionKey, expanded: !isExpanded });

    // Build preview data from either pending approval or agent action
    const previewData = buildPreviewData(toolName, pendingApproval, action);

    // Determine what icon to show in header
    const getHeaderIcon = () => {
        if (isAwaitingApproval) return toolName === 'edit_metadata' ? PropertyEditIcon : ClockIcon;
        if (isHovered && isExpanded) return ArrowDownIcon;
        if (isHovered && !isExpanded) return ArrowRightIcon;
        if (config.icon === null) return toolName === 'edit_metadata' ? PropertyEditIcon : ClockIcon;
        return config.icon;
    };
    
    // Determine whether to show status icon styling
    const shouldShowStatusIcon = () => {
        // Don't show status styling if we're showing arrows on hover
        if (isHovered) return false;
        // Show status styling if we have a status icon
        return config.icon !== null || !isAwaitingApproval;
    };

    return (
        <div className="agent-action-view rounded-md flex flex-col min-w-0 border-popup mb-2">
            {/* Header */}
            <div
                className={`
                    display-flex flex-row py-15 bg-senary
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
                        <div className="display-flex flex-row gap-1">
                            <div className="font-color-primary font-medium">{getActionLabel(toolName)}</div>
                            {itemTitle && <div className="font-color-secondary">{itemTitle}</div>}
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
                {(isAwaitingApproval || status === 'pending') && !isProcessing && (
                    <div className="display-flex flex-row items-center gap-25 mr-3 mt-015">
                        <Tooltip content="Reject" showArrow singleLine>
                            <IconButton
                                icon={CancelIcon}
                                variant="ghost-secondary"
                                iconClassName="font-color-red"
                                onClick={isAwaitingApproval ? handleReject : handleRejectPending}
                            />
                        </Tooltip>
                        <Tooltip content="Apply" showArrow singleLine>
                            <IconButton
                                icon={TickIcon}
                                variant="ghost-secondary"
                                iconClassName="font-color-green scale-14"
                                onClick={isAwaitingApproval ? handleApprove : handleApplyPending}
                            />
                        </Tooltip>
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
                        {isProcessingApproval && (
                            <div className="display-flex items-center px-3 py-1 text-sm font-color-secondary">
                                <Icon icon={Spinner} className="mr-2" />
                                Processing...
                            </div>
                        )}

                        {/* Reject button - for awaiting and pending (not while processing) */}
                        {config.showReject && !isProcessing && (
                            <Button
                                variant="ghost-secondary"
                                onClick={isAwaitingApproval ? handleReject : handleRejectPending}
                            >
                                Reject
                            </Button>
                        )}

                        {/* Undo button - for applied */}
                        {config.showUndo && !isProcessing && (
                            <Button
                                variant="ghost-secondary"
                                onClick={handleUndo}
                            >
                                Undo
                            </Button>
                        )}

                        {/* Retry button - for error */}
                        {config.showRetry && !isProcessing && (
                            <Button
                                variant="outline"
                                icon={RepeatIcon}
                                onClick={handleRetry}
                            >
                                Try Again
                            </Button>
                        )}

                        {/* Apply button - for awaiting, pending, rejected, undone (not while processing) */}
                        {config.showApply && (
                            <Button
                                variant={isAwaitingApproval ? 'solid' : 'ghost-secondary'}
                                // style={{ border: '1px solid transparent' }}
                                onClick={isAwaitingApproval ? handleApprove : handleApplyPending}
                            >
                                <span>Apply
                                    {isAwaitingApproval && <span className="opacity-50 ml-1">⏎</span>}
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
            return 'Edit';
        case 'create_item':
        case 'create_collection':
            return 'Create';
        default:
            return toolName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
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
}> = ({ toolName, previewData, status }) => {
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
