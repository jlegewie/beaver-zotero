import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentRunStatus, ToolCallPart } from '@beaver/agent-core/agents/types';
import {
    AgentAction,
    PendingApproval,
    agentActionsByToolcallAtom,
    pendingApprovalsAtom,
    removePendingApprovalAtom,
} from '../../../agents/agentActions';
import {
    approvalResponseIntentsAtom,
    isWSChatPendingAtom,
    removeApprovalResponseIntentAtom,
    sendApprovalResponseAtom,
} from '../../../atoms/agentRunAtoms';
import { getToolCallStatus, toolResultsMapAtom, type ToolCallStatus } from '@beaver/agent-core/run-state/atoms';
import { openNoteAndSearchEdit, openNoteByKey } from '../../../utils/sourceUtils';
import {
    isNoteOpenInEditor,
    showDiffPreview,
    type EditOperation,
} from '../../../utils/noteEditorDiffPreview';
import { isDiffPreviewLive } from '../../../utils/diffPreviewCoordinator';
import { logger } from '@beaver/agent-core/platform/logger';
import { PreviewData, STATUS_CONFIGS, buildPreviewData, hasFailedUndo } from './agentActionViewHelpers';
import { useApprovalRecovery } from './useApprovalRecovery';
import {
    applyAgentActionsAtom,
    inFlightAgentActionIdsAtom,
    rejectAgentActionsAtom,
    undoAgentActionsAtom,
} from '../agentActionExecution';
import {
    EditNoteDisplayStatus,
    EditNoteResolvedTarget,
    findPendingApprovalForToolcall,
    getEditNoteCallVariant,
    getEditNoteDisplayStatus,
    getEffectiveEditNotePendingApproval,
    isEditNoteOrphaned,
    isEditNoteStreamingPlaceholder,
    parseEditNoteToolCallArgs,
    resolveEditNoteTargetFromData,
    type EditNoteRowDescriptor,
} from '../../../components/agentRuns/editNoteShared';
import type { EditNoteOperation } from '@beaver/agent-core/types/agentActions/editNote';
import { dismissActiveEditNotePreview } from '../editNotePreviewLifecycle';

export { dismissActiveEditNotePreview } from '../editNotePreviewLifecycle';

/** Wire action_type for each note-edit call variant, for the streaming fallback. */
const STREAMING_ACTION_TYPE = {
    legacy: 'edit_note',
    batch: 'edit_note_batch',
    blocks: 'edit_note_blocks',
} as const;

async function waitForNoteEditorReady(libraryId: number, zoteroKey: string): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
        let attempts = 0;
        const check = () => {
            if (isNoteOpenInEditor(libraryId, zoteroKey)) {
                resolve(true);
                return;
            }
            if (++attempts > 25) {
                logger(
                    `waitForNoteEditorReady: timed out after ${attempts} attempts (~${300 + 25 * 200}ms) `
                    + `waiting for editor for ${libraryId}-${zoteroKey}`,
                    1,
                );
                resolve(false);
                return;
            }
            setTimeout(check, 200);
        };
        setTimeout(check, 300);
    });
}

export async function showEditNotePreviewForEdits(
    target: EditNoteResolvedTarget,
    edits: EditOperation[],
    onAction: (bannerAction: 'approve' | 'reject') => void,
): Promise<boolean> {
    if (!isDiffPreviewLive()) {
        logger(`showEditNotePreviewForEdits: diff preview not live (kill switch off or Zotero 7), aborting`, 1);
        return false;
    }
    await openNoteByKey(target.libraryId, target.zoteroKey);
    await waitForNoteEditorReady(target.libraryId, target.zoteroKey);
    return await showDiffPreview(target.libraryId, target.zoteroKey, edits, {
        onAction: (bannerAction) => {
            onAction(bannerAction === 'approve' ? 'approve' : 'reject');
        },
    });
}

/**
 * Per-toolcall derivations that are identical for every sibling row of one
 * edit_note_batch tool call. When a group has already computed these once, it
 * passes them here so each row bypasses the hook's own lookups (the actions
 * index and the linear pending-approvals scan) instead of repeating them N
 * times. Omitted by callers that render a toolcall in isolation, which then
 * fall back to the hook's internal derivation.
 */
export interface EditNotePrecomputed {
    actions: AgentAction[];
    pendingApproval: PendingApproval | null;
    toolCallStatus: ToolCallStatus;
}

interface UseEditNoteActionsOptions {
    part: ToolCallPart;
    runId: string;
    runStatus: AgentRunStatus;
    externalUndoError?: string | null;
    onUndoErrorChange?: (toolcallId: string, error: string | null) => void;
    precomputed?: EditNotePrecomputed;
}

export interface EditNoteRowState {
    actions: AgentAction[];
    previewData: PreviewData | null;
    previewStatus: EditNoteDisplayStatus;
    previewIsStreaming: boolean;
    isProcessing: boolean;
    isStreamingPlaceholder: boolean;
    config: typeof STATUS_CONFIGS.awaiting;
    clickedButton: 'approve' | 'reject' | 'undo' | 'retry' | null;
    displayedUndoError: string | null;
    showApply: boolean;
    showReject: boolean;
    showUndo: boolean;
    showRetry: boolean;
    showOpenNoteAction: boolean;
    openNoteTooltip: string;
    handleApprove: () => void;
    handleReject: () => void;
    handleApplyPending: () => Promise<void>;
    handleRejectPending: () => void;
    handleUndo: () => Promise<void>;
    handleRetry: () => Promise<void>;
    handleOpenNote: () => Promise<void>;
    handleOpenNoteForRow: (row: EditNoteRowDescriptor) => Promise<void>;
}

export function useEditNoteActions({
    part,
    runId,
    runStatus,
    externalUndoError = null,
    onUndoErrorChange,
    precomputed,
}: UseEditNoteActionsOptions): EditNoteRowState {
    const toolcallId = part.tool_call_id;

    const resultsMap = useAtomValue(toolResultsMapAtom);
    // Subscribe to the grouped-actions map (not the stable getter atom) so the
    // fallback path re-renders with fresh actions when an action changes.
    const actionsByToolcall = useAtomValue(agentActionsByToolcallAtom);
    const allPendingApprovals = useAtomValue(pendingApprovalsAtom);
    const approvalResponseIntents = useAtomValue(approvalResponseIntentsAtom);
    const sendApprovalResponse = useSetAtom(sendApprovalResponseAtom);
    const removeApprovalResponseIntent = useSetAtom(removeApprovalResponseIntentAtom);
    const removePendingApproval = useSetAtom(removePendingApprovalAtom);
    const rejectAgentActions = useSetAtom(rejectAgentActionsAtom);
    const applyAgentActions = useSetAtom(applyAgentActionsAtom);
    const undoAgentActions = useSetAtom(undoAgentActionsAtom);
    const inFlightActionIds = useAtomValue(inFlightAgentActionIdsAtom);
    const isRunPending = useAtomValue(isWSChatPendingAtom);

    const actions = precomputed?.actions
        ?? (actionsByToolcall.get(toolcallId) ?? []).filter((a) => a.run_id === runId);
    // A single tool call always produces exactly one AgentAction, even for an
    // edit_note_batch call (the whole batch is one action with an edits[]
    // array in proposed_data) — actions[0] is never ambiguous here.
    const action = actions.length > 0 ? actions[0] : null;
    // When the group supplies a precomputed effective pending approval, skip the
    // linear scan over every pending approval so N sibling rows don't each redo it.
    const pendingApprovalFromMap = useMemo(
        () => (precomputed
            ? null
            : findPendingApprovalForToolcall(toolcallId, allPendingApprovals.values())),
        [precomputed, toolcallId, allPendingApprovals],
    );
    const pendingApproval = precomputed
        ? precomputed.pendingApproval
        : getEffectiveEditNotePendingApproval(action, pendingApprovalFromMap);
    const hasToolReturn = resultsMap.get(toolcallId) !== undefined;
    const toolCallStatus = precomputed
        ? precomputed.toolCallStatus
        : getToolCallStatus(toolcallId, resultsMap, runStatus);

    const parsedArgs = useMemo(
        () => part.streaming_args ?? parseEditNoteToolCallArgs(part.args),
        [part.streaming_args, part.args],
    );
    const resolvedTarget = useMemo(
        () => (
            resolveEditNoteTargetFromData(pendingApproval?.actionData)
            ?? resolveEditNoteTargetFromData(action?.proposed_data)
            ?? resolveEditNoteTargetFromData(action?.result_data)
            ?? resolveEditNoteTargetFromData(parsedArgs)
            ?? resolveEditNoteTargetFromData(part.args)
        ),
        [pendingApproval?.actionData, action?.proposed_data, action?.result_data, parsedArgs, part.args],
    );

    const isStreamingPlaceholder = isEditNoteStreamingPlaceholder({
        action,
        pendingApproval,
        toolCallStatus,
    });
    const isOrphaned = isEditNoteOrphaned({
        action,
        pendingApproval,
        toolCallStatus,
    });

    const [isProcessingApproval, setIsProcessingApproval] = useState(false);
    const [isProcessingAction, setIsProcessingAction] = useState(false);
    const [undoError, setUndoError] = useState<string | null>(null);
    const [isExternallyProcessing, setIsExternallyProcessing] = useState(false);
    const [clickedButton, setClickedButton] = useState<'approve' | 'reject' | 'undo' | 'retry' | null>(null);
    const prevPendingApprovalRef = useRef<PendingApproval | null>(pendingApproval);

    const handleApprovalRecovered = useCallback(() => {
        setIsProcessingApproval(false);
        setIsExternallyProcessing(false);
        setClickedButton(null);
    }, []);
    const { setProcessingApproval } = useApprovalRecovery({
        isAwaitingDecision: isProcessingApproval || isExternallyProcessing,
        hasToolReturn,
        actionStatus: action?.status,
        onRecover: handleApprovalRecovered,
        label: 'useEditNoteActions',
    });

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
                // Record it for recovery too: a decision made from another
                // surface (the group's Apply All, the diff-preview banner) can
                // miss its window exactly like one made here.
                setProcessingApproval({
                    actionId: previousActionId,
                    kind: previousIntent === false ? 'reject' : 'approve',
                });
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
        setProcessingApproval,
    ]);

    useEffect(() => {
        if ((isProcessingApproval || isExternallyProcessing) && action && action.status !== 'pending') {
            setIsProcessingApproval(false);
            setProcessingApproval(null);
            setIsExternallyProcessing(false);
            setClickedButton(null);
        }
        if (isExternallyProcessing && (hasToolReturn || !isRunPending)) {
            setIsExternallyProcessing(false);
            setProcessingApproval(null);
            setClickedButton(null);
        }
    }, [isProcessingApproval, isExternallyProcessing, action?.status, hasToolReturn, isRunPending, action, setProcessingApproval]);

    const isWriting = actions.some((candidate) => inFlightActionIds.has(candidate.id));
    const isProcessing = isProcessingApproval || isProcessingAction || isExternallyProcessing || isWriting;
    const effectiveStatus: EditNoteDisplayStatus = getEditNoteDisplayStatus({
        action,
        pendingApproval,
        toolCallStatus,
    });
    const config = STATUS_CONFIGS[effectiveStatus];

    // buildPreviewData derives actionType from pendingApproval/action when either
    // is present, so the toolName argument only matters as the pre-action/pre-approval
    // fallback below it — pass the real type when known for clarity.
    const basePreviewData = buildPreviewData(
        pendingApproval?.actionType ?? action?.action_type ?? 'edit_note',
        pendingApproval,
        action,
    );
    // Before any action/pendingApproval exists (pure streaming), classify the
    // call from its args shape so the preview dispatches to the right branch
    // instead of defaulting to the v1 type. `edits[]` alone is NOT enough —
    // batch and blocks both have one; see getEditNoteCallVariant.
    const streamingActionType = STREAMING_ACTION_TYPE[
        getEditNoteCallVariant({ toolArgs: parsedArgs ?? undefined })
    ];
    const previewData = basePreviewData
        ?? (parsedArgs && Object.keys(parsedArgs).length > 0
            ? { actionType: streamingActionType, actionData: parsedArgs }
            : null);
    const previewStatus: EditNoteDisplayStatus = previewData
        ? effectiveStatus
        : (isOrphaned ? 'error' : 'pending');
    const previewIsStreaming = !basePreviewData && isStreamingPlaceholder;

    const showApply = config.showApply && (!!pendingApproval || !!action);
    const showReject = config.showReject && (!!pendingApproval || !!action);
    const showUndo = config.showUndo && !!action;
    const showRetry = config.showRetry && !!action;

    const runApply = useCallback(async (button: 'approve' | 'retry') => {
        if (!action || isProcessing) return;

        setIsProcessingAction(true);
        setClickedButton(button);
        try {
            const result = await applyAgentActions({ actions: [action], runId });
            if (result.applied.includes(action.id)) {
                logger(`useEditNoteActions: Applied ${action.action_type} action ${action.id}`, 1);
            }
        } finally {
            setIsProcessingAction(false);
            setClickedButton(null);
        }
    }, [action, applyAgentActions, isProcessing, runId]);

    const handleApprove = useCallback(() => {
        if (!pendingApproval) return;
        setIsProcessingApproval(true);
        setProcessingApproval({ actionId: pendingApproval.actionId, kind: 'approve' });
        setClickedButton('approve');
        sendApprovalResponse({ actionId: pendingApproval.actionId, approved: true });
        removePendingApproval(pendingApproval.actionId);
    }, [pendingApproval, sendApprovalResponse, removePendingApproval, setProcessingApproval]);

    const handleReject = useCallback(() => {
        if (!pendingApproval) return;
        setIsProcessingApproval(true);
        setProcessingApproval({ actionId: pendingApproval.actionId, kind: 'reject' });
        setClickedButton('reject');
        sendApprovalResponse({ actionId: pendingApproval.actionId, approved: false });
        removePendingApproval(pendingApproval.actionId);
    }, [pendingApproval, sendApprovalResponse, removePendingApproval, setProcessingApproval]);

    const handleApplyPending = useCallback(async () => {
        await runApply('approve');
    }, [runApply]);

    const handleRejectPending = useCallback(() => {
        if (!action || isProcessing) return;
        setClickedButton('reject');
        // The shared atom checks the in-flight claim atomically before
        // rejecting and dismisses any active note-edit preview.
        rejectAgentActions({ actions: [action] });
        setTimeout(() => setClickedButton(null), 100);
    }, [action, isProcessing, rejectAgentActions]);

    const handleUndo = useCallback(async () => {
        if (!action || isProcessing) return;

        if (onUndoErrorChange) {
            onUndoErrorChange(toolcallId, null);
        } else {
            setUndoError(null);
        }

        setIsProcessingAction(true);
        setClickedButton('undo');
        try {
            const result = await undoAgentActions({ actions: [action] });
            if (result.undone.includes(action.id)) {
                logger(`useEditNoteActions: Undone ${action.action_type} action ${action.id}`, 1);
                return;
            }
            const errorMessage = result.failed[0]?.error ?? result.fatalError;
            if (errorMessage) {
                logger(`useEditNoteActions: Failed to undo edit_note action ${action.id}: ${errorMessage}`, 1);
            }
            if (onUndoErrorChange) {
                onUndoErrorChange(toolcallId, errorMessage ?? 'Failed to undo note edit');
            } else {
                setUndoError(errorMessage ?? 'Failed to undo note edit');
            }
        } finally {
            setIsProcessingAction(false);
            setClickedButton(null);
        }
    }, [action, isProcessing, onUndoErrorChange, toolcallId, undoAgentActions]);

    const handleRetry = useCallback(async () => {
        if (action && hasFailedUndo([action])) {
            await handleUndo();
            return;
        }
        await runApply('retry');
    }, [action, handleUndo, runApply]);

    const handleOpenNote = useCallback(async () => {
        if (!resolvedTarget) return;
        const editData = action?.proposed_data ?? pendingApproval?.actionData;

        if (editData) {
            await openNoteAndSearchEdit(
                resolvedTarget.libraryId,
                resolvedTarget.zoteroKey,
                editData.old_string || '',
                editData.new_string || '',
                action?.status === 'applied',
                action?.result_data?.undo_before_context,
                action?.result_data?.undo_after_context,
                editData.target_before_context,
                editData.target_after_context,
                editData.operation,
            );
            return;
        }

        await openNoteByKey(resolvedTarget.libraryId, resolvedTarget.zoteroKey);
    }, [resolvedTarget, action, pendingApproval]);

    /**
     * Open the note and jump to ONE edit of a multi-edit note action
     * (edit_note_batch or edit_note_blocks). The row descriptor carries the
     * edit's own strings and, when validation supplied them, its disambiguation
     * anchors; anything the row lacks is joined from the action payload by edit
     * index, and undo contexts always come from the result data.
     */
    const handleOpenNoteForRow = useCallback(async (row: EditNoteRowDescriptor) => {
        if (!resolvedTarget) return;
        const batchData = action?.proposed_data ?? pendingApproval?.actionData;
        const edits: any[] = Array.isArray(batchData?.edits) ? batchData.edits : [];
        const fullEdit = row.editIndex !== null
            ? edits.find((e: any) => e?.index === row.editIndex)
            : undefined;
        const undoRecords: any[] = Array.isArray(action?.result_data?.undo)
            ? action.result_data.undo
            : [];
        const undoRecord = row.editIndex !== null
            ? undoRecords.find((u: any) => u?.index === row.editIndex)
            : undefined;

        await openNoteAndSearchEdit(
            resolvedTarget.libraryId,
            resolvedTarget.zoteroKey,
            row.oldString || '',
            row.newString || '',
            action?.status === 'applied',
            undoRecord?.undo_before_context,
            undoRecord?.undo_after_context,
            row.targetBeforeContext ?? fullEdit?.target_before_context,
            row.targetAfterContext ?? fullEdit?.target_after_context,
            row.operation as EditNoteOperation,
        );
    }, [resolvedTarget, action, pendingApproval]);

    return {
        actions,
        previewData,
        previewStatus,
        previewIsStreaming,
        isProcessing,
        isStreamingPlaceholder,
        config,
        clickedButton,
        displayedUndoError: externalUndoError ?? undoError,
        showApply,
        showReject,
        showUndo,
        showRetry,
        showOpenNoteAction: resolvedTarget !== null,
        openNoteTooltip: action || pendingApproval ? 'Open note and jump to edit' : 'Open note',
        handleApprove,
        handleReject,
        handleApplyPending,
        handleRejectPending,
        handleUndo,
        handleRetry,
        handleOpenNote,
        handleOpenNoteForRow,
    };
}
