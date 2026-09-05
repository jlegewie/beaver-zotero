import React, { useState, useCallback, useEffect, useRef } from 'react';
import { navigateToAnnotation } from '../../../utils/readerUtils';
import { useAtomValue, useSetAtom } from 'jotai';
import { AgentRunStatus } from '@beaver/agent-core/agents/types';
import {
    AgentAction,
    getAgentActionsByToolcallAtom,
    removePendingApprovalAtom,
    isCreateAnnotationsAgentAction,
} from '../../../agents/agentActions';
import type { PendingApproval } from '@beaver/agent-ui/host';
import {
    setRunPermissionModeAtom,
    approvalResponseIntentsAtom,
    isWSChatPendingAtom,
    removeApprovalResponseIntentAtom,
    sendApprovalResponseAtom,
} from '../../../atoms/agentRunAtoms';
import {
    agentActionItemTitlesAtom,
    getAgentActionItemTitleKey,
    setAgentActionItemTitleAtom,
    toolExpandedAtom,
    setToolExpandedAtom,
} from '../../../atoms/messageUIState';
import {
    applyAgentActionsAtom,
    rejectAgentActionsAtom,
    undoAgentActionsAtom,
} from '../agentActionExecution';
import { shortItemTitle } from '../../../../src/utils/zoteroUtils';
import { resolveItemReference, resolveLibraryRef } from '../../../../src/utils/libraryIdentity';
import { notifyReferenceUnavailable } from '../sourceActions';
import {
    TickIcon,
    CancelIcon,
    ChevronIcon,
    Spinner,
    Icon,
    RepeatIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    ArrowUpRightIcon,
} from '../../../components/icons/icons';
import { revealSource, openNoteByKey, getCurrentCollectionKeyForItem } from '../../../utils/sourceUtils';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import DeferredToolPreferenceButton from '../../../components/ui/buttons/DeferredToolPreferenceButton';
import RunPermissionButton, { RunPermissionMode } from '../../../components/ui/buttons/RunPermissionButton';
import {
    ActionStatus,
    STATUS_CONFIGS,
    NEVER_AUTO_COLLAPSE_TOOLS,
    getOverallStatus,
    getActionLabel,
    getActionTitle,
    buildPreviewData,
    PreviewData,
    getCreateAnnotationsDisplayStatus,
    getAgentActionToolIcon,
    inFlightProgressMessage,
} from './agentActionViewHelpers';
import { ActionPreview } from './ActionPreview';
import { useApprovalRecovery } from './useApprovalRecovery';
import {
    isCoveredByFullAccess,
    isFullAccessGrantedForRun,
    runApprovalPolicyAtom,
} from '../../../atoms/runApprovalPolicy';
import { dismissActiveEditNotePreview } from '../editNotePreviewLifecycle';

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
    /** Progress note posted on the tool call while the backend waits on Zotero. */
    progress?: string;
}

type HeaderLinkAction = {
    tooltip: string;
    onClick: () => void | Promise<void>;
};

type HeaderLinkActionRule = HeaderLinkAction & {
    matches: () => boolean;
};

export const AgentActionView: React.FC<AgentActionViewProps> = ({
    toolcallId,
    toolName,
    runId,
    responseIndex,
    pendingApproval: pendingApprovalProp,
    hasToolReturn = false,
    streamingArgs,
    runStatus,
    progress,
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
    const setRunPermissionMode = useSetAtom(setRunPermissionModeAtom);
    const runApprovalPolicy = useAtomValue(runApprovalPolicyAtom);
    const removeApprovalResponseIntent = useSetAtom(removeApprovalResponseIntentAtom);
    const removePendingApproval = useSetAtom(removePendingApprovalAtom);
    const applyAgentActions = useSetAtom(applyAgentActionsAtom);
    const rejectAgentActions = useSetAtom(rejectAgentActionsAtom);
    const undoAgentActions = useSetAtom(undoAgentActionsAtom);

    // Shared with the terminal review row for this tool call. The run belongs
    // in the identity because continuation runs may reuse tool-call ids.
    const itemTitleKey = getAgentActionItemTitleKey(runId, toolcallId);
    const itemTitleMap = useAtomValue(agentActionItemTitlesAtom);
    const itemTitle = itemTitleMap[itemTitleKey] ?? null;
    const setItemTitle = useSetAtom(setAgentActionItemTitleAtom);

    const hasAssociatedItem =
        toolName === 'edit_metadata' ||
        toolName === 'edit_item' ||
        toolName === 'create_highlight_annotations' ||
        toolName === 'create_note_annotations';

    useEffect(() => {
        if (!hasAssociatedItem || itemTitle) return;

        const fetchTitle = async () => {
            const libraryId: number | undefined =
                action?.proposed_data?.resolved_ref?.library_id ??
                action?.proposed_data?.library_id ??
                pendingApproval?.actionData?.library_id;
            const libraryRef: string | undefined =
                action?.proposed_data?.resolved_ref?.library_ref ??
                action?.proposed_data?.library_ref ??
                pendingApproval?.actionData?.library_ref;
            const zoteroKey: string | undefined =
                action?.proposed_data?.resolved_ref?.zotero_key ??
                action?.proposed_data?.zotero_key ??
                pendingApproval?.actionData?.zotero_key;

            if (!libraryId || !zoteroKey) return;

            const resolved = await resolveItemReference({ library_ref: libraryRef, library_id: libraryId, zotero_key: zoteroKey });
            if (resolved.status === 'found') {
                const title = await shortItemTitle(resolved.item);
                setItemTitle({ key: itemTitleKey, title });
            }
        };

        fetchTitle();
    }, [action, pendingApproval, itemTitle, itemTitleKey, hasAssociatedItem, setItemTitle]);

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
        label: `AgentActionView(${toolName})`,
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
                // surface (Approve All, the composer, the diff-preview banner)
                // can miss its window exactly like one made here.
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

    const isProcessing = isProcessingApproval || isProcessingAction || isExternallyProcessing;
    const actionDisplayStatus = action ? getCreateAnnotationsDisplayStatus(action) : null;
    const status: ActionStatus | 'awaiting' = (isAwaitingApproval || isProcessing)
        ? 'awaiting'
        : isMultiAction
            ? getOverallStatus(actions)
            : (actionDisplayStatus ?? action?.status ?? 'pending');
    const isConfirmExtraction = toolName === 'confirm_extraction';
    const isConfirmExternalSearch = toolName === 'confirm_external_search';
    const isConfirmAction = isConfirmExtraction || isConfirmExternalSearch;
    const hasNoActionData = !action && !pendingApproval && !isStreaming;
    const baseConfig = STATUS_CONFIGS[status];
    const config = (isConfirmAction && status !== 'awaiting')
        ? { ...baseConfig, showApply: false, showReject: false, showUndo: false, showRetry: false }
        : baseConfig;

    // Every action on this card has settled, but the tool call has not returned:
    // the backend is still working on it (`create_items` holds its result while
    // background PDF fetches finish). The run-level status line is suppressed
    // for as long as any tool call is outstanding — see `shouldShowRunStatus` —
    // on the assumption that the call's own card reports the wait, so without a
    // spinner here the pane looks frozen. Excludes `pending`, where the card is
    // waiting on the reader rather than on the backend.
    const isAwaitingToolReturn =
        runStatus === 'in_progress' &&
        !hasToolReturn &&
        status !== 'awaiting' &&
        status !== 'pending';

    // The wait this reports is the backend's, not the user's: an approved edit
    // whose save is taking Zotero a long time. Suppressed while the card waits
    // on the user (`isAwaitingApproval`) and once the action has settled, since
    // the note outlives the request that produced it.
    const progressMessage = inFlightProgressMessage(
        progress,
        runStatus === 'in_progress'
        && !hasToolReturn
        && !isAwaitingApproval
        && (status === 'awaiting' || status === 'pending'),
    );

    const handleApprove = useCallback(() => {
        if (!pendingApproval) return;
        setIsProcessingApproval(true);
        setProcessingApproval({ actionId: pendingApproval.actionId, kind: 'approve' });
        setClickedButton('approve');
        sendApprovalResponse({ actionId: pendingApproval.actionId, approved: true });
        removePendingApproval(pendingApproval.actionId);
    }, [pendingApproval, sendApprovalResponse, removePendingApproval]);

    const handleReject = useCallback(() => {
        if (!pendingApproval) return;
        setIsProcessingApproval(true);
        setProcessingApproval({ actionId: pendingApproval.actionId, kind: 'reject' });
        setClickedButton('reject');
        sendApprovalResponse({ actionId: pendingApproval.actionId, approved: false });
        removePendingApproval(pendingApproval.actionId);
    }, [pendingApproval, sendApprovalResponse, removePendingApproval]);

    // Switching to full access answers every covered card in the run, this one
    // included, so the click is tracked as an approval of it — the card stays in
    // its "sending" state until the run comes back, exactly as a direct Apply
    // would. A card the grant does not cover keeps its own controls instead.
    const handleRunPermissionChange = useCallback(async (mode: RunPermissionMode) => {
        const fullAccess = mode === 'full_access';
        if (!fullAccess) {
            setRunPermissionMode({ runId, fullAccess: false });
            return;
        }
        const answersThisCard = pendingApproval !== null
            && isCoveredByFullAccess(pendingApproval.actionType, pendingApproval.actionData);
        if (answersThisCard) {
            setIsProcessingApproval(true);
            setProcessingApproval({ actionId: pendingApproval.actionId, kind: 'approve' });
            setClickedButton('approve');
        }
        // The sweep can answer a note edit whose diff preview is live in the
        // editor, even from a card of another tool, so tear it down first — as
        // every other surface that applies or rejects an action does. The grant
        // is applied either way: a teardown that fails must not strand the card
        // on a decision the user has already made.
        let approvedCount = 0;
        try {
            await dismissActiveEditNotePreview();
        } finally {
            approvedCount = setRunPermissionMode({ runId, fullAccess: true });
        }
        // Refused when the run ended while the preview was being torn down.
        // Nothing was sent, so release the card rather than leaving it waiting
        // for a reply that cannot come.
        if (answersThisCard && approvedCount === 0) {
            setIsProcessingApproval(false);
            setProcessingApproval(null);
            setClickedButton(null);
        }
    }, [pendingApproval, setRunPermissionMode, runId, setProcessingApproval]);

    const handleApplyPending = useCallback(async () => {
        if (actions.length === 0 || isProcessing) return;

        setIsUndoError(false);
        setIsProcessingAction(true);
        setClickedButton('approve');
        try {
            await applyAgentActions({ actions, runId });
        } finally {
            setIsProcessingAction(false);
            setClickedButton(null);
        }
    }, [actions, isProcessing, runId, applyAgentActions]);

    const handleRejectPending = useCallback(() => {
        if (actions.length === 0 || isProcessing) return;

        setClickedButton('reject');
        rejectAgentActions({ actions: isMultiAction ? actions : [action!] });
        setTimeout(() => setClickedButton(null), 100);
    }, [action, actions, isProcessing, isMultiAction, rejectAgentActions]);

    const handleUndo = useCallback(async () => {
        if (!action || isProcessing) return;

        setIsProcessingAction(true);
        setClickedButton('undo');
        try {
            const result = await undoAgentActions({ actions });
            if (result.fatalError) setIsUndoError(true);
        } finally {
            setIsProcessingAction(false);
            setClickedButton(null);
        }
    }, [action, actions, isProcessing, undoAgentActions]);

    const handleRetry = useCallback(async () => {
        if (isUndoError) {
            setIsUndoError(false);
            await handleUndo();
        } else {
            await handleApplyPending();
        }
    }, [isUndoError, handleUndo, handleApplyPending]);

    const handleRevealNote = useCallback(async () => {
        const libraryId = action?.result_data?.library_id;
        const zoteroKey = action?.result_data?.zotero_key;
        const libraryRef = action?.result_data?.library_ref;
        if (!libraryId || !zoteroKey) return;
        // Reveal within the current collection when the note belongs to it,
        // instead of switching to the library root.
        const collectionKey = await getCurrentCollectionKeyForItem(libraryId, zoteroKey);
        revealSource({ library_id: libraryId, zotero_key: zoteroKey, library_ref: libraryRef }, collectionKey);
    }, [action]);

    const toggleExpanded = () => setExpanded({ key: expansionKey, expanded: !isExpanded });
    const previewData = buildPreviewData(toolName, pendingApproval, action);
    const runPermissionMode: RunPermissionMode =
        isFullAccessGrantedForRun(runApprovalPolicy, runId) ? 'full_access' : 'ask';

    const getHeaderIcon = () => {
        if (isAwaitingApproval) return getAgentActionToolIcon(toolName);
        if (isAwaitingToolReturn) return Spinner;
        if (isHovered && isExpanded) return ArrowDownIcon;
        if (isHovered && !isExpanded) return ArrowRightIcon;
        if (config.icon === null) return getAgentActionToolIcon(toolName);
        return config.icon;
    };

    const shouldShowStatusIcon = () => {
        if (isHovered) return false;
        // A spinner stands in for the status icon while the tool call is open,
        // and the status icon's own colour and scale are not its to wear.
        if (isAwaitingToolReturn) return false;
        return config.icon !== null || !isAwaitingApproval;
    };

    const actionTitle = getActionTitle(toolName, action?.proposed_data, itemTitle, actions);
    const bulkAnnotationRevealRef = action && isCreateAnnotationsAgentAction(action)
        ? action.proposed_data.resolved_ref
        : null;
    const headerLinkActionRules: HeaderLinkActionRule[] = [
        {
            matches: () => (
                toolName === 'create_note' &&
                action?.status === 'applied' &&
                !!action?.result_data?.library_id &&
                !!action?.result_data?.zotero_key
            ),
            tooltip: 'Open note',
            onClick: () => {
                // Resolve through the device-portable library_ref so a note created
                // in a group library on another computer opens the right local item.
                const libraryId = resolveLibraryRef({
                    library_ref: action!.result_data!.library_ref,
                    library_id: action!.result_data!.library_id,
                });
                if (libraryId) void openNoteByKey(libraryId, action!.result_data!.zotero_key);
                else notifyReferenceUnavailable('item', 'library_unavailable');
            },
        },
        {
            matches: () => (
                (toolName === 'create_highlight_annotations' || toolName === 'create_note_annotations')&&
                action?.status === 'applied' &&
                action?.result_data?.created?.length > 0
            ),
            tooltip: 'Open annotation',
            onClick: async () => {
                const firstCreated = action!.result_data!.created[0];
                const resolved = await resolveItemReference({
                    library_ref: firstCreated.library_ref,
                    library_id: firstCreated.library_id,
                    zotero_key: firstCreated.zotero_key,
                });
                if (resolved.status === 'found') {
                    await navigateToAnnotation(resolved.item as Zotero.Item);
                } else {
                    notifyReferenceUnavailable('annotation', resolved.status === 'library_unavailable' ? 'library_unavailable' : 'missing');
                }
            },
        },
    ];

    const defaultHeaderLinkAction: HeaderLinkAction | null = (() => {
        const revealRef = bulkAnnotationRevealRef ?? {
            library_id: action?.proposed_data?.library_id,
            zotero_key: action?.proposed_data?.zotero_key,
            library_ref: action?.proposed_data?.library_ref,
        };
        if (!revealRef.library_id || !revealRef.zotero_key) return null;

        return {
            tooltip: 'Reveal in Zotero',
            onClick: () => {
                revealSource({
                    library_id: revealRef.library_id,
                    zotero_key: revealRef.zotero_key,
                    library_ref: revealRef.library_ref,
                });
            },
        };
    })();
    const headerLinkAction = headerLinkActionRules.find((rule) => rule.matches()) ?? defaultHeaderLinkAction;

    if (isStreaming) {
        const effectiveArgs = streamingArgs ?? {};
        const streamingTitle = getActionTitle(toolName, effectiveArgs, itemTitle, undefined);
        const streamingPreviewData: PreviewData = {
            actionType: toolName,
            actionData: effectiveArgs,
        };

        return (
            <div className="agent-action-view rounded-card flex flex-col min-w-0 border-card mb-2">
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
                                <span className="font-color-primary font-medium" style={{ fontWeight: '500' }}>{getActionLabel(toolName, effectiveArgs)}</span>
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
        <div className="agent-action-view rounded-card flex flex-col min-w-0 border-card mb-2">
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
                        <div className="display-flex flex-col min-w-0 gap-1">
                            <div className={`two-line-header${isAwaitingToolReturn ? ' shimmer-text' : ''}`}>
                                {/* Label off the same data the preview renders: a
                                    count-carrying label would otherwise read as
                                    singular while an approval is still pending and
                                    no action row exists yet. */}
                                <span className="font-color-primary font-medium">{getActionLabel(toolName, previewData?.actionData ?? action?.proposed_data)}</span>
                                {actionTitle && <span className="font-color-secondary ml-15">{actionTitle}</span>}
                                {headerLinkAction && (
                                    <>
                                        {'\u00A0'}
                                        <Tooltip content={headerLinkAction.tooltip} singleLine>
                                            <span
                                                className="font-color-secondary scale-10"
                                                style={{ display: 'inline-flex', verticalAlign: 'middle', cursor: 'pointer' }}
                                                role="button"
                                                onClick={async (e) => {
                                                    e.stopPropagation();
                                                    e.preventDefault();
                                                    await headerLinkAction.onClick();
                                                }}
                                            >
                                                <Icon icon={ArrowUpRightIcon} />
                                            </span>
                                        </Tooltip>
                                    </>
                                )}
                            </div>
                            {progressMessage && (
                                <span className="font-color-tertiary shimmer-text">{progressMessage}</span>
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
                        {/* A cost confirmation has no permission control to offer:
                            what a request may spend is set once by the credit
                            limit. While the run is waiting on this card the
                            control is about this run; once it is not, there is
                            no run left to grant, so it goes back to being the
                            standing per-tool preference. */}
                        {isAwaitingApproval && !hasNoActionData && !isConfirmAction && (
                            <RunPermissionButton
                                mode={runPermissionMode}
                                onChange={handleRunPermissionChange}
                                disabled={isProcessing}
                            />
                        )}
                        {!isAwaitingApproval && status === 'pending' && !hasNoActionData && !isConfirmAction && (
                            <DeferredToolPreferenceButton
                                toolName={toolName}
                                disabled={toolName === 'delete_annotations'}
                                tooltipContent={
                                    toolName === 'delete_annotations'
                                        ? 'The approval preference cannot be changed for annotation deletion'
                                        : undefined
                                }
                            />
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

                        {toolName === 'create_note' && action?.status === 'applied' && action?.result_data?.library_id && action?.result_data?.zotero_key && (
                            <Button
                                variant="outline"
                                onClick={handleRevealNote}
                                disabled={isProcessing}
                            >
                                Reveal
                            </Button>
                        )}

                        {(config.showUndo || (isProcessing && clickedButton === 'undo')) && (
                            <Button
                                variant="outline"
                                onClick={handleUndo}
                                loading={isProcessing && clickedButton === 'undo'}
                                disabled={isProcessing}
                            >
                                {toolName === 'create_note' ? 'Delete' : 'Undo'}
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
