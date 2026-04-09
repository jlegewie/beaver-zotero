import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { ToolCallPart, AgentRunStatus } from '../../agents/types';
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
} from '../../utils/noteEditorDiffPreview';
import {
    DIFF_PREVIEW_ENABLED,
    diffPreviewNoteKeyAtom,
    updateDiffPreviewForNote,
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
    runStatus: AgentRunStatus;
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
    runStatus,
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
    // Default: expanded while approval is pending so users can see what they're approving
    const isExpanded = expansionState[expansionKey] ?? hasPendingApprovals;

    // Initialize expansion state on first mount if not already set elsewhere
    useEffect(() => {
        if (!hasExistingExpandState) {
            setExpanded({ key: expansionKey, expanded: hasPendingApprovals });
        }
        // Run only when group identity changes
    }, [expansionKey]);

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
    const [clickedButton, setClickedButton] = useState<'approve' | 'reject' | 'undo' | null>(null);

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

            // Post-run: execute pending actions one at a time
            const pendingActions = allActions.filter((a) => a.status === 'pending');
            if (pendingActions.length === 0) return;

            // Dismiss any active diff preview before applying — same reason
            // as the single edit_note path: the preview freezes the editor.
            if (isDiffPreviewActive()) {
                await dismissDiffPreview();
                store.set(diffPreviewNoteKeyAtom, null);
            }

            for (const action of pendingActions) {
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
        allActions,
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
     * Reject all pending approvals (mid-run) or all pending actions
     * (post-run) in the group.
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
            const pendingActions = allActions.filter((a) => a.status === 'pending');
            for (const action of pendingActions) {
                rejectAgentAction(action.id);
            }
            logger(`EditNoteGroupView: Rejected ${pendingActions.length} pending edit_note actions for ${libraryId}-${zoteroKey}`, 1);
        }
        setTimeout(() => setClickedButton(null), 100);
    }, [
        isProcessing,
        hasPendingApprovals,
        pendingApprovalsForGroup,
        allActions,
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
        allActions,
        undoAgentAction,
        setAgentActionsToError,
    ]);

    /**
     * Open the note in editor and show the aggregated diff preview for all
     * pending edits to this note.
     */
    const handlePreviewInEditor = useCallback(async () => {
        if (!hasPendingApprovals) return;
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
        updateDiffPreviewForNote(libraryId, zoteroKey);
    }, [hasPendingApprovals, libraryId, zoteroKey]);

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

    const showApplyButtons = (aggregateStatus === 'awaiting' || aggregateStatus === 'pending') && !isProcessing;
    const showRejectButton = showApplyButtons;
    const showUndoButton =
        appliedCount > 0 && (aggregateStatus === 'applied' || (isProcessing && clickedButton === 'undo'));
    const canShowPreview =
        DIFF_PREVIEW_ENABLED && hasPendingApprovals;

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
                            {noteTitle && <span className="font-color-secondary ml-15">{noteTitle}</span>}
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
                        </div>
                    </div>
                </button>

                <div className="flex-1" />

                {/* Expand chevron — visible when not awaiting/pending */}
                <div
                    className="display-flex flex-row items-center gap-25 mr-2 mt-015"
                    style={{ visibility: !(aggregateStatus === 'awaiting' || aggregateStatus === 'pending') ? 'visible' : 'hidden' }}
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

                {/* Compact Reject/Apply icon buttons in collapsed-header right slot */}
                {showApplyButtons && (
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
                                />
                            </div>
                        ))}
                    </div>

                    {/* Group action footer */}
                    {(showApplyButtons || showRejectButton || showUndoButton || canShowPreview) && (
                        <div className="display-flex flex-row gap-2 px-2 py-2">
                            <div className="flex-1" />

                            {canShowPreview && (
                                <Button
                                    variant="ghost"
                                    icon={FileDiffIcon}
                                    onClick={handlePreviewInEditor}
                                    style={{ padding: '3px 6px' }}
                                >
                                    Preview
                                </Button>
                            )}

                            {showRejectButton && (!isProcessing || clickedButton === 'reject') && (
                                <Button
                                    variant="outline"
                                    onClick={handleRejectAll}
                                    loading={isProcessing && clickedButton === 'reject'}
                                    disabled={isProcessing}
                                >
                                    Reject All
                                </Button>
                            )}

                            {showUndoButton && (
                                <Button
                                    variant="outline"
                                    onClick={handleUndoAll}
                                    loading={isProcessing && clickedButton === 'undo'}
                                    disabled={isProcessing}
                                >
                                    Undo All
                                </Button>
                            )}

                            {showApplyButtons && (!isProcessing || clickedButton === 'approve') && (
                                hasPendingApprovals ? (
                                    <SplitApplyButton
                                        onApply={handleApplyAll}
                                        onApplyAll={handleApproveAllForNote}
                                        loading={isProcessing && clickedButton === 'approve'}
                                        disabled={isProcessing}
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
