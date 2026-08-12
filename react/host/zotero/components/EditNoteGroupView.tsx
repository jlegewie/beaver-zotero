import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { AgentRunStatus, ToolCallPart } from '@beaver/agent-core/agents/types';
import { getToolCallStatus, toolResultsMapAtom } from '@beaver/agent-core/run-state/atoms';
import {
    AgentAction,
    agentActionsByToolcallAtom,
    pendingApprovalsAtom,
} from '../../../agents/agentActions';
import type { EditNoteResolvedTarget, PendingApproval } from '@beaver/agent-ui/host';
import {
    approveToolGroupForRunAtom,
    isWSChatPendingAtom,
    sendApprovalResponseAtom,
    staleApprovalActionIdsAtom,
} from '../../../atoms/agentRunAtoms';
import {
    agentActionItemTitlesAtom,
    setAgentActionItemTitleAtom,
    toolExpandedAtom,
    setToolExpandedAtom,
} from '../../../atoms/messageUIState';
import {
    canOfferToolGroupRunApproval,
    getToolGroupRunApprovalLabel,
    getToolGroupRunApprovalScope,
} from '../../../atoms/runApprovalPolicy';
import {
    STATUS_CONFIGS,
    hasFailedUndo,
    type ActionStatus,
} from './agentActionViewHelpers';
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
} from '../../../components/icons/icons';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import SplitApplyButton from '../../../components/ui/buttons/SplitApplyButton';
import { openNoteByKey } from '../../../utils/sourceUtils';
import { logger } from '@beaver/agent-core/platform/logger';
import { UNRESOLVED_LIBRARY_ID } from '../../../../src/utils/libraryIdentity';
import { EditNoteRowView } from './EditNoteRowView';
import { buildUndoByIndex } from './editNoteBatchPreviewData';
import { isDiffPreviewLive } from '../../../utils/diffPreviewCoordinator';
import {
    dismissActiveEditNotePreview,
    showEditNotePreviewForEdits,
} from './useEditNoteActions';
import { buildPreviewableEditOperations } from '../../../utils/editNotePreviewOperations';
import { getEditNoteRetryOrder } from './editNoteRetryOrder';
import {
    applyAgentActionsAtom,
    inFlightAgentActionIdsAtom,
    rejectAgentActionsAtom,
    undoAgentActionsAtom,
} from '../agentActionExecution';
import {
    deriveEditNoteRows,
    type EditNoteRowDescriptor,
    findPendingApprovalForToolcall,
    getEditNoteDisplayStatus,
    getEffectiveEditNotePendingApproval,
    getEditNoteGroupExpansionKey,
    getOverallEditNoteDisplayStatus,
    isEditNoteStreamingPlaceholder,
    parseEditNoteToolCallArgs,
    resolveEditNoteTargetFromData,
} from '../../../components/agentRuns/editNoteShared';

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
    // Subscribe to the grouped-actions map itself (not the stable getter atom)
    // so partStates re-derives whenever any agent action changes — the getter's
    // identity never changes, which would leave memoized rows showing stale
    // action state after a local apply/retry.
    const actionsByToolcall = useAtomValue(agentActionsByToolcallAtom);
    const allPendingApprovals = useAtomValue(pendingApprovalsAtom);
    const setPendingApprovals = useSetAtom(pendingApprovalsAtom);
    const sendApprovalResponse = useSetAtom(sendApprovalResponseAtom);
    const isRunPending = useAtomValue(isWSChatPendingAtom);
    const rejectAgentActions = useSetAtom(rejectAgentActionsAtom);
    const applyAgentActions = useSetAtom(applyAgentActionsAtom);
    const undoAgentActions = useSetAtom(undoAgentActionsAtom);
    const inFlightActionIds = useAtomValue(inFlightAgentActionIdsAtom);
    const approveToolGroupForRun = useSetAtom(approveToolGroupForRunAtom);

    const partStates = useMemo(() => {
        return parts.map((part) => {
            const actions = (actionsByToolcall.get(part.tool_call_id) ?? []).filter((a) => a.run_id === runId);
            // A single tool call always produces exactly one AgentAction, even for
            // an edit_note_batch call (the whole batch is one action).
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
            const actionType = action?.action_type ?? pendingApproval?.actionType;
            const toolArgs = part.streaming_args ?? parseEditNoteToolCallArgs(part.args) ?? undefined;
            const rows = deriveEditNoteRows({
                toolArgs,
                actionType,
                actionData: action?.proposed_data ?? pendingApproval?.actionData,
                resultData: action?.result_data,
            });
            const isBatch = actionType === 'edit_note_batch'
                || (actionType == null && Array.isArray(toolArgs?.edits));
            // Derivations identical for every sibling row of this toolcall,
            // computed once here and passed to each EditNoteRowView so the rows
            // skip re-deriving them. The undo index mirrors the effective
            // resultData the row's preview uses (a pending approval carries no
            // result_data yet).
            const precomputed = { actions, pendingApproval, toolCallStatus };
            const undoByIndex = buildUndoByIndex(pendingApproval ? undefined : action?.result_data);
            return {
                part,
                actions,
                action,
                pendingApproval,
                toolCallStatus,
                effectiveStatus,
                rows,
                isBatch,
                precomputed,
                undoByIndex,
            };
        });
    }, [parts, runId, actionsByToolcall, allPendingApprovals, resultsMap, runStatus]);

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
    // Count individual edit rows rather than parts/tool-calls, so a single
    // edit_note_batch call (one part, N edits) contributes N to the label.
    const editCount = useMemo(
        () => partStates.reduce((total, state) => total + Math.max(state.rows.length, 1), 0),
        [partStates],
    );

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
    // A child is still "processing" only while its tool call has not returned
    // and its decision can still reach the run. Once the return is in, the call
    // is settled whatever the action's status — an action left `pending` at that
    // point had its approval window expire. A child whose approval was marked
    // stale is settled for the same reason without waiting for a return.
    // Counting either as unsettled would hold the group's spinner up for the
    // rest of the run over a decision the backend can no longer act on.
    const staleApprovalActionIds = useAtomValue(staleApprovalActionIdsAtom);
    const hasUnsettledProcessingChild = useMemo(() => (
        partStates.some((state) => (
            state.pendingApproval === null
            && resultsMap.get(state.part.tool_call_id) === undefined
            && (state.action?.status === 'pending' || !state.action)
            && !(state.action && staleApprovalActionIds.has(state.action.id))
        ))
    ), [partStates, resultsMap, staleApprovalActionIds]);

    const aggregateStatus: ActionStatus | 'awaiting' = getOverallEditNoteDisplayStatus(rowStatuses);

    const expansionKey = getEditNoteGroupExpansionKey(runId, responseIndex, parts);
    const expansionState = useAtomValue(toolExpandedAtom);
    const setExpanded = useSetAtom(setToolExpandedAtom);
    const hasExistingExpandState = expansionState[expansionKey] !== undefined;
    const isExpanded = hasStreamingChild
        ? false
        : (expansionState[expansionKey]
            ?? (hasPendingApprovals || (errorCount > 0 && reapplicableActions.length === 0 && appliedCount === 0)));

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
        // resolvedTarget is derived from agent-supplied tool args/action data and
        // may carry UNRESOLVED_LIBRARY_ID when its library isn't available on
        // this device; the lookup below would throw on it.
        if (resolvedTarget.libraryId === UNRESOLVED_LIBRARY_ID) return;
        let cancelled = false;
        (async () => {
            try {
                const item = await Zotero.Items.getByLibraryAndKeyAsync(
                    resolvedTarget.libraryId,
                    resolvedTarget.zoteroKey,
                );
                if (!item || cancelled) return;
                const title = item.isNote?.() ? (item.getNoteTitle?.() || '(untitled)') : '(untitled)';
                setItemTitle({ key: itemTitleKey, title });
                // The terminal review rows are keyed by toolcall id. Seed the
                // same title under those keys so they can reuse this lookup.
                for (const part of parts) {
                    setItemTitle({ key: part.tool_call_id, title });
                }
            } catch {
                /* best-effort */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [resolvedTarget, itemTitleKey, noteTitle, parts, setItemTitle]);

    const [isLocallyProcessing, setIsLocallyProcessing] = useState(false);
    const [isExternallyProcessing, setIsExternallyProcessing] = useState(false);
    const [clickedButton, setClickedButton] = useState<'approve' | 'reject' | 'undo' | 'retry' | null>(null);
    const [perEditUndoErrors, setPerEditUndoErrors] = useState<Record<string, string>>({});
    const isWriting = allActions.some((action) => inFlightActionIds.has(action.id));
    const isProcessing = isLocallyProcessing || isExternallyProcessing || isWriting;

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
                // Dismiss the preview first, then batch-remove approvals in a
                // single update.
                await dismissActiveEditNotePreview();
                const idsToRemove: string[] = [];
                for (const pending of pendingApprovalsForGroup) {
                    sendApprovalResponse({ actionId: pending.actionId, approved: true });
                    idsToRemove.push(pending.actionId);
                }
                if (idsToRemove.length > 0) {
                    setPendingApprovals((prev) => {
                        const next = new Map(prev);
                        for (const id of idsToRemove) next.delete(id);
                        return next;
                    });
                }
                if (shouldWaitForExternalProcessing) {
                    setIsExternallyProcessing(true);
                }
                logger(`EditNoteGroupView: Approved ${idsToRemove.length} edit_note actions for ${noteKeyLabel}`, 1);
                return;
            }

            if (reapplicableActions.length === 0) return;
            await dismissActiveEditNotePreview();

            for (const action of reapplicableActions) {
                const result = await applyAgentActions({ actions: [action], runId });
                if (result.applied.includes(action.id)) {
                    logger(`EditNoteGroupView: Applied ${action.action_type} action ${action.id}`, 1);
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
        setPendingApprovals,
        applyAgentActions,
        runId,
    ]);

    const handleApproveNoteEditsForRun = useCallback(async () => {
        if (isProcessing) return;
        setIsLocallyProcessing(true);
        setClickedButton('approve');
        const shouldWaitForExternalProcessing = hasPendingApprovals && isRunPending;
        try {
            await dismissActiveEditNotePreview();
            const approvedCount = approveToolGroupForRun({
                runId,
                toolName: 'edit_note',
            });
            if (shouldWaitForExternalProcessing) {
                setIsExternallyProcessing(true);
            }
            logger(
                `EditNoteGroupView: Allowed note edits for run ${runId} and approved ${approvedCount} pending action(s)`,
                1,
            );
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
        approveToolGroupForRun,
        runId,
    ]);

    const handleRejectAll = useCallback(() => {
        if (isProcessing) return;
        setClickedButton('reject');
        if (hasPendingApprovals) {
            // Dismiss the preview first, then batch-remove approvals in a
            // single update. See handleApplyAll for rationale.
            void dismissActiveEditNotePreview();
            const idsToRemove: string[] = [];
            for (const pending of pendingApprovalsForGroup) {
                sendApprovalResponse({ actionId: pending.actionId, approved: false });
                idsToRemove.push(pending.actionId);
            }
            if (idsToRemove.length > 0) {
                setPendingApprovals((prev) => {
                    const next = new Map(prev);
                    for (const id of idsToRemove) next.delete(id);
                    return next;
                });
            }
            logger(`EditNoteGroupView: Rejected ${idsToRemove.length} edit_note actions for ${noteKeyLabel}`, 1);
        } else {
            // The shared atom checks every action against the in-flight claim
            // before rejecting and dismisses any active note-edit preview.
            rejectAgentActions({ actions: reapplicableActions });
            logger(`EditNoteGroupView: Rejected ${reapplicableActions.length} edit_note actions for ${noteKeyLabel}`, 1);
        }
        setTimeout(() => setClickedButton(null), 100);
    }, [
        isProcessing,
        hasPendingApprovals,
        pendingApprovalsForGroup,
        noteKeyLabel,
        sendApprovalResponse,
        setPendingApprovals,
        reapplicableActions,
        rejectAgentActions,
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
                const result = await undoAgentActions({ actions: [action] });
                if (result.undone.includes(action.id)) {
                    logger(`EditNoteGroupView: Undone ${action.action_type} action ${action.id}`, 1);
                    continue;
                }
                const errorMessage = result.failed[0]?.error ?? result.fatalError ?? 'Failed to undo note edit';
                logger(`EditNoteGroupView: Failed to undo ${action.action_type} action ${action.id}: ${errorMessage}`, 1);
                if (action.toolcall_id) {
                    newFailures[action.toolcall_id] = errorMessage;
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
        undoAgentActions,
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

            // Undo retries have the same dependency ordering as Undo All:
            // newest edit first, so an older edit is never reverted through a
            // newer edit that is still applied. Apply retries retain their
            // original oldest-to-newest order.
            const { undoActions, applyActions } = getEditNoteRetryOrder(errorActions);

            for (const action of undoActions) {
                const result = await undoAgentActions({ actions: [action] });
                const toolcallId = action.toolcall_id;
                if (result.undone.includes(action.id)) {
                    if (toolcallId) {
                        setPerEditUndoErrors((prev) => {
                            if (!(toolcallId in prev)) return prev;
                            const next = { ...prev };
                            delete next[toolcallId];
                            return next;
                        });
                    }
                    logger(`EditNoteGroupView: Retried + undone ${action.action_type} action ${action.id}`, 1);
                    continue;
                }

                const errorMessage = result.failed[0]?.error ?? result.fatalError ?? 'Failed to undo note edit';
                if (toolcallId) {
                    setPerEditUndoErrors((prev) => ({ ...prev, [toolcallId]: errorMessage }));
                }
                setExpanded({ key: expansionKey, expanded: true });
                logger(`EditNoteGroupView: Retry undo failed for ${action.action_type} action ${action.id}: ${errorMessage}`, 1);
            }

            for (const action of applyActions) {
                const result = await applyAgentActions({ actions: [action], runId });
                if (result.applied.includes(action.id)) {
                    logger(`EditNoteGroupView: Retried + applied ${action.action_type} action ${action.id}`, 1);
                }
            }
        } finally {
            setIsLocallyProcessing(false);
            setClickedButton(null);
        }
    }, [isProcessing, errorActions, applyAgentActions, undoAgentActions, runId, setExpanded, expansionKey]);

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
            const stillUndoable = new Set(
                allActions
                    .filter((a) => a.toolcall_id && (a.status === 'applied' || hasFailedUndo([a])))
                    .map((a) => a.toolcall_id as string),
            );
            let changed = false;
            const next: Record<string, string> = {};
            for (const key of keys) {
                if (stillUndoable.has(key)) {
                    next[key] = prev[key];
                } else {
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [allActions]);

    const handlePreviewInEditor = useCallback(async () => {
        if (!isDiffPreviewLive()) {
            logger(`EditNoteGroupView: handlePreviewInEditor — aborting, diff preview not live (kill switch off or Zotero 7)`, 1);
            return;
        }
        if (!resolvedTarget) {
            logger(`EditNoteGroupView: handlePreviewInEditor — aborting, no resolvedTarget for ${noteKeyLabel}`, 1);
            return;
        }
        const edits = hasPendingApprovals
            ? buildPreviewableEditOperations(pendingApprovalsForGroup.map((pending) => pending.actionData))
            : buildPreviewableEditOperations(reapplicableActions.map((action) => action.proposed_data));
        if (edits.length === 0) {
            logger(`EditNoteGroupView: handlePreviewInEditor — no previewable edits for ${noteKeyLabel}`, 1);
            return;
        }

        try {
            await showEditNotePreviewForEdits(resolvedTarget, edits, (bannerAction) => {
                if (bannerAction === 'approve') {
                    handleApplyAll();
                } else {
                    handleRejectAll();
                }
            });
        } catch (error: any) {
            const errorMessage = error?.message || 'Unknown error';
            const stackTrace = error?.stack || '';
            logger(
                `EditNoteGroupView: handlePreviewInEditor — failed to show preview for ${noteKeyLabel}: `
                + `${errorMessage}\n${stackTrace}`,
                1,
            );
        }
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
        if (hasStreamingChild) return;
        setExpanded({ key: expansionKey, expanded: !isExpanded });
    }, [setExpanded, expansionKey, isExpanded, hasStreamingChild]);

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
    // A whole-note rewrite must not be labelled like an ordinary edit: it is the
    // one operation that can delete a note's contents in a single approval, and
    // the header is what the user reads before deciding.
    const isWholeNoteRewrite = useMemo(
        () => partStates.length === 1
            && partStates[0].rows.length === 1
            && partStates[0].rows[0].operation === 'rewrite',
        [partStates],
    );
    const groupLabel = isWholeNoteRewrite
        ? 'Rewrite Note'
        : (editCount === 1 ? 'Note Edit' : `${editCount} Note Edits`);
    // A rewrite validation classified as destructive is authorized on its own,
    // so a note-edit run grant neither approves it nor sweeps it up. Offering
    // "Allow all note edits for this run" here would look like it applies the
    // card and then leave it sitting there, so drop to a plain Apply All.
    const canOfferNoteEditRunApproval = useMemo(
        () => canOfferToolGroupRunApproval(pendingApprovalsForGroup, 'edit_note'),
        [pendingApprovalsForGroup],
    );
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
    // Gate on both the global kill switch and the runtime Zotero capability
    // check so the button is hidden on Zotero 7 (where showDiffPreview would
    // silently no-op) without requiring a version bump of strict_min_version.
    const canShowPreview =
        !isProcessing
        && isDiffPreviewLive()
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
                    onClick={isProcessing || hasStreamingChild ? () => {} : toggleExpanded}
                    disabled={isProcessing || hasStreamingChild}
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
                            disabled={hasStreamingChild}
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
                        {partStates.map((state, idx) => {
                            const { part } = state;
                            // A v1 part always derives exactly one row with editIndex
                            // null; only render it as a distinct batch row when it's
                            // genuinely part of an edit_note_batch action.
                            const rows: (EditNoteRowDescriptor | undefined)[] = state.isBatch
                                ? state.rows
                                : [undefined];
                            return rows.map((row, rowIdx) => (
                                <div
                                    key={`tool-${part.tool_call_id}-edit-${row?.editIndex ?? rowIdx}`}
                                    className={(idx > 0 && rowIdx === 0) || rowIdx > 0 ? 'border-top-quinary' : undefined}
                                >
                                    <EditNoteRowView
                                        part={part}
                                        runId={runId}
                                        runStatus={runStatus}
                                        disabled={isProcessing}
                                        externalUndoError={perEditUndoErrors[part.tool_call_id] ?? null}
                                        onUndoErrorChange={handleChildUndoErrorChange}
                                        rowDescriptor={row}
                                        precomputed={state.precomputed}
                                        undoByIndex={state.undoByIndex}
                                    />
                                </div>
                            ));
                        })}
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
                                hasPendingApprovals && canOfferNoteEditRunApproval ? (
                                    <SplitApplyButton
                                        onApply={handleApplyAll}
                                        onApplyAll={handleApproveNoteEditsForRun}
                                        loading={isProcessing && clickedButton === 'approve'}
                                        disabled={isProcessing}
                                        primaryLabel="Apply All"
                                        applyAllLabel={getToolGroupRunApprovalLabel('edit_note') ?? undefined}
                                        applyAllScope={getToolGroupRunApprovalScope('edit_note') ?? undefined}
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
