import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { ToolCallPart } from '../../agents/types';
import {
    AgentAction,
    PendingApproval,
    getAgentActionsByToolcallAtom,
    getPendingApprovalForToolcallAtom,
    pendingApprovalsAtom,
    removePendingApprovalAtom,
    ackAgentActionsAtom,
    rejectAgentActionAtom,
    setAgentActionsToErrorAtom,
    undoAgentActionAtom,
} from '../../agents/agentActions';
import { sendApprovalResponseAtom } from '../../atoms/agentRunAtoms';
import {
    agentActionItemTitlesAtom,
    setAgentActionItemTitleAtom,
    toolExpandedAtom,
    setToolExpandedAtom,
} from '../../atoms/messageUIState';
import { addAutoApproveNoteKeyAtom, makeNoteKey } from '../../atoms/editNoteAutoApprove';
import {
    AgentActionView,
    STATUS_CONFIGS,
    getOverallStatus,
    ActionStatus,
} from './AgentActionView';
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
    TickIcon,
} from '../icons/icons';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';
import SplitApplyButton from '../ui/buttons/SplitApplyButton';
import { openNoteByKey } from '../../utils/sourceUtils';
import {
    isNoteOpenInEditor,
    isDiffPreviewActive,
    dismissDiffPreview,
    showDiffPreview,
    type EditOperation,
} from '../../utils/noteEditorDiffPreview';
import {
    DIFF_PREVIEW_ENABLED,
    diffPreviewNoteKeyAtom,
} from '../../utils/diffPreviewCoordinator';
import { executeEditNoteAction, undoEditNoteAction } from '../../utils/editNoteActions';
import { logger } from '../../../src/utils/logger';
import { store } from '../../store';

interface EditNoteGroupViewProps {
    /** 2+ consecutive edit_note tool call parts targeting the same note. */
    parts: ToolCallPart[];
    libraryId: number;
    zoteroKey: string;
    runId: string;
    /** Index of the parent response message within the run. */
    responseIndex: number;
}

/**
 * Groups multiple parallel `edit_note` tool calls targeting the same note into
 * a single collapsible row. The collapsed row shows aggregate status and
 * group-level Apply All / Reject All / Undo All buttons. When expanded, each
 * child renders as a normal `AgentActionView` so per-edit interaction
 * (preview, apply, reject, undo, retry) is preserved.
 */
export const EditNoteGroupView: React.FC<EditNoteGroupViewProps> = ({
    parts,
    libraryId,
    zoteroKey,
    runId,
    responseIndex,
}) => {
    const [isHovered, setIsHovered] = useState(false);

    // Atoms for state management
    const getAgentActionsByToolcall = useAtomValue(getAgentActionsByToolcallAtom);
    const getPendingApproval = useAtomValue(getPendingApprovalForToolcallAtom);
    const allPendingApprovals = useAtomValue(pendingApprovalsAtom);
    const sendApprovalResponse = useSetAtom(sendApprovalResponseAtom);
    const removePendingApproval = useSetAtom(removePendingApprovalAtom);
    const ackAgentActions = useSetAtom(ackAgentActionsAtom);
    const rejectAgentAction = useSetAtom(rejectAgentActionAtom);
    const setAgentActionsToError = useSetAtom(setAgentActionsToErrorAtom);
    const undoAgentAction = useSetAtom(undoAgentActionAtom);
    const addAutoApproveNoteKey = useSetAtom(addAutoApproveNoteKeyAtom);

    // Title cache (shared between panes)
    const itemTitleKey = `${responseIndex}:group:${libraryId}-${zoteroKey}`;
    const itemTitleMap = useAtomValue(agentActionItemTitlesAtom);
    const noteTitle = itemTitleMap[itemTitleKey] ?? null;
    const setItemTitle = useSetAtom(setAgentActionItemTitleAtom);

    // Collect actions and pending approvals for all child tool_call_ids
    const allActions: AgentAction[] = useMemo(() => {
        const out: AgentAction[] = [];
        for (const part of parts) {
            const childActions = getAgentActionsByToolcall(
                part.tool_call_id,
                (a) => a.run_id === runId,
            );
            out.push(...childActions);
        }
        return out;
    }, [parts, runId, getAgentActionsByToolcall]);

    const pendingApprovalsForGroup: PendingApproval[] = useMemo(() => {
        const out: PendingApproval[] = [];
        for (const part of parts) {
            const pa = getPendingApproval(part.tool_call_id);
            if (pa) out.push(pa);
        }
        return out;
        // We need to recompute when allPendingApprovals changes too, since
        // getPendingApproval is a snapshot reader.
    }, [parts, allPendingApprovals, getPendingApproval]);

    const pendingApprovalCount = pendingApprovalsForGroup.length;
    const hasPendingApprovals = pendingApprovalCount > 0;

    // Status counts
    const appliedCount = allActions.filter((a) => a.status === 'applied').length;
    const editCount = parts.length;

    /**
     * Actions that can be re-applied via the Preview banner or "Apply All"
     * button. Mirrors the single-edit AgentActionView behavior, where Apply
     * is shown for pending/rejected/undone (anything that isn't already in
     * its final applied/error state).
     */
    const reapplicableActions = useMemo(
        () => allActions.filter(
            (a) =>
                a.status === 'pending' ||
                a.status === 'rejected' ||
                a.status === 'undone',
        ),
        [allActions],
    );

    /**
     * Actions in `error` state. These are not part of `reapplicableActions`
     * (matches single AgentActionView, where the Apply button is hidden for
     * `error` and only the Retry button is shown). The group exposes these
     * via a separate "Retry All" footer button so an all-errored group is
     * still recoverable from the collapsed view.
     */
    const errorActions = useMemo(
        () => allActions.filter((a) => a.status === 'error'),
        [allActions],
    );
    const errorCount = errorActions.length;

    // Aggregate status (uses the same priority logic as single-action multi mode)
    const aggregateStatus: ActionStatus | 'awaiting' = hasPendingApprovals
        ? 'awaiting'
        : allActions.length > 0
            ? getOverallStatus(allActions)
            : 'pending';

    // Expansion state — keyed to avoid collision with single-edit AgentActionView
    const expansionKey = `${runId}:${responseIndex}:group:${libraryId}-${zoteroKey}`;
    const expansionState = useAtomValue(toolExpandedAtom);
    const setExpanded = useSetAtom(setToolExpandedAtom);
    const hasExistingExpandState = expansionState[expansionKey] !== undefined;
    // Default: expanded while approval is pending so users can see what they're
    // approving, and expanded when the group is in aggregate error so the
    // per-child Retry icons are visible.
    const isExpanded =
        expansionState[expansionKey]
        ?? (hasPendingApprovals || (errorCount > 0 && reapplicableActions.length === 0 && appliedCount === 0));

    // Track previous values to detect transitions vs re-mounts.
    // - Auto-collapse on `hasPendingApprovals` true → false (user resolved
    //   the approval flow). Mirrors single AgentActionView lines 295–314.
    // - Auto-expand on aggregate `error` so per-child Retry icons are
    //   reachable for an all-errored collapsed group.
    const prevHasPendingApprovalsRef = useRef(hasPendingApprovals);
    const hasInitializedRef = useRef(false);
    useEffect(() => {
        if (!hasInitializedRef.current) {
            hasInitializedRef.current = true;
            // First mount: only seed if there's no existing state (preserves
            // state from another pane sharing the same Jotai store).
            if (!hasExistingExpandState) {
                const seedExpanded =
                    hasPendingApprovals
                    || (errorCount > 0 && reapplicableActions.length === 0 && appliedCount === 0);
                setExpanded({ key: expansionKey, expanded: seedExpanded });
            }
            prevHasPendingApprovalsRef.current = hasPendingApprovals;
            return;
        }

        // After first mount, sync when hasPendingApprovals actually transitions.
        if (prevHasPendingApprovalsRef.current && !hasPendingApprovals) {
            // Approval flow just finished — collapse the group.
            setExpanded({ key: expansionKey, expanded: false });
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

    // Fetch note title once for the group
    useEffect(() => {
        if (noteTitle) return;
        let cancelled = false;
        (async () => {
            try {
                const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, zoteroKey);
                if (!item || cancelled) return;
                const title = item.isNote?.()
                    ? (item.getNoteTitle?.() || '(untitled)')
                    : '(untitled)';
                setItemTitle({ key: itemTitleKey, title });
            } catch {
                /* best-effort */
            }
        })();
        return () => { cancelled = true; };
    }, [libraryId, zoteroKey, itemTitleKey, noteTitle, setItemTitle]);

    // Local processing state
    const [isProcessing, setIsProcessing] = useState(false);
    const [clickedButton, setClickedButton] = useState<'approve' | 'reject' | 'undo' | 'retry' | null>(null);
    // Per-edit undo errors keyed by toolcall_id. Both the group's "Undo All"
    // and each child's per-edit Undo button funnel failures through this map
    // so the friendly "revert manually" banner appears in the exact child row
    // that failed — letting the user see exactly which edit couldn't be undone.
    const [perEditUndoErrors, setPerEditUndoErrors] = useState<Record<string, string>>({});

    // ---------------------------------------------------------------------
    // Handlers
    // ---------------------------------------------------------------------

    /**
     * Apply all pending approvals (mid-run) by sending approval responses,
     * or — if not awaiting approval — execute pending actions sequentially.
     */
    const handleApplyAll = useCallback(async () => {
        if (isProcessing) return;
        setIsProcessing(true);
        setClickedButton('approve');
        try {
            if (hasPendingApprovals) {
                // Mid-run: fan out approval responses
                for (const pa of pendingApprovalsForGroup) {
                    sendApprovalResponse({ actionId: pa.actionId, approved: true });
                    removePendingApproval(pa.actionId);
                }
                logger(`EditNoteGroupView: Approved ${pendingApprovalsForGroup.length} edit_note actions for ${libraryId}-${zoteroKey}`, 1);
                return;
            }

            // Post-run: execute reapplicable actions one at a time. This
            // includes status === 'pending', 'rejected', or 'undone' so the
            // user can re-apply previously-rejected or undone edits via this
            // entry point (matches single AgentActionView.handleApplyPending).
            const actionsToApply = reapplicableActions;
            if (actionsToApply.length === 0) return;

            // Dismiss any active diff preview before applying — same reason
            // as the single edit_note path: the preview freezes the editor.
            if (isDiffPreviewActive()) {
                await dismissDiffPreview();
                store.set(diffPreviewNoteKeyAtom, null);
            }

            for (const action of actionsToApply) {
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
            setIsProcessing(false);
            setClickedButton(null);
        }
    }, [
        isProcessing,
        hasPendingApprovals,
        pendingApprovalsForGroup,
        reapplicableActions,
        libraryId,
        zoteroKey,
        runId,
        sendApprovalResponse,
        removePendingApproval,
        ackAgentActions,
        setAgentActionsToError,
    ]);

    /**
     * Auto-approve all future edit_note calls to this note in this run, then
     * apply the current group.
     */
    const handleApproveAllForNote = useCallback(() => {
        const noteKey = makeNoteKey(libraryId, zoteroKey);
        addAutoApproveNoteKey(noteKey);

        // Auto-approve any other pending approvals for this note that aren't
        // in the current group (e.g., parts that arrived later).
        for (const [, pa] of allPendingApprovals) {
            if (pa.actionType !== 'edit_note') continue;
            const paLib = pa.actionData?.library_id;
            const paKey = pa.actionData?.zotero_key;
            if (paLib == null || !paKey) continue;
            if (makeNoteKey(paLib, paKey) !== noteKey) continue;
            // The current group's approvals will be handled by handleApplyAll
            // below — skip them here to avoid double-removal.
            if (pendingApprovalsForGroup.some((p) => p.actionId === pa.actionId)) continue;
            sendApprovalResponse({ actionId: pa.actionId, approved: true });
            removePendingApproval(pa.actionId);
        }

        handleApplyAll();
    }, [
        libraryId,
        zoteroKey,
        addAutoApproveNoteKey,
        allPendingApprovals,
        pendingApprovalsForGroup,
        sendApprovalResponse,
        removePendingApproval,
        handleApplyAll,
    ]);

    /**
     * Reject all pending approvals (mid-run) or all reapplicable actions
     * (post-run) in the group. "Reapplicable" includes pending and undone
     * actions; already-rejected ones stay rejected (idempotent).
     */
    const handleRejectAll = useCallback(() => {
        if (isProcessing) return;
        setClickedButton('reject');
        if (hasPendingApprovals) {
            for (const pa of pendingApprovalsForGroup) {
                sendApprovalResponse({ actionId: pa.actionId, approved: false });
                removePendingApproval(pa.actionId);
            }
            logger(`EditNoteGroupView: Rejected ${pendingApprovalsForGroup.length} edit_note actions for ${libraryId}-${zoteroKey}`, 1);
        } else {
            // Post-run: mark any reapplicable action as rejected. Use the
            // same set as handleApplyAll so the Preview banner's reject path
            // mirrors the apply path.
            for (const action of reapplicableActions) {
                rejectAgentAction(action.id);
            }
            logger(`EditNoteGroupView: Rejected ${reapplicableActions.length} edit_note actions for ${libraryId}-${zoteroKey}`, 1);
        }
        setTimeout(() => setClickedButton(null), 100);
    }, [
        isProcessing,
        hasPendingApprovals,
        pendingApprovalsForGroup,
        reapplicableActions,
        libraryId,
        zoteroKey,
        sendApprovalResponse,
        removePendingApproval,
        rejectAgentAction,
    ]);

    /**
     * Undo all applied edits in the group, in reverse order. Edits applied
     * later may have shifted text positions, so undoing newest-first keeps
     * each undo's old_string matchable.
     */
    const handleUndoAll = useCallback(async () => {
        if (isProcessing) return;
        const appliedActions = allActions.filter((a) => a.status === 'applied');
        if (appliedActions.length === 0) return;

        setIsProcessing(true);
        setClickedButton('undo');
        // Clear any prior errors for the actions we're about to retry so the
        // banners disappear during the attempt; failures will repopulate them.
        setPerEditUndoErrors((prev) => {
            const next = { ...prev };
            for (const a of appliedActions) {
                if (a.toolcall_id) delete next[a.toolcall_id];
            }
            return next;
        });
        const newFailures: Record<string, string> = {};
        try {
            // Dismiss any active diff preview before undoing
            if (isDiffPreviewActive()) {
                await dismissDiffPreview();
                store.set(diffPreviewNoteKeyAtom, null);
            }

            // Reverse order — newest first
            const reversed = [...appliedActions].reverse();
            for (const action of reversed) {
                try {
                    await undoEditNoteAction(action);
                    undoAgentAction(action.id);
                    logger(`EditNoteGroupView: Undone edit_note action ${action.id}`, 1);
                } catch (error: any) {
                    const errorMessage = error?.message || 'Failed to undo edit_note';
                    const stackTrace = error?.stack || '';
                    logger(`EditNoteGroupView: Failed to undo edit_note action ${action.id}: ${errorMessage}\n${stackTrace}`, 1);
                    // Mirror AgentActionView.handleUndo: for edit_note we keep
                    // the action in 'applied' state and surface a friendly
                    // banner instead of flipping it to 'error'. The note may
                    // have been modified externally — the action is still
                    // semantically applied, and the user can retry or revert
                    // manually in the editor.
                    if (action.toolcall_id) {
                        newFailures[action.toolcall_id] = errorMessage;
                    }
                }
            }
        } finally {
            setIsProcessing(false);
            setClickedButton(null);
            const failureCount = Object.keys(newFailures).length;
            if (failureCount > 0) {
                setPerEditUndoErrors((prev) => ({ ...prev, ...newFailures }));
                // Auto-expand so the per-edit banners are visible — otherwise
                // a collapsed group would silently swallow the failures.
                setExpanded({ key: expansionKey, expanded: true });
                logger(`EditNoteGroupView: ${failureCount} edit_note undo(s) failed for ${libraryId}-${zoteroKey}`, 1);
            }
        }
    }, [
        isProcessing,
        allActions,
        libraryId,
        zoteroKey,
        undoAgentAction,
        setExpanded,
        expansionKey,
    ]);

    /**
     * Retry all errored edits in the group. Mirrors single
     * `AgentActionView.handleRetry` for the apply-error case: re-runs
     * `executeEditNoteAction` for each action in `'error'` state. Successes
     * flip to `'applied'`; persistent failures stay in `'error'` so the
     * user can retry again.
     */
    const handleRetryAll = useCallback(async () => {
        if (isProcessing) return;
        if (errorActions.length === 0) return;

        setIsProcessing(true);
        setClickedButton('retry');
        try {
            // Dismiss any active diff preview before retrying — same reason
            // as the single edit_note path: the preview freezes the editor.
            if (isDiffPreviewActive()) {
                await dismissDiffPreview();
                store.set(diffPreviewNoteKeyAtom, null);
            }

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
            setIsProcessing(false);
            setClickedButton(null);
        }
    }, [
        isProcessing,
        errorActions,
        runId,
        ackAgentActions,
        setAgentActionsToError,
    ]);

    /**
     * Receives undo error updates from child AgentActionViews when the user
     * uses the per-edit Undo button. Keeps the parent's error map as the
     * single source of truth so failures from either entry point land in the
     * same place.
     */
    const handleChildUndoErrorChange = useCallback(
        (childToolcallId: string, error: string | null) => {
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
                // Make sure the failing row is visible.
                setExpanded({ key: expansionKey, expanded: true });
            }
        },
        [setExpanded, expansionKey],
    );

    // Prune stale per-edit undo errors when actions are no longer 'applied'
    // (e.g. a child's undo eventually succeeded after a previous failure).
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

    /**
     * Open the note in editor and show the diff preview for the edits in
     * THIS group only.
     *
     * Two paths, both group-scoped (never aggregates across other groups
     * targeting the same note):
     *   - Mid-run (pending approvals): build edits from
     *     `pendingApprovalsForGroup` only and call `showDiffPreview` directly.
     *     Banner Apply/Reject route to this group's `handleApplyAll` /
     *     `handleRejectAll`.
     *   - Post-run (rejected/undone/pending actions): build edits from
     *     `action.proposed_data` for this group's `reapplicableActions`.
     *     Same `onAction` wiring.
     */
    const handlePreviewInEditor = useCallback(async () => {
        // Build edits from the appropriate source — pending approvals if
        // we're mid-run, otherwise from the actions themselves.
        const edits: EditOperation[] = [];
        if (hasPendingApprovals) {
            for (const pa of pendingApprovalsForGroup) {
                const oldStr = (pa.actionData?.old_string as string | undefined) ?? '';
                const newStr = (pa.actionData?.new_string as string | undefined) ?? '';
                const operation = (pa.actionData?.operation ?? 'str_replace') as EditOperation['operation'];
                if (operation === 'rewrite' || oldStr) {
                    edits.push({ oldString: oldStr, newString: newStr, operation });
                }
            }
        } else {
            for (const action of reapplicableActions) {
                const oldStr = (action.proposed_data?.old_string as string | undefined) ?? '';
                const newStr = (action.proposed_data?.new_string as string | undefined) ?? '';
                const operation = (action.proposed_data?.operation ?? 'str_replace') as EditOperation['operation'];
                if (operation === 'rewrite' || oldStr) {
                    edits.push({ oldString: oldStr, newString: newStr, operation });
                }
            }
        }
        if (edits.length === 0) {
            logger(`EditNoteGroupView: handlePreviewInEditor — no previewable edits for ${libraryId}-${zoteroKey}`, 1);
            return;
        }

        await openNoteByKey(libraryId, zoteroKey);
        // Wait briefly for the editor instance to be ready
        await new Promise<void>((resolve) => {
            let attempts = 0;
            const check = () => {
                if (isNoteOpenInEditor(libraryId, zoteroKey)) {
                    resolve();
                } else if (++attempts > 25) {
                    resolve();
                } else {
                    setTimeout(check, 200);
                }
            };
            setTimeout(check, 300);
        });

        showDiffPreview(libraryId, zoteroKey, edits, {
            onAction: (bannerAction) => {
                if (bannerAction === 'approve') {
                    handleApplyAll();
                } else {
                    handleRejectAll();
                }
            },
        });
    }, [
        hasPendingApprovals,
        pendingApprovalsForGroup,
        reapplicableActions,
        libraryId,
        zoteroKey,
        handleApplyAll,
        handleRejectAll,
    ]);

    const toggleExpanded = useCallback(() => {
        setExpanded({ key: expansionKey, expanded: !isExpanded });
    }, [setExpanded, expansionKey, isExpanded]);

    // ---------------------------------------------------------------------
    // Rendering
    // ---------------------------------------------------------------------

    const baseConfig = STATUS_CONFIGS[aggregateStatus];

    // Header icon: same logic as single AgentActionView
    const headerIcon = (() => {
        if (isHovered && isExpanded) return ArrowDownIcon;
        if (isHovered && !isExpanded) return ArrowRightIcon;
        if (aggregateStatus === 'awaiting') return EditIcon;
        if (baseConfig.icon === null) return EditIcon;
        return baseConfig.icon;
    })();
    const shouldShowStatusIconClass =
        !isHovered && (baseConfig.icon !== null || aggregateStatus !== 'awaiting');

    // Bold label, e.g. "3 Note Edits". Singular fallback ("Note Edit") never
    // applies in practice — the group only renders for 2+ same-note edits —
    // but kept for safety.
    const groupLabel = editCount === 1 ? 'Note Edit' : `${editCount} Note Edits`;

    // Collapsed-header right slot only shows during the active approval flow
    // (mirrors single AgentActionView's collapsed-header buttons). Outer
    // `!isProcessing` is intentionally OMITTED — the inner per-button gate
    // `(!isProcessing || clickedButton === 'X')` keeps the active button
    // mounted with its loading spinner.
    const showCollapsedHeaderActions =
        aggregateStatus === 'awaiting' || aggregateStatus === 'pending';

    // Footer button visibility — driven by *what is available in the group*
    // instead of by aggregate status. This is the key difference from single
    // AgentActionView: a group can be in a mixed state (e.g. 2 applied + 1
    // undone), and we want both Apply All and Undo All to show so the user
    // can act on each subset without expanding.
    //
    // - Apply All: visible whenever there's any reapplicable edit
    //   (pending / rejected / undone), regardless of how many are already
    //   applied.
    // - Reject All: visible when there's something to reject — pending
    //   approvals (mid-run) or pending actions (post-run). Already-rejected
    //   and undone actions can't be re-rejected (matches single edit).
    // - Undo All: visible whenever any child is currently applied.
    // - Retry All: visible whenever any child is in `error` state.
    //
    // The outer `!isProcessing` guard is intentionally absent here — the
    // inner per-button `(!isProcessing || clickedButton === 'X')` gate keeps
    // the *active* button mounted with `loading={true}` while the OTHER
    // buttons disappear during processing. Without this, clicking Apply All
    // unmounts the button immediately and the spinner never renders.
    const rejectableActionCount = useMemo(
        () =>
            pendingApprovalsForGroup.length +
            allActions.filter((a) => a.status === 'pending').length,
        [pendingApprovalsForGroup, allActions],
    );

    const showFooterApply =
        reapplicableActions.length > 0 || hasPendingApprovals;
    const showFooterReject = rejectableActionCount > 0;
    const showFooterUndo = appliedCount > 0;
    const showFooterRetry = errorCount > 0;

    // Preview button: visible whenever there's an unapplied edit to preview.
    // Includes mid-run pending approvals AND post-run rejected/undone.
    const canShowPreview =
        DIFF_PREVIEW_ENABLED &&
        (hasPendingApprovals || reapplicableActions.length > 0);

    return (
        <div
            className="agent-action-view agent-action-group rounded-md flex flex-col min-w-0 border-popup mb-2"
            data-edit-count={editCount}
            data-note-key={`${libraryId}-${zoteroKey}`}
        >
            {/* Header */}
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
                                className={shouldShowStatusIconClass ? baseConfig.iconClassName : undefined}
                            />
                        </div>
                        <div className="two-line-header">
                            <span className="font-color-primary font-medium">{groupLabel}</span>
                            {noteTitle && (
                                <>
                                    <span className="font-color-secondary ml-15">{noteTitle}</span>
                                    {'\u00A0'}
                                    <Tooltip content="Open note" singleLine>
                                        <span
                                            className="font-color-secondary scale-10"
                                            style={{ display: 'inline-flex', verticalAlign: 'middle', cursor: 'pointer' }}
                                            role="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                e.preventDefault();
                                                openNoteByKey(libraryId, zoteroKey);
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

                {/* Expand/Collapse chevron — visible when not awaiting/pending */}
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

                {/* Compact Reject/Apply icon buttons in collapsed-header right slot */}
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

            {/* Expanded content: per-edit AgentActionViews + group action footer */}
            {isExpanded && (
                <div className="display-flex flex-col">
                    <div className="display-flex flex-col">
                        {parts.map((part, idx) => (
                            <div
                                key={`tool-${part.tool_call_id}`}
                                className={idx > 0 ? 'border-top-quinary' : undefined}
                            >
                                <AgentActionView
                                    toolcallId={part.tool_call_id}
                                    toolName="edit_note"
                                    runId={runId}
                                    responseIndex={responseIndex}
                                    pendingApproval={getPendingApproval(part.tool_call_id)}
                                    hasToolReturn={false}
                                    isInGroup={true}
                                    disabled={isProcessing}
                                    externalUndoError={perEditUndoErrors[part.tool_call_id] ?? null}
                                    onUndoErrorChange={handleChildUndoErrorChange}
                                />
                            </div>
                        ))}
                    </div>

                    {/* Group action footer.

                        Each per-button visibility uses the inner spinner
                        pattern: outer guard is `showFooterX` (driven by
                        availability), inner guard is
                        `(!isProcessing || clickedButton === 'X')` so the
                        active button stays mounted with `loading={true}`
                        while the OTHERS disappear during processing. */}
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
