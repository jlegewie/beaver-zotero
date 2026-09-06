/**
 * The card the closed-sidebar status popup shows for the open thread, derived
 * from live run state — or from the dev preview when one is set.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { AgentRun, ToolCallPart } from '@beaver/agent-core/agents/types';
import { isRunActive } from '@beaver/agent-core/agents/types';
import {
    activeRunAtom,
    allRunsAtom,
    currentThreadNameAtom,
    lastRunSummaryAtom,
    resumeChainAtom,
    toolResultsMapAtom,
    wsReconnectingAtom,
    wsRetryAtom,
} from '@beaver/agent-core/run-state/atoms';
import { getToolCallLabel, type ToolCallLabelEnrich } from '@beaver/agent-core/run-state/toolLabels';
import { runStatusText } from '@beaver/agent-core/run-state/runStatusCopy';
import { getRunErrorTitle } from '@beaver/agent-core/run-state/runErrorCopy';
import { pendingBatchApprovalsAtom } from '@beaver/agent-core/run-state/pendingBatchApprovals';
import {
    pendingCreditConfirmationsAtom,
    type PendingCreditConfirmation,
} from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import { pendingQuestionsAtom } from '@beaver/agent-core/run-state/pendingQuestions';
import type { PendingApproval } from '@beaver/agent-ui/host';
import { pendingApprovalsAtom } from '../../agents/agentActions';
import {
    answerPendingApprovalsAtom,
    approvalVerdictInFlightAtom,
    autoReplacementPendingRunIdsAtom,
    beginApprovalVerdictAtom,
    releaseApprovalVerdictAtom,
    sendCreditConfirmationResponseAtom,
    setRunPermissionModeAtom,
} from '../../atoms/agentRunAtoms';
import {
    getPendingApprovalIdsCoveredByFullAccess,
    isFullAccessGrantedForRun,
    runApprovalPolicyAtom,
} from '../../atoms/runApprovalPolicy';
import { isSidebarVisibleAtom } from '../../atoms/ui';
import {
    dismissRunStatusPopupCardAtom,
    runStatusPopupCompletionAtom,
    runStatusPopupDismissedAtom,
    runStatusPopupEnabledAtom,
    runStatusPopupPreviewAtom,
    type RunStatusPopupPreview,
} from '../../atoms/runStatusPopup';
import { eventManager } from '../../events/eventManager';
import { resolveToolCallLabelEnrich } from '../../utils/toolCallLabelEnrich';
import { openNoteByKey } from '../../utils/sourceUtils';
import { resolveItemReference, resolveLibraryRef } from '../../../src/utils/libraryIdentity';
import { shortItemTitle } from '../../../src/utils/zoteroUtils';
import { dismissActiveEditNotePreview } from '../../host/zotero/editNotePreviewLifecycle';
import { getActionLabel, getActionTitle } from '../../host/zotero/components/agentActionViewHelpers';
import {
    getChangesCardHeading,
    getOpenNoteTarget,
    getReviewRowKey,
    type ReviewRow,
} from '../../host/zotero/components/reviewChangeRows';
import { useArtifactRows, useChangesRows } from '../../host/zotero/components/reviewChanges/useRunActionRows';
import type { RunPermissionMode } from '../ui/buttons/RunPermissionButton';
import {
    deriveRunActivity,
    describePendingApprovals,
    MAX_COMPLETED_ARTIFACTS,
    MAX_STACK_DEPTH,
    threadDisplayName,
    type RunStatusArtifact,
    type RunStatusPopupCard,
} from './runStatusPopupModel';

const EMPTY_RUN_IDS: string[] = [];

/** Opens Beaver on the thread the card describes — today always the open one. */
function openBeaver(): void {
    eventManager.dispatch('toggleChat', { forceOpen: true });
}

/**
 * Records a run that finished while the sidebar was closed, so the completed
 * card can report it, and forgets it as soon as the sidebar is open or
 * another run has taken the thread over.
 */
function useCompletionTracking(): void {
    const summary = useAtomValue(lastRunSummaryAtom);
    const isSidebarVisible = useAtomValue(isSidebarVisibleAtom);
    const setCompletion = useSetAtom(runStatusPopupCompletionAtom);
    const previousRef = useRef(summary);

    useEffect(() => {
        const previous = previousRef.current;
        previousRef.current = summary;
        if (!summary) {
            setCompletion(null);
            return;
        }
        if (previous && previous.id !== summary.id) {
            // Another run replaced the one the card was about, or the thread
            // changed under it. Either way the record is stale.
            setCompletion(null);
        }
        const wasLive = previous?.id === summary.id && isRunActive(previous);
        if (wasLive && !isRunActive(summary) && !isSidebarVisible) {
            setCompletion({ runId: summary.id, completedAt: Date.now() });
        }
    }, [summary, isSidebarVisible, setCompletion]);

    useEffect(() => {
        if (isSidebarVisible) setCompletion(null);
    }, [isSidebarVisible, setCompletion]);
}

/**
 * Host-resolved names for the running tool call's label, resolved the way the
 * in-stream tool-call row resolves them. Null until they arrive, or for a call
 * whose label needs none.
 */
function useToolCallLabelEnrich(part: ToolCallPart | null): ToolCallLabelEnrich | null {
    const [resolved, setResolved] = useState<{ id: string; enrich: ToolCallLabelEnrich | null }>({ id: '', enrich: null });
    const toolCallId = part?.tool_call_id ?? null;
    useEffect(() => {
        if (!part || !toolCallId) return;
        let cancelled = false;
        void resolveToolCallLabelEnrich(part, null).then((enrich) => {
            if (!cancelled) setResolved({ id: toolCallId, enrich });
        });
        return () => { cancelled = true; };
        // The args are settled once the call has been issued, so its id is
        // the whole identity.
    }, [toolCallId]);
    return toolCallId && resolved.id === toolCallId ? resolved.enrich : null;
}

/** The running card's second line: what the run is doing, or the wait it is in. */
function useRunStatusLine(run: AgentRun | null): string {
    const toolResults = useAtomValue(toolResultsMapAtom);
    const retry = useAtomValue(wsRetryAtom);
    const reconnect = useAtomValue(wsReconnectingAtom);
    const activity = run ? deriveRunActivity(run, toolResults) : null;
    const toolPart = activity?.kind === 'tool' ? activity.part : null;
    const enrich = useToolCallLabelEnrich(toolPart);

    let idleLabel = 'Thinking';
    if (activity?.kind === 'generating') idleLabel = 'Generating';
    if (toolPart) idleLabel = getToolCallLabel(toolPart, 'in_progress', { enrich });
    // Live, but holding for a decision made on a card the popup does not draw.
    if (run?.status === 'awaiting_deferred') idleLabel = 'Waiting for your review';

    return runStatusText({
        reconnect,
        backendRetry: retry && run && retry.runId === run.id ? retry : null,
        idleLabel,
    });
}

const ITEM_TITLE_ACTION_TYPES = new Set([
    'edit_metadata',
    'edit_item',
    'edit_note',
    'edit_note_batch',
    'create_highlight_annotations',
    'create_note_annotations',
]);

/**
 * The title of what a single pending approval touches — the item's short
 * bibliographic name for the tools that edit one, else whatever the action
 * data names (a note title, a collection). Null while the item resolves.
 */
function useSingleApprovalTitle(approval: PendingApproval | null): string | null {
    const [itemTitle, setItemTitle] = useState<{ actionId: string; title: string | null }>({ actionId: '', title: null });
    const actionId = approval?.actionId ?? null;
    const needsItem = !!approval && ITEM_TITLE_ACTION_TYPES.has(approval.actionType);

    useEffect(() => {
        if (!approval || !actionId || !needsItem) return;
        const data = approval.actionData ?? {};
        const zoteroKey: string | undefined = data.resolved_ref?.zotero_key ?? data.zotero_key;
        const libraryId: number | undefined = data.resolved_ref?.library_id ?? data.library_id;
        const libraryRef: string | undefined = data.resolved_ref?.library_ref ?? data.library_ref;
        if (!zoteroKey || (!libraryId && !libraryRef)) return;
        let cancelled = false;
        void (async () => {
            const resolved = await resolveItemReference({ library_ref: libraryRef, library_id: libraryId, zotero_key: zoteroKey });
            if (resolved.status !== 'found') return;
            const title = await shortItemTitle(resolved.item);
            if (!cancelled) setItemTitle({ actionId, title });
        })();
        return () => { cancelled = true; };
    }, [actionId, needsItem]);

    if (!approval) return null;
    const resolvedTitle = itemTitle.actionId === approval.actionId ? itemTitle.title : null;
    return getActionTitle(approval.actionType, approval.actionData, resolvedTitle, undefined);
}

interface ApprovalControls {
    mode: RunPermissionMode;
    pendingCoveredCount: number;
    onDecide: (approved: boolean) => void;
    onPermissionChange: (mode: RunPermissionMode) => void;
    decideDisabled: boolean;
}

/**
 * The approval card's controls, bound the way the composer binds its own
 * Approve All: one verdict in flight at a time, the note diff preview torn
 * down before the answer goes out, and a full-access grant that answers every
 * covered card at once.
 */
function useApprovalControls(runId: string | null, approvals: readonly PendingApproval[]): ApprovalControls {
    const policy = useAtomValue(runApprovalPolicyAtom);
    const isVerdictInFlight = useAtomValue(approvalVerdictInFlightAtom);
    const beginVerdict = useSetAtom(beginApprovalVerdictAtom);
    const releaseVerdict = useSetAtom(releaseApprovalVerdictAtom);
    const answerPendingApprovals = useSetAtom(answerPendingApprovalsAtom);
    const setRunPermissionMode = useSetAtom(setRunPermissionModeAtom);

    const mode: RunPermissionMode = isFullAccessGrantedForRun(policy, runId) ? 'full_access' : 'ask';
    const pendingCoveredCount = useMemo(
        () => getPendingApprovalIdsCoveredByFullAccess(approvals).length,
        [approvals],
    );

    const onDecide = useCallback((approved: boolean) => {
        if (approvals.length === 0) return;
        if (!beginVerdict()) return;
        // Taken now: an approval arriving while the preview is torn down was
        // not on the card the user answered.
        const actionIds = approvals.map((approval) => approval.actionId);
        void (async () => {
            try {
                await dismissActiveEditNotePreview();
                answerPendingApprovals({ actionIds, approved });
            } finally {
                releaseVerdict();
            }
        })();
    }, [approvals, beginVerdict, releaseVerdict, answerPendingApprovals]);

    const onPermissionChange = useCallback(async (next: RunPermissionMode) => {
        if (!runId) return;
        if (next !== 'full_access') {
            setRunPermissionMode({ runId, fullAccess: false });
            return;
        }
        // The grant is applied even when the teardown fails, as on the
        // in-stream card: the user has decided.
        try {
            await dismissActiveEditNotePreview();
        } finally {
            setRunPermissionMode({ runId, fullAccess: true });
        }
    }, [runId, setRunPermissionMode]);

    return { mode, pendingCoveredCount, onDecide, onPermissionChange, decideDisabled: isVerdictInFlight };
}

/** The credit card's decision, one-shot per confirmation like the composer panel's. */
function useCreditControls(confirmation: PendingCreditConfirmation | null) {
    const sendResponse = useSetAtom(sendCreditConfirmationResponseAtom);
    const [decidedId, setDecidedId] = useState<string | null>(null);
    const confirmationId = confirmation?.confirmationId ?? null;
    const onDecide = useCallback((approved: boolean) => {
        if (!confirmationId || decidedId === confirmationId) return;
        setDecidedId(confirmationId);
        sendResponse({ confirmationId, approved });
    }, [confirmationId, decidedId, sendResponse]);
    return { onDecide, decideDisabled: confirmationId !== null && decidedId === confirmationId };
}

function artifactTitle(row: ReviewRow): string {
    const [first] = row.actions;
    return getActionTitle(row.actionType, first.proposed_data, null, row.actions)
        ?? getActionLabel(row.actionType, first.proposed_data, true);
}

function artifactOpener(row: ReviewRow): (() => void) | undefined {
    const target = getOpenNoteTarget(row);
    if (!target) return undefined;
    return () => {
        const libraryId = resolveLibraryRef(target);
        if (libraryId) void openNoteByKey(libraryId, target.zotero_key);
    };
}

interface CompletedDetails {
    run: AgentRun | null;
    artifacts: RunStatusArtifact[];
    hiddenArtifactCount: number;
    changes: string | null;
}

/**
 * What a finished answer produced and changed, from the same rows the
 * sidebar's artifacts list and changes card are built from. An answer that
 * was continued spans its whole resume chain, as those surfaces do.
 */
function useCompletedDetails(runId: string | null): CompletedDetails {
    const chain = useAtomValue(useMemo(() => resumeChainAtom(runId ?? ''), [runId]));
    const runIds = useMemo(
        () => (chain.length > 0 ? chain.map((run) => run.id) : EMPTY_RUN_IDS),
        [chain],
    );
    const artifactRows = useArtifactRows(runIds);
    const changesRows = useChangesRows(runIds);

    return useMemo(() => {
        const run = chain.length > 0 ? chain[chain.length - 1] : null;
        const shown = artifactRows.slice(0, MAX_COMPLETED_ARTIFACTS);
        return {
            run,
            artifacts: shown.map((row) => ({
                key: getReviewRowKey(row),
                title: artifactTitle(row),
                open: artifactOpener(row),
            })),
            hiddenArtifactCount: artifactRows.length - shown.length,
            changes: changesRows.length > 0 ? (getChangesCardHeading(changesRows).trail ?? '') : null,
        };
    }, [chain, artifactRows, changesRows]);
}

/**
 * Forgets the cards the user closed once another run takes the thread over:
 * a closed card is closed for its run, and the next run gets its own.
 */
function useDismissalReset(activeRunId: string | null): void {
    const setDismissed = useSetAtom(runStatusPopupDismissedAtom);
    const previousRef = useRef(activeRunId);
    useEffect(() => {
        if (previousRef.current !== activeRunId) {
            previousRef.current = activeRunId;
            setDismissed(new Set());
        }
    }, [activeRunId, setDismissed]);
}

function useLiveCard(): RunStatusPopupCard | null {
    useCompletionTracking();

    const enabled = useAtomValue(runStatusPopupEnabledAtom);
    const dismissed = useAtomValue(runStatusPopupDismissedAtom);
    const dismiss = useSetAtom(dismissRunStatusPopupCardAtom);
    const autoReplacementPendingRunIds = useAtomValue(autoReplacementPendingRunIdsAtom);
    const activeRun = useAtomValue(activeRunAtom);
    useDismissalReset(activeRun?.id ?? null);
    const threadName = useAtomValue(currentThreadNameAtom);
    const pendingApprovals = useAtomValue(pendingApprovalsAtom);
    const batchApprovals = useAtomValue(pendingBatchApprovalsAtom);
    const creditConfirmations = useAtomValue(pendingCreditConfirmationsAtom);
    const questions = useAtomValue(pendingQuestionsAtom);
    const completion = useAtomValue(runStatusPopupCompletionAtom);
    const setCompletion = useSetAtom(runStatusPopupCompletionAtom);

    // A failed run the client is already replacing is not finished, and its
    // error is about to be undone: the sidebar shows it as retrying, and so
    // does the card.
    const isAutoRetrying = !!activeRun && autoReplacementPendingRunIds.has(activeRun.id);
    const isLive = isRunActive(activeRun) || isAutoRetrying;
    const liveRun = isLive ? activeRun : null;
    const approvals = useMemo(() => [...pendingApprovals.values()], [pendingApprovals]);
    const batch = batchApprovals.values().next().value ?? null;
    const credit = creditConfirmations.values().next().value ?? null;
    const question = questions.values().next().value ?? null;

    const statusLine = useRunStatusLine(liveRun);
    const singleTitle = useSingleApprovalTitle(approvals.length === 1 ? approvals[0] : null);
    const approvalControls = useApprovalControls(liveRun?.id ?? null, approvals);
    const creditControls = useCreditControls(credit);
    const completed = useCompletedDetails(isLive ? null : completion?.runId ?? null);

    if (!enabled) return null;

    // What the card is about, so closing it hides exactly that: the working
    // state of this run, this set of approvals, this confirmation. Anything
    // else the run has to say afterwards gets a fresh card.
    const signature = liveRun
        ? approvals.length > 0
            ? `approval:${approvals.map((approval) => approval.actionId).sort().join(',')}`
            : batch ? `batch:${batch.approvalId}`
                : credit ? `credit:${credit.confirmationId}`
                    : question ? `question:${question.questionId}`
                        : `running:${liveRun.id}`
        : completion ? `completed:${completion.runId}` : null;
    if (signature && dismissed.has(signature)) return null;
    const onDismiss = () => {
        if (signature) dismiss(signature);
        if (!liveRun) setCompletion(null);
    };

    if (liveRun) {
        const base = { threadName: threadDisplayName(threadName, liveRun), stackDepth: 0, onOpen: openBeaver, onDismiss };
        if (approvals.length > 0) {
            const summary = describePendingApprovals(approvals, singleTitle);
            const plural = summary.count > 1;
            return {
                ...base,
                kind: 'approval',
                label: summary.label,
                count: summary.count,
                actionType: approvals.length === 1 ? approvals[0].actionType : null,
                permission: summary.confirmOnly
                    ? null
                    : {
                        mode: approvalControls.mode,
                        pendingCoveredCount: approvalControls.pendingCoveredCount,
                        onChange: approvalControls.onPermissionChange,
                    },
                approveLabel: summary.confirmOnly ? (plural ? 'Confirm All' : 'Confirm') : (plural ? 'Approve All' : 'Approve'),
                rejectLabel: plural ? 'Reject All' : 'Reject',
                onDecide: approvalControls.onDecide,
                decideDisabled: approvalControls.decideDisabled,
            };
        }
        if (batch) {
            return {
                ...base,
                kind: 'batch',
                title: batch.title,
                scope: [batch.scopePrimary, batch.scopeSecondary].filter(Boolean).join(' '),
            };
        }
        if (credit) {
            return {
                ...base,
                kind: 'credit',
                title: credit.title,
                message: credit.message,
                approveLabel: credit.approveLabel,
                declineLabel: credit.declineLabel,
                onDecide: creditControls.onDecide,
                decideDisabled: creditControls.decideDisabled,
            };
        }
        if (question) {
            return { ...base, kind: 'question', title: question.title?.trim() || 'Beaver has a question for you' };
        }
        return { ...base, kind: 'running', statusLine: isAutoRetrying ? 'Retrying' : statusLine };
    }

    if (completion && completed.run) {
        const run = completed.run;
        const outcome = run.status === 'error' ? 'error' : run.status === 'canceled' ? 'canceled' : 'completed';
        return {
            threadName: threadDisplayName(threadName, run),
            stackDepth: 0,
            onOpen: openBeaver,
            onDismiss,
            kind: 'completed',
            outcome,
            // The same title the run error display puts on its header.
            detail: outcome === 'error'
                ? getRunErrorTitle(run.error?.type)
                : outcome === 'canceled' ? 'Response was interrupted' : null,
            artifacts: completed.artifacts,
            hiddenArtifactCount: completed.hiddenArtifactCount,
            changes: completed.changes,
        };
    }

    return null;
}

/** A card built from the dev preview; its decisions only clear the preview. */
function usePreviewCard(preview: RunStatusPopupPreview | null): RunStatusPopupCard | null {
    const setPreview = useSetAtom(runStatusPopupPreviewAtom);
    const [mode, setMode] = useState<RunPermissionMode>('ask');
    const clear = useCallback(() => setPreview(null), [setPreview]);
    useEffect(() => { setMode('ask'); }, [preview]);

    if (!preview) return null;
    const base = {
        threadName: preview.threadName ?? 'Summarize Legewie et al. 2024 on neighborhood effects',
        stackDepth: Math.min(Math.max(preview.stackDepth ?? 0, 0), MAX_STACK_DEPTH),
        onOpen: openBeaver,
        onDismiss: clear,
    };
    switch (preview.kind) {
        case 'running':
            return { ...base, kind: 'running', statusLine: preview.statusLine ?? 'Reading Smith 2020, p. 5-10' };
        case 'approval': {
            const count = preview.count ?? 1;
            const plural = count > 1;
            return {
                ...base,
                kind: 'approval',
                label: preview.label ?? 'Edit · Smith 2014',
                count,
                actionType: count === 1 ? preview.actionType ?? 'edit_metadata' : null,
                permission: preview.showPermissionMenu === false
                    ? null
                    : { mode, pendingCoveredCount: count, onChange: setMode },
                approveLabel: preview.approveLabel ?? (plural ? 'Approve All' : 'Approve'),
                rejectLabel: preview.rejectLabel ?? (plural ? 'Reject All' : 'Reject'),
                onDecide: clear,
                decideDisabled: false,
            };
        }
        case 'credit':
            return {
                ...base,
                kind: 'credit',
                title: preview.title ?? 'Continue past 50 credits?',
                message: preview.message ?? 'This response has used 50 credits. Continuing may use up to 30 more.',
                approveLabel: preview.approveLabel ?? 'Continue',
                declineLabel: preview.declineLabel ?? 'Wrap up',
                onDecide: clear,
                decideDisabled: false,
            };
        case 'batch':
            return {
                ...base,
                kind: 'batch',
                title: preview.title ?? 'Summarize each paper into a note',
                scope: preview.scope ?? '568 items in Methods and its subcollections',
            };
        case 'question':
            return { ...base, kind: 'question', title: preview.title ?? 'Beaver has a question for you' };
        case 'completed':
            return {
                ...base,
                kind: 'completed',
                outcome: preview.outcome ?? 'completed',
                detail: preview.outcome === 'error'
                    ? getRunErrorTitle(preview.errorType)
                    : preview.outcome === 'canceled' ? 'Response was interrupted' : null,
                artifacts: (preview.artifacts ?? ['Summary: Smith 2014']).map((title, index) => ({
                    key: `preview-${index}`,
                    title,
                    open: clear,
                })),
                hiddenArtifactCount: 0,
                changes: preview.changes === undefined ? '2 applied, 1 pending' : preview.changes,
            };
    }
}

/** The card to draw, or null when the popup has nothing to say. */
export function useRunStatusPopupCard(): RunStatusPopupCard | null {
    const preview = useAtomValue(runStatusPopupPreviewAtom);
    const live = useLiveCard();
    const previewCard = usePreviewCard(preview);
    return preview ? previewCard : live;
}
