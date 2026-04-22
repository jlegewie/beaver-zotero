import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentRunStatus, ToolCallPart } from '../../agents/types';
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
import {
    approvalResponseIntentsAtom,
    isWSChatPendingAtom,
    removeApprovalResponseIntentAtom,
    sendApprovalResponseAtom,
} from '../../atoms/agentRunAtoms';
import { getToolCallStatus, toolResultsMapAtom } from '../../agents/atoms';
import { executeEditNoteAction, undoEditNoteAction } from '../../utils/editNoteActions';
import { openNoteAndSearchEdit, openNoteByKey } from '../../utils/sourceUtils';
import {
    dismissDiffPreview,
    isDiffPreviewActive,
    isNoteOpenInEditor,
    showDiffPreview,
    type EditOperation,
} from '../../utils/noteEditorDiffPreview';
import { diffPreviewNoteKeyAtom, isDiffPreviewLive } from '../../utils/diffPreviewCoordinator';
import { logger } from '../../../src/utils/logger';
import { store } from '../../store';
import { PreviewData, STATUS_CONFIGS, buildPreviewData } from './agentActionViewHelpers';
import {
    EditNoteDisplayStatus,
    EditNoteResolvedTarget,
    findPendingApprovalForToolcall,
    getEditNoteDisplayStatus,
    getEffectiveEditNotePendingApproval,
    isEditNoteOrphaned,
    isEditNoteStreamingPlaceholder,
    parseEditNoteToolCallArgs,
    resolveEditNoteTargetFromData,
} from './editNoteShared';

export function buildPreviewableEditOperations(
    entries: Array<Record<string, any> | null | undefined>,
): EditOperation[] {
    const edits: EditOperation[] = [];
    for (const entry of entries) {
        if (!entry) continue;
        const oldString = (entry.old_string as string | undefined) ?? '';
        const newString = (entry.new_string as string | undefined) ?? '';
        const operation = (entry.operation ?? 'str_replace') as EditOperation['operation'];
        if (operation === 'rewrite' || oldString) {
            edits.push({ oldString, newString, operation });
        }
    }
    return edits;
}

export async function dismissActiveEditNotePreview(): Promise<void> {
    if (!isDiffPreviewActive()) return;
    await dismissDiffPreview();
    store.set(diffPreviewNoteKeyAtom, null);
}

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

interface UseEditNoteActionsOptions {
    part: ToolCallPart;
    runId: string;
    runStatus: AgentRunStatus;
    externalUndoError?: string | null;
    onUndoErrorChange?: (toolcallId: string, error: string | null) => void;
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
}

export function useEditNoteActions({
    part,
    runId,
    runStatus,
    externalUndoError = null,
    onUndoErrorChange,
}: UseEditNoteActionsOptions): EditNoteRowState {
    const toolcallId = part.tool_call_id;

    const resultsMap = useAtomValue(toolResultsMapAtom);
    const getAgentActionsByToolcall = useAtomValue(getAgentActionsByToolcallAtom);
    const allPendingApprovals = useAtomValue(pendingApprovalsAtom);
    const approvalResponseIntents = useAtomValue(approvalResponseIntentsAtom);
    const sendApprovalResponse = useSetAtom(sendApprovalResponseAtom);
    const removeApprovalResponseIntent = useSetAtom(removeApprovalResponseIntentAtom);
    const removePendingApproval = useSetAtom(removePendingApprovalAtom);
    const ackAgentActions = useSetAtom(ackAgentActionsAtom);
    const rejectAgentAction = useSetAtom(rejectAgentActionAtom);
    const setAgentActionsToError = useSetAtom(setAgentActionsToErrorAtom);
    const undoAgentAction = useSetAtom(undoAgentActionAtom);
    const isRunPending = useAtomValue(isWSChatPendingAtom);

    const actions = getAgentActionsByToolcall(toolcallId, (a) => a.run_id === runId);
    const action = actions.length > 0 ? actions[0] : null;
    const pendingApprovalFromMap = useMemo(
        () => findPendingApprovalForToolcall(toolcallId, allPendingApprovals.values()),
        [allPendingApprovals, toolcallId],
    );
    const pendingApproval = getEffectiveEditNotePendingApproval(action, pendingApprovalFromMap);
    const hasToolReturn = resultsMap.get(toolcallId) !== undefined;
    const toolCallStatus = getToolCallStatus(toolcallId, resultsMap, runStatus);

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
    const effectiveStatus: EditNoteDisplayStatus = getEditNoteDisplayStatus({
        action,
        pendingApproval,
        toolCallStatus,
    });
    const config = STATUS_CONFIGS[effectiveStatus];

    const basePreviewData = buildPreviewData('edit_note', pendingApproval, action);
    const previewData = basePreviewData
        ?? (parsedArgs && Object.keys(parsedArgs).length > 0
            ? { actionType: 'edit_note', actionData: parsedArgs }
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
            await dismissActiveEditNotePreview();
            const result = await executeEditNoteAction(action);
            await ackAgentActions(runId, [{
                action_id: action.id,
                result_data: result,
            }]);
            logger(`useEditNoteActions: Applied edit_note action ${action.id}`, 1);
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to apply edit_note';
            const stackTrace = error?.stack || '';
            logger(`useEditNoteActions: Failed to apply edit_note action ${action.id}: ${errorMessage}\n${stackTrace}`, 1);
            setAgentActionsToError([action.id], errorMessage, {
                stack_trace: stackTrace,
                error_name: error?.name,
            });
        } finally {
            setIsProcessingAction(false);
            setClickedButton(null);
        }
    }, [action, isProcessing, ackAgentActions, runId, setAgentActionsToError]);

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
        await runApply('approve');
    }, [runApply]);

    const handleRejectPending = useCallback(() => {
        if (!action || isProcessing) return;
        setClickedButton('reject');
        rejectAgentAction(action.id);
        setTimeout(() => setClickedButton(null), 100);
    }, [action, isProcessing, rejectAgentAction]);

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
            await dismissActiveEditNotePreview();
            await undoEditNoteAction(action);
            undoAgentAction(action.id);
            logger(`useEditNoteActions: Undone edit_note action ${action.id}`, 1);
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to undo edit_note';
            const stackTrace = error?.stack || '';
            logger(`useEditNoteActions: Failed to undo edit_note action ${action.id}: ${errorMessage}\n${stackTrace}`, 1);
            if (onUndoErrorChange) {
                onUndoErrorChange(toolcallId, errorMessage);
            } else {
                setUndoError(errorMessage);
            }
        } finally {
            setIsProcessingAction(false);
            setClickedButton(null);
        }
    }, [action, isProcessing, onUndoErrorChange, toolcallId, undoAgentAction]);

    const handleRetry = useCallback(async () => {
        await runApply('retry');
    }, [runApply]);

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
            );
            return;
        }

        await openNoteByKey(resolvedTarget.libraryId, resolvedTarget.zoteroKey);
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
    };
}
