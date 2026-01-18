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
import { EditMetadataPreview } from './EditMetadataPreview';
import { executeEditMetadataAction, undoEditMetadataAction } from '../../utils/editMetadataActions';
import { logger } from '../../../src/utils/logger';
import {
    TickIcon,
    CancelIcon,
    CheckmarkCircleIcon,
    CancelCircleIcon,
    AlertCircleIcon,
    ClockIcon,
    Spinner,
    Icon,
    RepeatIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    PropertyEditIcon,
} from '../icons/icons';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error';

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
        iconClassName: 'color-success',
        showApply: false,
        showReject: false,
        showUndo: true,
        showRetry: false,
    },
    rejected: {
        icon: CancelCircleIcon,
        label: 'Rejected',
        iconClassName: 'color-error',
        showApply: true,
        showReject: false,
        showUndo: false,
        showRetry: false,
    },
    undone: {
        icon: CancelCircleIcon,
        label: 'Undone',
        iconClassName: 'font-color-secondary',
        showApply: true,
        showReject: false,
        showUndo: false,
        showRetry: false,
    },
    error: {
        icon: AlertCircleIcon,
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
    const [isExpanded, setIsExpanded] = useState(true);
    const [isHovered, setIsHovered] = useState(false);
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

    const isAwaitingApproval = pendingApproval !== null;
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
                await undoEditMetadataAction(action);
                // Update action status to 'undone'
                undoAgentAction(action.id);
                logger(`AgentActionView: Undone edit_metadata action ${action.id}`, 1);
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

    const toggleExpanded = () => setIsExpanded(!isExpanded);

    // Build preview data from either pending approval or agent action
    const previewData = buildPreviewData(toolName, pendingApproval, action);

    // Determine what icon to show in header
    const getHeaderIcon = () => {
        if (isAwaitingApproval) return toolName === 'edit_metadata' ? PropertyEditIcon : ClockIcon;
        if (isExpanded) return ArrowDownIcon;
        if (isHovered) return ArrowRightIcon;
        if (config.icon === null) return toolName === 'edit_metadata' ? PropertyEditIcon : ClockIcon;
        return config.icon;
    };

    return (
        <div className="agent-action-view rounded-md flex flex-col min-w-0 border-popup mb-2">
            {/* Header */}
            <div
                className={`
                    display-flex flex-row py-15 bg-senary
                    ${isExpanded ? 'border-bottom-quinary' : ''}
                `}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
            >
                <button
                    type="button"
                    className={`
                        variant-ghost-secondary display-flex flex-row py-15 gap-2 w-full text-left
                        ${isProcessing ? 'opacity-80' : ''}
                    `}
                    style={{ fontSize: '0.95rem', background: 'transparent', border: 0, padding: 0 }}
                    aria-expanded={isExpanded}
                    onClick={isProcessing ? () => {} : toggleExpanded}
                    disabled={isProcessing}
                >
                    <div className="display-flex flex-row px-3 gap-2">
                        <div className={`flex-1 display-flex mt-010 font-color-primary`}>
                            <Icon icon={getHeaderIcon()} className={!isExpanded && !isHovered ? config.iconClassName : undefined} />
                        </div>
                        <div className="display-flex font-color-primary">
                            {getActionLabel(toolName)}
                        </div>
                        <div className="font-color-tertiary">
                            {status}
                        </div>
                    </div>
                </button>
                {/* Item title */}
                <div className="display-flex flex-row items-center px-3 gap-2">
                    <ItemRef status={status} config={config} />
                </div>

                <div className="flex-1"/>
                {!isExpanded && (isAwaitingApproval || status === 'pending') && !isProcessing && (
                    <div className="display-flex flex-row items-center gap-3 mr-3">
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
            </div>

            {/* Expanded content */}
            {isExpanded && (
                <div className="display-flex flex-col">
                    {/* Preview section */}
                    {/* <div className="p-3"> */}
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
                    {/* </div> */}

                    {/* Action buttons */}
                    <div className="display-flex flex-row gap-1 px-25 py-2 mt-1">
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
                        {config.showApply && !isProcessing && (
                            <Button
                                variant="solid"
                                onClick={isAwaitingApproval ? handleApprove : handleApplyPending}
                            >
                                <span>Apply<span className="opacity-50 ml-1">⏎</span></span>
                            </Button>
                        )}

                        {/* Applied badge - for applied state */}
                        {status === 'applied' && (
                            <div className="display-flex items-center px-3 py-1 rounded bg-success-subtle color-success text-sm">
                                <Icon icon={TickIcon} className="mr-1 scale-12" />
                                Success
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

/**
 * Status badge component
 */
const ItemRef: React.FC<{ status: ActionStatus | 'awaiting'; config: StatusConfig }> = ({ status, config }) => {
    return null;
};

/**
 * Get human-readable label for the action
 */
function getActionLabel(toolName: string): string {
    switch (toolName) {
        case 'edit_metadata':
            return 'Edit Metadata';
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
        const currentValues = previewData.currentValue || {};
        
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
