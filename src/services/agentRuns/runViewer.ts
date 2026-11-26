/**
 * The window a session runs for, as the session's host reaches it.
 *
 * A session lives in the plugin realm. What belongs to its window (the
 * selected model, popups and dialogs, agent actions, display enrichment,
 * effects that target that window) is the viewer's, registered by the window
 * when it attaches and revoked when it closes. The session's host
 * (`createViewerRunHost`) forwards to it, and does without it once it is
 * gone: inputs read as empty, effects are dropped.
 *
 * A viewer method that writes window state takes a `RunGate`: the write runs
 * only while the run that caused it still owns the chat, exactly as the
 * run's own writes.
 */

import type { Setter } from 'jotai/vanilla';
import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import type { ModelConfig } from '@beaver/agent-core/types/models';
import type { Citation } from '@beaver/agent-core/types/citations';
import type { AgentRun, ToolCallPart, ToolReturnPart } from '@beaver/agent-core/agents/types';
import type {
    FeatureCreditGrant,
    WSDeferredApprovalRequest,
    WSMissingZoteroDataEvent,
    WSUndeliveredActionsInfo,
} from '@beaver/agent-core/protocol/agentProtocol';
import type { PendingApproval } from '@beaver/agent-core/run-state/pendingApprovals';
import type { MergeItemsChoices } from '@beaver/agent-core/protocol/duplicates';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import type { PageLabelsByAttachmentId } from '@beaver/agent-core/citations/atoms';
import type { TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';
import type { ExternalRefContext } from '../../utils/noteCitationExpand';
import {
    notifyApprovalRequest,
    notifyBatchApproval,
    notifyCreditConfirmation,
    notifyRunComplete,
    notifyUserQuestion,
    type NotificationTarget,
} from '../systemNotifications';
import { undoAppliedActions } from './undoAppliedActions';
import { runEffect, type RunHost, type RunNotice, type RunWarningInput, type UndoConfirmResult } from './runHost';

/** Runs `effect` only while the run that asks still owns the chat. */
export type RunGate = (effect: () => void) => void;

export interface RunViewer extends NotificationTarget {
    // --- Window inputs -----------------------------------------------------
    getModel(): ModelConfig | null;
    getUserId(): string | null;
    navigationSeq(): number;
    actionChanges(actionId: string): MergeItemsChoices | undefined;
    agentActions(): AgentAction[];
    chatFillSnapshot(jobId: string): TableFillJobSnapshot | undefined;
    /** External-reference mappings of the chat, for operations of its runs. */
    externalReferences(): ExternalRefContext;

    // --- Notices and dialogs -----------------------------------------------
    notify(gate: RunGate, notice: RunNotice): void;
    addWarning(gate: RunGate, warning: RunWarningInput): void;
    reportMissingZoteroData(gate: RunGate, event: WSMissingZoteroDataEvent): void;
    confirmUndo(actions: AgentAction[], removedRuns: readonly AgentRun[], win?: Window): UndoConfirmResult;

    // --- Window-side effects -----------------------------------------------
    /** Refresh the note diff previews a new approval affects. */
    approvalRequested(event: WSDeferredApprovalRequest): void;
    approvalsRemoved(removed: readonly PendingApproval[]): void;
    approvalsCleared(): void;
    dismissDiffPreview(): void;
    reloadThread(threadId: string, userId: string): Promise<unknown>;
    dropPromptEditDrafts(gate: RunGate, runIds: readonly string[]): void;
    backendReachable(): void;
    recordFeatureCredit(gate: RunGate, grant: FeatureCreditGrant & { runId: string }): void;
    markHighTokenUsage(gate: RunGate, runId: string): void;
    citationsChanged(gate: RunGate): void;
    preloadPageLabels(citations: Citation[]): Promise<PageLabelsByAttachmentId>;
    mergePageLabels(labels: PageLabelsByAttachmentId): void;
    markExternalReferenceImported(gate: RunGate, externalId: string, ref: ZoteroItemReference): void;
    cleanupTemporaryAnnotations(logPrefix: string): Promise<void>;
    leaveJobWaitOnClose(): void;

    // --- Agent actions (window state) ---------------------------------------
    addAgentActions(gate: RunGate, actions: AgentAction[]): void;
    upsertAgentActions(gate: RunGate, actions: AgentAction[]): void;
    removeRunActions(gate: RunGate, runIds: readonly string[]): void;
    replaceAgentActions(gate: RunGate, actions: AgentAction[], runIds: ReadonlySet<string>): void;
    recordUndeliveredActions(info: WSUndeliveredActionsInfo, revocationsAtRunStart: number | null): void;

    // --- Display enrichment and once-only window effects --------------------
    enrichToolCall(part: ToolCallPart): Promise<void> | undefined;
    processToolReturn(part: ToolReturnPart, gate: RunGate): Promise<void>;
    upgradeToolReturn(part: ToolReturnPart, toolCallArgs: string | Record<string, any> | null): Promise<ToolReturnPart>;
    prepareAgentActions(runId: string, actions: AgentAction[]): Promise<void>;
    openCreatedTable(tableKey: string, runId: string, toolCallId: string): void;
}

/** What the host needs of the session it serves. */
export interface ViewerRunHostSession {
    /** Owner of the session's library operations. */
    owner(): string | undefined;
    /** The session's chat. */
    threadId(): string | null;
}

/**
 * The host of a session that runs for a window: window inputs and effects go
 * to its viewer while one is attached; notifications are decided here, once
 * per event, and the undos a retry asks for run here, owned by the session.
 */
export function createViewerRunHost(
    windowId: () => string | undefined,
    viewer: () => RunViewer | null,
    session: ViewerRunHostSession,
): RunHost {
    const gate = (set: Setter): RunGate => (effect) => runEffect(set, effect);
    /**
     * The session's window as notifications see it, read when they are shown
     * and clicked: once the window is gone, a queued notification is dropped
     * and a click opens nothing.
     */
    const target: NotificationTarget = {
        hostWindow: () => viewer()?.hostWindow() ?? null,
        sidebarVisible: () => viewer()?.sidebarVisible() ?? false,
    };
    /** Notify for the session's window; a session whose window is gone notifies nothing. */
    const withTarget = (notify: (target: NotificationTarget) => void): void => {
        if (target.hostWindow()) notify(target);
    };
    return {
        windowId: () => (viewer() ? windowId() : undefined),
        getModel: () => viewer()?.getModel() ?? null,
        getUserId: () => viewer()?.getUserId() ?? null,
        // A closed window has navigated away from every chat.
        navigationSeq: () => viewer()?.navigationSeq() ?? -1,
        actionChanges: (actionId) => viewer()?.actionChanges(actionId),
        agentActions: () => viewer()?.agentActions() ?? [],
        chatFillSnapshot: (jobId) => viewer()?.chatFillSnapshot(jobId),

        notify: (set, notice) => viewer()?.notify(gate(set), notice),
        addWarning: (set, warning) => viewer()?.addWarning(gate(set), warning),
        reportMissingZoteroData: (set, event) => viewer()?.reportMissingZoteroData(gate(set), event),
        confirmUndo: (actions, removedRuns, win) => viewer()?.confirmUndo(actions, removedRuns, win) ?? 'cancel',
        notifyRunComplete: () => withTarget((target) => notifyRunComplete(target)),
        notifyCreditConfirmation: (event) => withTarget((target) => notifyCreditConfirmation(target, event)),
        notifyBatchApproval: (event) => withTarget((target) => notifyBatchApproval(target, event)),
        notifyUserQuestion: (event) => withTarget((target) => notifyUserQuestion(target, event)),

        approvalRequested: (event, { silent }) => {
            viewer()?.approvalRequested(event);
            // Tell the user when they can't see the approval (e.g. working in another app).
            if (!silent) withTarget((target) => notifyApprovalRequest(target, event));
        },
        approvalsRemoved: (removed) => viewer()?.approvalsRemoved(removed),
        approvalsCleared: () => viewer()?.approvalsCleared(),
        dismissDiffPreview: () => viewer()?.dismissDiffPreview(),
        reloadThread: async (threadId, userId) => viewer()?.reloadThread(threadId, userId),
        dropPromptEditDrafts: (set, runIds) => viewer()?.dropPromptEditDrafts(gate(set), runIds),
        backendReachable: () => viewer()?.backendReachable(),
        recordFeatureCredit: (set, grant) => viewer()?.recordFeatureCredit(gate(set), grant),
        markHighTokenUsage: (set, runId) => viewer()?.markHighTokenUsage(gate(set), runId),
        citationsChanged: (set) => viewer()?.citationsChanged(gate(set)),
        preloadPageLabels: async (citations) => (await viewer()?.preloadPageLabels(citations)) ?? {},
        mergePageLabels: (labels) => viewer()?.mergePageLabels(labels),
        markExternalReferenceImported: (set, externalId, ref) =>
            viewer()?.markExternalReferenceImported(gate(set), externalId, ref),
        undoAppliedActions: (actions) => {
            const generation = Zotero.Beaver?.account?.getGeneration();
            return undoAppliedActions(actions, {
                mutation: {
                    owner: session.owner(),
                    assertCurrent: () => {
                        if (!viewer()) throw Object.assign(new Error('Window closed'), { code: 'operation_cancelled' });
                        if (generation !== Zotero.Beaver?.account?.getGeneration()) {
                            throw Object.assign(new Error('Account changed'), { code: 'account_changed' });
                        }
                    },
                },
                noteContext: () => {
                    const references = viewer()?.externalReferences();
                    return {
                        threadId: session.threadId(),
                        externalRefs: { ...(references?.externalRefs ?? {}) },
                        externalItemMapping: { ...(references?.externalItemMapping ?? {}) },
                    };
                },
            });
        },
        cleanupTemporaryAnnotations: async (logPrefix) => viewer()?.cleanupTemporaryAnnotations(logPrefix),
        leaveJobWaitOnClose: () => viewer()?.leaveJobWaitOnClose(),

        addAgentActions: (set, actions) => viewer()?.addAgentActions(gate(set), actions),
        upsertAgentActions: (set, actions) => viewer()?.upsertAgentActions(gate(set), actions),
        removeRunActions: (set, runIds) => viewer()?.removeRunActions(gate(set), runIds),
        replaceAgentActions: (set, actions, runIds) => viewer()?.replaceAgentActions(gate(set), actions, runIds),
        recordUndeliveredActions: (info, revocations) => viewer()?.recordUndeliveredActions(info, revocations),

        enrichToolCall: (part) => viewer()?.enrichToolCall(part),
        processToolReturn: async (part, set) => viewer()?.processToolReturn(part, gate(set)),
        upgradeToolReturn: async (part, toolCallArgs) => (await viewer()?.upgradeToolReturn(part, toolCallArgs)) ?? part,
        prepareAgentActions: async (runId, actions) => viewer()?.prepareAgentActions(runId, actions),
        // Opens a tab in the session's own window only, never in another.
        openCreatedTable: (tableKey, runId, toolCallId) => viewer()?.openCreatedTable(tableKey, runId, toolCallId),
    };
}
