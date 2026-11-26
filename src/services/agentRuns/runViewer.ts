/**
 * The windows that view a session, as the session's host reaches them.
 *
 * A session lives in the plugin realm. What belongs to a window (the selected
 * model, popups and dialogs, agent actions, display enrichment, effects that
 * target that window) is its viewer's, registered by the window when it
 * attaches and revoked when it closes. Any number of windows view a session,
 * and it may have none. The session's host (`createViewerRunHost`) forwards
 * to them and does without them: inputs fall back to the session's own,
 * effects for no window are dropped.
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
import { copyIn } from './copyIn';
import { runEffect, type RunHost, type RunNotice, type RunWarningInput, type UndoConfirmResult } from './runHost';
import { logger } from '@beaver/agent-core/platform/logger';

/** Runs `effect` only while the run that asks still owns the chat. */
export type RunGate = (effect: () => void) => void;

export interface RunViewer extends NotificationTarget {
    // --- Window inputs -----------------------------------------------------
    getModel(): ModelConfig | null;
    getUserId(): string | null;
    actionChanges(actionId: string): MergeItemsChoices | undefined;
    agentActions(): AgentAction[];
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
    /** Load item data for new agent actions; `autoApply` also applies annotations in the open reader. */
    prepareAgentActions(runId: string, actions: AgentAction[], autoApply: boolean): Promise<void>;
    openCreatedTable(tableKey: string, runId: string, toolCallId: string): void;
}

/** The windows a session serves, and what the host needs of the session. */
export interface ViewerTarget {
    /** The windows that view the session, as the viewers they registered. */
    viewers(): readonly RunViewer[];
    /** The window that started the session's latest run, while it views the session. */
    origin(): RunViewer | null;
    /** The window whose command the session handles, while it views the session; its dialogs show there. */
    issuer(): RunViewer | null;
    /** Owner of the session's library operations. */
    owner(): string | undefined;
    /** The session's chat. */
    threadId(): string | null;
    /** Whether the session is still in its registry. */
    live(): boolean;
    /** The model of the session's latest message, for runs it starts with no window. */
    model(): ModelConfig | null;
    /** Open the session's chat in a window, for a notification clicked while no window shows it. */
    openChat?(): void;
}

/**
 * The host of a session: window inputs come from the window it acts for (the
 * one whose command it handles, else the one that started its run, else any
 * that views it), effects go to every window that views it, and once-only
 * window effects to the window that started the run only. Notifications are
 * decided here, once per event, and the undos a retry asks for run here,
 * owned by the session.
 */
export function createViewerRunHost(target: ViewerTarget): RunHost {
    const gate = (set: Setter): RunGate => (effect) => runEffect(set, effect);
    const primary = (): RunViewer | null => target.issuer() ?? target.origin() ?? target.viewers()[0] ?? null;
    const each = (effect: (viewer: RunViewer) => void): void => {
        for (const viewer of target.viewers()) {
            try {
                effect(viewer);
            } catch (error) {
                logger(`agentRuns: a window failed to apply a run effect: ${error}`, 1);
            }
        }
    };
    const all = async (effect: (viewer: RunViewer) => Promise<unknown> | undefined): Promise<void> => {
        await Promise.all(target.viewers().map(async (viewer) => {
            try {
                await effect(viewer);
            } catch (error) {
                logger(`agentRuns: a window failed to apply a run effect: ${error}`, 1);
            }
        }));
    };
    /**
     * The window that shows the run, as notifications see it, read when they
     * are shown and clicked. With no window showing the run, the main window
     * stands in: a notification fires only while Zotero is in the background,
     * and clicking it opens the chat there.
     */
    const notificationTarget: NotificationTarget = {
        hostWindow: () => {
            const viewer = primary();
            if (viewer) return viewer.hostWindow();
            try {
                const main = Zotero.getMainWindow?.();
                return main && !main.closed ? main : null;
            } catch {
                return null;
            }
        },
        sidebarVisible: () => primary()?.sidebarVisible() ?? false,
        open: () => {
            if (!primary()) target.openChat?.();
        },
    };
    const notify = (show: (notificationTarget: NotificationTarget) => void): void => {
        if (notificationTarget.hostWindow()) show(notificationTarget);
    };
    return {
        getModel: () => primary()?.getModel() ?? target.model(),
        getUserId: () => primary()?.getUserId() ?? Zotero.Beaver?.account?.getSnapshot().session?.user.id ?? null,
        // Navigating a window never moves a session to another chat.
        navigationSeq: () => 0,
        actionChanges: (actionId) => primary()?.actionChanges(actionId),
        agentActions: () => primary()?.agentActions() ?? [],

        notify: (set, notice) => each((viewer) => viewer.notify(gate(set), notice)),
        addWarning: (set, warning) => each((viewer) => viewer.addWarning(gate(set), warning)),
        reportMissingZoteroData: (set, event) => each((viewer) => viewer.reportMissingZoteroData(gate(set), event)),
        confirmUndo: (actions, removedRuns, win) => primary()?.confirmUndo(actions, removedRuns, win) ?? 'cancel',
        notifyRunComplete: () => notify((t) => notifyRunComplete(t)),
        notifyCreditConfirmation: (event) => notify((t) => notifyCreditConfirmation(t, event)),
        notifyBatchApproval: (event) => notify((t) => notifyBatchApproval(t, event)),
        notifyUserQuestion: (event) => notify((t) => notifyUserQuestion(t, event)),

        approvalRequested: (event, { silent }) => {
            each((viewer) => viewer.approvalRequested(event));
            // Tell the user when they can't see the approval (e.g. working in another app).
            if (!silent) notify((t) => notifyApprovalRequest(t, event));
        },
        approvalsRemoved: (removed) => each((viewer) => viewer.approvalsRemoved(removed)),
        approvalsCleared: () => each((viewer) => viewer.approvalsCleared()),
        dismissDiffPreview: () => each((viewer) => viewer.dismissDiffPreview()),
        reloadThread: (threadId, userId) => all((viewer) => viewer.reloadThread(threadId, userId)),
        dropPromptEditDrafts: (set, runIds) => each((viewer) => viewer.dropPromptEditDrafts(gate(set), runIds)),
        backendReachable: () => primary()?.backendReachable(),
        recordFeatureCredit: (set, grant) => each((viewer) => viewer.recordFeatureCredit(gate(set), grant)),
        markHighTokenUsage: (set, runId) => each((viewer) => viewer.markHighTokenUsage(gate(set), runId)),
        citationsChanged: (set) => each((viewer) => viewer.citationsChanged(gate(set))),
        preloadPageLabels: async (citations) => (await primary()?.preloadPageLabels(citations)) ?? {},
        mergePageLabels: (labels) => each((viewer) => viewer.mergePageLabels(labels)),
        markExternalReferenceImported: (set, externalId, ref) =>
            each((viewer) => viewer.markExternalReferenceImported(gate(set), externalId, ref)),
        undoAppliedActions: (actions) => {
            const generation = Zotero.Beaver?.account?.getGeneration();
            return undoAppliedActions(actions, {
                mutation: {
                    owner: target.owner(),
                    assertCurrent: () => {
                        if (!target.live()) throw Object.assign(new Error('Chat closed'), { code: 'operation_cancelled' });
                        if (generation !== Zotero.Beaver?.account?.getGeneration()) {
                            throw Object.assign(new Error('Account changed'), { code: 'account_changed' });
                        }
                    },
                },
                noteContext: () => {
                    const references = primary()?.externalReferences();
                    return {
                        threadId: target.threadId(),
                        externalRefs: { ...(references?.externalRefs ?? {}) },
                        externalItemMapping: { ...(references?.externalItemMapping ?? {}) },
                    };
                },
            });
        },
        cleanupTemporaryAnnotations: (logPrefix) => all((viewer) => viewer.cleanupTemporaryAnnotations(logPrefix)),

        addAgentActions: (set, actions) => each((viewer) => viewer.addAgentActions(gate(set), actions)),
        upsertAgentActions: (set, actions) => each((viewer) => viewer.upsertAgentActions(gate(set), actions)),
        removeRunActions: (set, runIds) => each((viewer) => viewer.removeRunActions(gate(set), runIds)),
        replaceAgentActions: (set, actions, runIds) => each((viewer) => viewer.replaceAgentActions(gate(set), actions, runIds)),
        // Recorded once: the record is the instance's, whichever window keeps it.
        recordUndeliveredActions: (info, revocations) => primary()?.recordUndeliveredActions(info, revocations),

        // Item data is the instance's: loading it once serves every window.
        enrichToolCall: (part) => primary()?.enrichToolCall(part),
        processToolReturn: (part, set) => all((viewer) => viewer.processToolReturn(part, gate(set))),
        upgradeToolReturn: async (part, toolCallArgs) => {
            const viewer = primary();
            return viewer ? copyIn(await viewer.upgradeToolReturn(part, toolCallArgs)) : part;
        },
        // Item data is the instance's, loaded once; annotations apply only in
        // the window that started the run.
        prepareAgentActions: async (runId, actions) => {
            const origin = target.origin();
            const viewer = origin ?? primary();
            await viewer?.prepareAgentActions(runId, actions, !!origin && viewer === origin);
        },
        // Opens a tab in the window that started the run only, never in another.
        openCreatedTable: (tableKey, runId, toolCallId) => target.origin()?.openCreatedTable(tableKey, runId, toolCallId),
    };
}
