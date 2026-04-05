import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    AgentAction,
    PendingApproval,
    getAgentActionsByToolcallAtom,
    pendingApprovalsAtom,
    removePendingApprovalAtom,
    undoAgentActionAtom,
    ackAgentActionsAtom,
    rejectAgentActionAtom,
    setAgentActionsToErrorAtom,
} from '../../agents/agentActions';
import { sendApprovalResponseAtom, isWSChatPendingAtom } from '../../atoms/agentRunAtoms';
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
import { ConfirmExtractionPreview } from './ConfirmExtractionPreview';
import { ConfirmExternalSearchPreview } from './ConfirmExternalSearchPreview';
import { EditNotePreview } from './EditNotePreview';
import { executeEditMetadataAction, undoEditMetadataAction, UndoResult } from '../../utils/editMetadataActions';
import { executeCreateCollectionAction, undoCreateCollectionAction } from '../../utils/createCollectionActions';
import { executeOrganizeItemsAction, undoOrganizeItemsAction } from '../../utils/organizeItemsActions';
import { executeCreateItemActions, undoCreateItemActions } from '../../utils/createItemActions';
import { executeEditNoteAction, undoEditNoteAction } from '../../utils/editNoteActions';
import { executeCreateNoteAction, undoCreateNoteAction } from '../../utils/createNoteActions';
import type { CreateItemProposedData } from '../../types/agentActions/items';
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
    EditIcon,
    DocumentValidationIcon,
    DollarCircleIcon,
    GlobalSearchIcon,
    FileDiffIcon,
} from '../icons/icons';
import { revealSource, openNoteAndSearchEdit, openNoteByKey } from '../../utils/sourceUtils';
import { isNoteOpenInEditor, showDiffPreview, dismissDiffPreview, isDiffPreviewActive } from '../../utils/noteEditorDiffPreview';
import { updateDiffPreviewForNote, DIFF_PREVIEW_ENABLED, diffPreviewNoteKeyAtom } from '../../utils/diffPreviewCoordinator';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';
import DeferredToolPreferenceButton from '../ui/buttons/DeferredToolPreferenceButton';
import ExtractionApprovalButton from '../ui/buttons/ExtractionApprovalButton';
import ExternalSearchApprovalButton from '../ui/buttons/ExternalSearchApprovalButton';
import SplitApplyButton from '../ui/buttons/SplitApplyButton';
import { truncateText } from '../../utils/stringUtils';
import { store } from '../../store';
import { markExternalReferenceImportedAtom, markExternalReferenceDeletedAtom } from '../../atoms/externalReferences';
import {
    addAutoApproveNoteKeyAtom,
    makeNoteKey,
} from '../../atoms/editNoteAutoApprove';

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
    /** Index of the parent response message within the run (disambiguates duplicate tool_call_ids) */
    responseIndex: number;
    /** Pending approval request if awaiting user decision */
    pendingApproval: PendingApproval | null;
    /** Whether a tool-return has been received for this tool call (backend completed processing) */
    hasToolReturn?: boolean;
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
    responseIndex,
    pendingApproval: pendingApprovalProp,
    hasToolReturn = false,
}) => {
    const [isHovered, setIsHovered] = useState(false);

    // Get agent actions for this tool call, scoped to this run
    // (tool_call_ids can collide across runs, so we filter by run_id)
    const getAgentActionsByToolcall = useAtomValue(getAgentActionsByToolcallAtom);
    const actions = getAgentActionsByToolcall(toolcallId, a => a.run_id === runId);

    // Primary action for backward compatibility (used for single-action tools)
    const action = actions.length > 0 ? actions[0] : null;

    // Guard against cross-run tool_call_id collision:
    // If this run already has an action in a final state (applied/rejected/undone/error),
    // ignore any pending approval (it belongs to a different run with the same tool_call_id)
    const actionInFinalState = action && action.status !== 'pending';
    const pendingApproval = actionInFinalState ? null : pendingApprovalProp;
    const isAwaitingApproval = pendingApproval !== null;

    // Use global Jotai atom for expansion state (persists across re-renders and syncs between panes)
    // Include responseIndex to disambiguate duplicate tool_call_ids within the same run
    // (some providers reuse tool_call_ids across responses, e.g., when retrying failed calls)
    const expansionKey = `${runId}:${responseIndex}:${toolcallId}`;
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
    // Track whether the last error came from an undo attempt (so retry calls undo, not apply)
    const [isUndoError, setIsUndoError] = useState(false);
    // Inline undo error for edit_note: keeps action in 'applied' state with a warning banner
    const [undoError, setUndoError] = useState<string | null>(null);
    // Track when approval was removed externally (e.g., via PendingActionsBar "Apply All")
    const [isExternallyProcessing, setIsExternallyProcessing] = useState(false);
    // Track which specific button was clicked ('approve' | 'reject' | null)
    const [clickedButton, setClickedButton] = useState<'approve' | 'reject' | null>(null);
    // Track the action ID we're processing to detect status changes
    const processingActionIdRef = useRef<string | null>(null);
    // Track previous pending approval to detect external removals
    const prevPendingApprovalRef = useRef<PendingApproval | null>(pendingApproval);

    // Track if the run is still pending (needed to detect cancel vs external approval)
    const isRunPending = useAtomValue(isWSChatPendingAtom);

    // Determine if this is a multi-action tool call (create_items with multiple items)
    const isMultiAction = (toolName === 'create_items' || toolName === 'create_item') && actions.length > 1;

    // Atoms for state management
    const sendApprovalResponse = useSetAtom(sendApprovalResponseAtom);
    const removePendingApproval = useSetAtom(removePendingApprovalAtom);
    const ackAgentActions = useSetAtom(ackAgentActionsAtom);
    const rejectAgentAction = useSetAtom(rejectAgentActionAtom);
    const setAgentActionsToError = useSetAtom(setAgentActionsToErrorAtom);
    const undoAgentAction = useSetAtom(undoAgentActionAtom);
    const markExternalReferenceImported = useSetAtom(markExternalReferenceImportedAtom);
    const markExternalReferenceDeleted = useSetAtom(markExternalReferenceDeletedAtom);
    const addAutoApproveNoteKey = useSetAtom(addAutoApproveNoteKeyAtom);
    const allPendingApprovals = useAtomValue(pendingApprovalsAtom);

    // Item title state (shared across panes) - only for actions that have specific items
    // Use composite key with responseIndex to disambiguate duplicate tool_call_ids
    const itemTitleKey = `${responseIndex}:${toolcallId}`;
    const itemTitleMap = useAtomValue(agentActionItemTitlesAtom);
    const itemTitle = itemTitleMap[itemTitleKey] ?? null;
    const setItemTitle = useSetAtom(setAgentActionItemTitleAtom);

    // Determine if this action type has an associated item
    const hasAssociatedItem =
        toolName === 'edit_metadata' ||
        toolName === 'edit_item' ||
        toolName === 'edit_note';

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
                let title: string;
                if (toolName === 'edit_note' && item.isNote?.()) {
                    title = item.getNoteTitle?.() || '(untitled)';
                } else {
                    title = await shortItemTitle(item);
                }
                setItemTitle({ key: itemTitleKey, title });
            }
        };
        
        fetchTitle();
    }, [action, pendingApproval, itemTitle, itemTitleKey, hasAssociatedItem, toolName, setItemTitle]);

    // Detect when pending approval is removed externally (e.g., via PendingActionsBar "Apply All")
    useEffect(() => {
        const wasAwaiting = prevPendingApprovalRef.current !== null;
        const isNoLongerAwaiting = pendingApproval === null;

        // If approval was just removed externally (not by our local handleApprove/handleReject)
        // AND the run is still pending (not canceled via Stop button)
        // AND no tool-return has arrived yet (if it has, the backend already completed this tool
        // call — e.g., approval timeout — so no spinner is needed)
        if (wasAwaiting && isNoLongerAwaiting && !isProcessingApproval && isRunPending && !hasToolReturn) {
            setIsExternallyProcessing(true);
            // Set clickedButton to 'approve' to show the loading state on the right button
            // We assume external removal is approval (reject would also work but approve is more common)
            setClickedButton('approve');
        }

        prevPendingApprovalRef.current = pendingApproval;
    }, [pendingApproval, isProcessingApproval, isRunPending, hasToolReturn]);

    // Clear processing state when:
    // 1. Action status changes from 'pending' to a final state (normal approval flow)
    // 2. Tool-return arrives while externally processing (backend completed — e.g., timeout)
    // 3. Run is no longer pending (canceled/completed/errored — same pattern as
    //    ToolCallPartView's isInProgress + runStatus guard)
    useEffect(() => {
        if ((isProcessingApproval || isExternallyProcessing) && action) {
            if (action.status !== 'pending') {
                setIsProcessingApproval(false);
                setIsExternallyProcessing(false);
                setClickedButton(null);
                processingActionIdRef.current = null;
            }
        }
        if (isExternallyProcessing && (hasToolReturn || !isRunPending)) {
            setIsExternallyProcessing(false);
            setClickedButton(null);
        }
    }, [isProcessingApproval, isExternallyProcessing, action?.status, action?.id, hasToolReturn, isRunPending]);

    const isProcessing = isProcessingApproval || isProcessingAction || isExternallyProcessing;
    // Show 'awaiting' if we have a pending approval OR if we're processing
    // For multi-action, compute overall status from all actions
    const status: ActionStatus | 'awaiting' = (isAwaitingApproval || isProcessing)
        ? 'awaiting' 
        : isMultiAction 
            ? getOverallStatus(actions)
            : (action?.status ?? 'pending');
    // For confirmation actions, hide post-run Apply/Undo/Reject/Retry — only approval during awaiting is meaningful
    const isConfirmExtraction = toolName === 'confirm_extraction';
    const isConfirmExternalSearch = toolName === 'confirm_external_search';
    const isConfirmAction = isConfirmExtraction || isConfirmExternalSearch;
    const baseConfig = STATUS_CONFIGS[status];
    const config = (isConfirmAction && status !== 'awaiting')
        ? { ...baseConfig, showApply: false, showReject: false, showUndo: false, showRetry: false }
        : baseConfig;

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

    // Handler: opt-in to auto-approve all edit_note calls for this note in this run
    const handleApproveAllForNote = useCallback(() => {
        if (!pendingApproval) return;
        const { library_id, zotero_key } = pendingApproval.actionData || {};
        if (library_id != null && zotero_key) {
            const noteKey = makeNoteKey(library_id, zotero_key);
            addAutoApproveNoteKey(noteKey);

            // Auto-approve any other already-pending approvals for the same note
            for (const [, pa] of allPendingApprovals) {
                if (pa.actionId === pendingApproval.actionId) continue;
                if (pa.actionType !== 'edit_note') continue;
                const paLib = pa.actionData?.library_id;
                const paKey = pa.actionData?.zotero_key;
                if (paLib != null && paKey && makeNoteKey(paLib, paKey) === noteKey) {
                    sendApprovalResponse({ actionId: pa.actionId, approved: true });
                    removePendingApproval(pa.actionId);
                }
            }
        }
        // Approve the current action via the normal path
        handleApprove();
    }, [pendingApproval, allPendingApprovals, addAutoApproveNoteKey, sendApprovalResponse, removePendingApproval, handleApprove]);

    // Handlers for post-run actions (after agent run is complete)
    const handleApplyPending = useCallback(async () => {
        if (actions.length === 0 || isProcessing) return;

        setIsUndoError(false);
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
            } else if (toolName === 'edit_note') {
                // Dismiss any active diff preview before applying — the preview
                // freezes the editor (_disableSaving + contentEditable=false), so
                // it must be torn down for the edit to save and PM to normalize.
                // Await so _disableSaving is fully restored before we proceed.
                if (isDiffPreviewActive()) {
                    await dismissDiffPreview();
                    store.set(diffPreviewNoteKeyAtom, null);
                }
                const result = await executeEditNoteAction(action!);
                await ackAgentActions(runId, [{
                    action_id: action!.id,
                    result_data: result,
                }]);
                logger(`AgentActionView: Applied edit_note action ${action!.id}`, 1);
            } else if (toolName === 'create_note') {
                const result = await executeCreateNoteAction(action!);
                await ackAgentActions(runId, [{
                    action_id: action!.id,
                    result_data: result,
                }]);
                logger(`AgentActionView: Applied create_note action ${action!.id}`, 1);
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
                        setAgentActionsToError([failure.action.id], failure.error, failure.errorDetails);
                    }
                    logger(`AgentActionView: Failed to apply ${batchResult.failures.length} create_item actions`, 1);
                }
            }
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to apply action';
            const stackTrace = error?.stack || '';
            logger(`AgentActionView: Failed to apply actions: ${errorMessage}\nStack trace:\n${stackTrace}`, 1);
            // Set error on all actions
            const actionIds = actions.map(a => a.id);
            setAgentActionsToError(actionIds, errorMessage, {
                stack_trace: stackTrace,
                error_name: error?.name,
            });
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

        setUndoError(null);
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
            } else if (toolName === 'edit_note') {
                // Dismiss any active diff preview before undoing — same reason as apply.
                if (isDiffPreviewActive()) {
                    await dismissDiffPreview();
                    store.set(diffPreviewNoteKeyAtom, null);
                }
                await undoEditNoteAction(action);
                undoAgentAction(action.id);
                logger(`AgentActionView: Undone edit_note action ${action.id}`, 1);
            } else if (toolName === 'create_note') {
                await undoCreateNoteAction(action);
                undoAgentAction(action.id);
                logger(`AgentActionView: Undone create_note action ${action.id}`, 1);
            } else if (toolName === 'create_items' || toolName === 'create_item') {
                // Handle batch undo for multiple items
                const actionsToUndo = actions.filter(a => a.status === 'applied');
                if (actionsToUndo.length === 0) return;

                const batchResult = await undoCreateItemActions(actionsToUndo);
                
                // Mark successfully undone actions and clear external reference mapping
                for (const actionId of batchResult.successes) {
                    undoAgentAction(actionId);
                    const undoneAction = actionsToUndo.find(a => a.id === actionId);
                    if (undoneAction) {
                        const proposedData = undoneAction.proposed_data as CreateItemProposedData;
                        if (proposedData?.item?.source_id) {
                            markExternalReferenceDeleted(proposedData.item.source_id);
                        }
                    }
                }
                
                // Set error status for failed actions
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

            if (toolName === 'edit_note') {
                // For edit_note: keep action in 'applied' state, show inline error banner
                setUndoError(errorMessage);
            } else {
                // For other action types: set error status but track that it came from undo
                setIsUndoError(true);
                const appliedActionIds = actions.filter(a => a.status === 'applied').map(a => a.id);
                if (appliedActionIds.length > 0) {
                    setAgentActionsToError(appliedActionIds, errorMessage, {
                        stack_trace: stackTrace,
                        error_name: error?.name,
                    });
                }
            }
        } finally {
            setIsProcessingAction(false);
        }
    }, [action, actions, isProcessing, toolName, undoAgentAction, setAgentActionsToError, markExternalReferenceDeleted]);

    const handleRetry = useCallback(async () => {
        if (isUndoError) {
            // Error came from a failed undo — retry the undo, not re-apply
            setIsUndoError(false);
            await handleUndo();
        } else {
            // Error came from a failed apply — retry the apply
            await handleApplyPending();
        }
    }, [isUndoError, handleUndo, handleApplyPending]);

    // Handler: open the note in editor and show diff preview.
    // Always opens the note tab (focusing it if already open) and then
    // shows the preview. The preview auto-dismisses when the user leaves
    // the tab, so we must re-show it every time rather than short-circuiting.
    const handlePreviewInEditor = useCallback(async () => {
        const libraryId = pendingApproval?.actionData?.library_id ?? action?.proposed_data?.library_id;
        const zoteroKey = pendingApproval?.actionData?.zotero_key ?? action?.proposed_data?.zotero_key;
        logger(`[DiffPreview] handlePreviewInEditor called: libraryId=${libraryId}, zoteroKey=${zoteroKey}, hasPendingApproval=${!!pendingApproval}, hasAction=${!!action}, hasProposedData=${!!action?.proposed_data}`);
        if (libraryId == null || !zoteroKey) {
            logger(`[DiffPreview] Aborting: missing libraryId or zoteroKey`, 1);
            return;
        }

        // Open / focus the note tab
        logger(`[DiffPreview] Opening note tab for ${libraryId}/${zoteroKey}`);
        await openNoteByKey(libraryId, zoteroKey);

        // Wait for the editor instance to be available (needed for newly
        // opened tabs; no-op cost when the tab was already selected)
        const editorReady = await new Promise<boolean>((resolve) => {
            let attempts = 0;
            const check = () => {
                if (isNoteOpenInEditor(libraryId, zoteroKey)) {
                    resolve(true);
                } else if (++attempts > 25) {
                    resolve(false);
                } else {
                    setTimeout(check, 200);
                }
            };
            setTimeout(check, 300);
        });
        logger(`[DiffPreview] Editor ready: ${editorReady} for ${libraryId}/${zoteroKey}`);
        if (!editorReady) {
            logger(`[DiffPreview] Editor not available after polling — cannot show preview`, 1);
        }

        // During an active run, pending approvals live in the approval map —
        // updateDiffPreviewForNote reads that map and shows the combined diff.
        if (pendingApproval) {
            logger(`[DiffPreview] Delegating to updateDiffPreviewForNote (pending approval path)`);
            updateDiffPreviewForNote(libraryId, zoteroKey);
        } else if (action?.proposed_data) {
            // Post-run: the approval was already removed; build the edit from the action directly.
            const oldStr = action.proposed_data.old_string ?? '';
            const operation = action.proposed_data.operation ?? 'str_replace';
            const undoFullHtml = action.proposed_data.undo_full_html ?? action.result_data?.undo_full_html ?? '';
            logger(`[DiffPreview] Post-run path: operation=${operation}, oldStr length=${oldStr.length}, newStr length=${(action.proposed_data.new_string ?? '').length}, hasUndoFullHtml=${!!undoFullHtml}`);
            if (operation === 'rewrite' || oldStr) {
                logger(`[DiffPreview] Calling showDiffPreview (operation=${operation})`);
                showDiffPreview(libraryId, zoteroKey, [{
                    oldString: oldStr,
                    newString: action.proposed_data.new_string ?? '',
                    operation,
                }], {
                    onAction: (bannerAction) => {
                        if (bannerAction === 'approve') {
                            handleApplyPending();
                        } else {
                            handleRejectPending();
                        }
                    },
                });
            } else {
                logger(`[DiffPreview] Skipping showDiffPreview: oldStr is empty and not a rewrite (operation=${operation})`, 1);
            }
        } else {
            logger(`[DiffPreview] No pendingApproval and no action.proposed_data — nothing to preview`, 1);
        }
    }, [pendingApproval, action, handleApplyPending, handleRejectPending]);

    const toggleExpanded = () => setExpanded({ key: expansionKey, expanded: !isExpanded });

    // Build preview data from either pending approval or agent action
    const previewData = buildPreviewData(toolName, pendingApproval, action);

    // Show the preview button when there's an unapplied edit that has an old_string to preview or is a rewrite
    const canShowPreview = DIFF_PREVIEW_ENABLED
        && toolName === 'edit_note'
        && (isAwaitingApproval || status === 'pending' || status === 'rejected' || status === 'undone')
        && !!(pendingApproval?.actionData?.old_string || action?.proposed_data?.old_string
            || (pendingApproval?.actionData?.operation ?? 'str_replace') === 'rewrite'
            || (action?.proposed_data?.operation ?? 'str_replace') === 'rewrite');
    // Determine what icon to show in header
    const getHeaderIcon = () => {
        const getToolIcon = () => {
            if (toolName === 'edit_metadata') return PropertyEditIcon;
            if (toolName === 'edit_item') return PropertyEditIcon;
            if (toolName === 'edit_note') return EditIcon;
            if (toolName === 'create_note') return FileDiffIcon;
            if (toolName === 'create_collection') return FolderAddIcon;
            if (toolName === 'organize_items') return TaskDoneIcon;
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
                            {action?.proposed_data?.library_id && action?.proposed_data?.zotero_key && (<>{'\u00A0'}<Tooltip content={toolName === 'edit_note' || toolName === 'create_note' ? 'Open note' : 'Reveal in Zotero'} singleLine>
                                    <span
                                        className="font-color-secondary scale-11"
                                        style={{ display: 'inline-flex', verticalAlign: 'middle', cursor: 'pointer' }}
                                        role="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            e.preventDefault();
                                            if (toolName === 'create_note' && action?.status === 'applied' && action?.result_data?.library_id && action?.result_data?.zotero_key) {
                                                openNoteByKey(action.result_data.library_id, action.result_data.zotero_key);
                                            } else if (toolName === 'edit_note') {
                                                const isApplied = action?.status === 'applied';
                                                openNoteAndSearchEdit(
                                                    action?.proposed_data?.library_id,
                                                    action?.proposed_data?.zotero_key,
                                                    action?.proposed_data?.old_string || '',
                                                    action?.proposed_data?.new_string || '',
                                                    isApplied,
                                                    action?.result_data?.undo_before_context,
                                                    action?.result_data?.undo_after_context,
                                                    action?.proposed_data?.target_before_context,
                                                    action?.proposed_data?.target_after_context,
                                                );
                                            } else {
                                                revealSource({ library_id: action?.proposed_data?.library_id, zotero_key: action?.proposed_data?.zotero_key });
                                            }
                                        }}
                                    >
                                        <Icon icon={ArrowUpRightIcon} />
                                    </span>
                                </Tooltip></>
                            )}
                        </div>
                    </div>

                </button>

                <div className="flex-1" />

                <div 
                    className="display-flex flex-row items-center gap-25 mr-2 mt-015"
                    style={{ visibility: !(isAwaitingApproval || status === 'pending' || isProcessing) ? 'visible' : 'hidden' }}
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

                {/* Reject and Apply buttons - show during awaiting, pending, or processing */}
                {((isAwaitingApproval || status === 'pending') && !isProcessing && !isConfirmAction) && (
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

                    {/* Inline undo error banner for edit_note */}
                    {undoError && (
                        <div className="display-flex flex-row items-start gap-2 mx-3 mt-2 px-3 py-2 rounded-md bg-senary">
                            <div className="mt-010 flex-shrink-0">
                                <Icon icon={AlertIcon} className="font-color-secondary scale-90" />
                            </div>
                            <div className="text-sm font-color-secondary" style={{ lineHeight: '1.4' }}>
                                Could not undo automatically. The note may have been modified since this edit was applied. You can revert manually in the note editor.
                            </div>
                        </div>
                    )}

                    {/* Action buttons */}
                    <div className="display-flex flex-row gap-1 px-2 py-2 mt-1">
                        {isConfirmExtraction ? (
                            <ExtractionApprovalButton onAlwaysApprove={handleApprove} />
                        ) : isConfirmExternalSearch ? (
                            <ExternalSearchApprovalButton onAlwaysApprove={handleApprove} />
                        ) : (
                            <DeferredToolPreferenceButton toolName={toolName} />
                        )}
                        <div className="flex-1" />

                        {canShowPreview && (
                            <Button
                                variant="ghost"
                                rightIcon={FileDiffIcon}
                                onClick={handlePreviewInEditor}
                                style={{ padding: '3px 6px' }}
                            >
                                Preview
                            </Button>
                        )}

                        {/* Reject button - for awaiting and pending */}
                        {config.showReject && (!isProcessing || clickedButton === 'reject') && (
                            <Button
                                variant="ghost"
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

                        {/* Retry button - for error (label changes based on error source) */}
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

                        {/* Apply button - for awaiting, pending, rejected, undone (not while processing) */}
                        {config.showApply && (!isProcessing || clickedButton === 'approve') && (
                            toolName === 'edit_note' && isAwaitingApproval ? (
                                <SplitApplyButton
                                    onApply={handleApprove}
                                    onApplyAll={handleApproveAllForNote}
                                    loading={isProcessing && clickedButton === 'approve'}
                                    disabled={isProcessing}
                                />
                            ) : (
                                <Button
                                    variant={isAwaitingApproval ? 'solid' : 'ghost-secondary'}
                                    onClick={isAwaitingApproval ? handleApprove : handleApplyPending}
                                    loading={isProcessing && clickedButton === 'approve'}
                                    disabled={isProcessing}
                                >
                                    <span>
                                        {isConfirmAction ? 'Confirm' : 'Apply'}
                                    </span>
                                </Button>
                            )
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
        case 'edit_note':
            return 'Edit Note';
        case 'create_note':
            return 'Create Note';
        case 'create_item':
        case 'create_items':
            return 'Import';
        case 'create_collection':
            return 'Create';
        case 'organize_items':
            return 'Organize';
        case 'confirm_extraction':
            return 'Extract';
        case 'confirm_external_search':
            return 'Search';
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
        case 'edit_note':
            return itemTitle ? itemTitle : null;
        case 'create_note':
            return actionData?.title ?? null;
        case 'create_collection':
            return actionData?.name ?? actionData?.proposed_data?.name ?? null;
        case 'organize_items': {
            const itemCount = actionData?.item_ids?.length ?? 0;
            if (itemCount === 0) return null;
            return itemCount === 1 && itemTitle
                ? itemTitle
                : `${itemCount} item${itemCount !== 1 ? 's' : ''}`;
        }
        case 'confirm_extraction': {
            const count = actionData?.attachment_count ?? 0;
            return `Confirm ${count} Item Batch Processing`;
        }
        case 'confirm_external_search': {
            return 'Confirm External Search';
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

        // Creator data: old from resultData, proposed_data, or currentValue
        const oldCreators = previewData.resultData?.old_creators
            ?? previewData.actionData.old_creators
            ?? previewData.currentValue?.current_creators
            ?? null;
        const newCreators = previewData.resultData?.new_creators
            ?? previewData.actionData.creators
            ?? null;

        return (
            <EditMetadataPreview
                edits={edits}
                currentValues={currentValues}
                appliedEdits={appliedEdits}
                status={status}
                oldCreators={oldCreators}
                newCreators={newCreators}
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

    if (toolName === 'confirm_extraction' || previewData.actionType === 'confirm_extraction') {
        return (
            <ConfirmExtractionPreview
                attachmentCount={previewData.actionData.attachment_count ?? 0}
                extraCredits={previewData.actionData.extra_credits ?? 0}
                totalCredits={previewData.actionData.total_credits ?? 0}
                includedFree={previewData.actionData.included_free ?? 0}
                label={previewData.actionData.label}
                status={status}
            />
        );
    }

    if (toolName === 'confirm_external_search' || previewData.actionType === 'confirm_external_search') {
        return (
            <ConfirmExternalSearchPreview
                extraCredits={previewData.actionData.extra_credits ?? 0}
                totalCredits={previewData.actionData.total_credits ?? 0}
                label={previewData.actionData.label}
                status={status}
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

    if (toolName === 'edit_note' || previewData.actionType === 'edit_note') {
        const op = (previewData.actionData.operation ?? 'str_replace') as import('../../types/agentActions/editNote').EditNoteOperation;
        const isRewrite = op === 'rewrite';
        const oldString = isRewrite ? '' : (previewData.actionData.old_string || '');
        const newString = previewData.actionData.new_string || '';
        const occurrencesReplaced = previewData.resultData?.occurrences_replaced;
        const warnings = previewData.resultData?.warnings;
        // For rewrite, get old content from validation's current_value
        // or from undo_full_html in result_data (post-apply)
        const oldContent = isRewrite
            ? (previewData.currentValue?.old_content || previewData.resultData?.undo_full_html)
            : undefined;

        return (
            <EditNotePreview
                oldString={oldString}
                newString={newString}
                operation={op}
                oldContent={oldContent}
                occurrencesReplaced={occurrencesReplaced}
                warnings={warnings}
                status={status}
                libraryId={previewData.actionData.library_id}
                zoteroKey={previewData.actionData.zotero_key}
            />
        );
    }

    if (toolName === 'create_note' || previewData.actionType === 'create_note') {
        const noteTitle = previewData.actionData.title || '(untitled)';
        const noteContent = previewData.actionData.content || '';
        const libraryName = previewData.currentValue?.library_name;
        const parentKey = previewData.currentValue?.parent_key || previewData.actionData.parent_key || previewData.actionData.parent_item_id;
        const collectionKey = previewData.currentValue?.collection_key || previewData.actionData.collection_key;
        const resultData = previewData.resultData;

        // Show a simple preview of the note content
        const truncatedContent = noteContent.length > 300
            ? noteContent.substring(0, 300) + '...'
            : noteContent;

        return (
            <div className="text-sm px-3 py-2">
                <div className="font-color-primary font-medium mb-1">{noteTitle}</div>
                {libraryName && (
                    <div className="font-color-secondary text-xs mb-1">Library: {libraryName}</div>
                )}
                {parentKey && (
                    <div className="font-color-secondary text-xs mb-1">Child note of parent item</div>
                )}
                {collectionKey && (
                    <div className="font-color-secondary text-xs mb-1">Added to collection</div>
                )}
                <div
                    className="font-color-secondary text-xs mt-1 p-2 rounded overflow-auto"
                    style={{
                        maxHeight: '150px',
                        backgroundColor: 'var(--fill-quinary)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                    }}
                >
                    {truncatedContent}
                </div>
                {resultData?.zotero_key && status === 'applied' && (
                    <div
                        className="font-color-link text-xs mt-1 cursor-pointer"
                        onClick={() => {
                            const libId = resultData.library_id;
                            const key = resultData.zotero_key;
                            if (libId && key) {
                                openNoteByKey(libId, key);
                            }
                        }}
                    >
                        Open note
                    </div>
                )}
            </div>
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
