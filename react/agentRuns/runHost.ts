/**
 * What the run engine needs from the client it runs in.
 *
 * The engine executes a chat run: transport, stream events, cards, retries,
 * resumes and settlement. Everything that belongs to a window rather than to
 * the run reaches it through this interface: what the user has selected, the
 * window's notices and dialogs, and the window-side work that follows stream
 * events (loading item data for display, opening a created table, applying
 * annotations in the open reader).
 *
 * Methods that take a `Setter` write window state through the run's guarded
 * setter, so a write is dropped once the run no longer owns the chat, exactly
 * as for the run's own state.
 */

import type { Getter, Setter } from 'jotai';
import type { AgentAction } from '../agents/agentActions';
import type { ModelConfig } from '../atoms/models';
import type { Citation } from '@beaver/agent-core/types/citations';
import type { AgentRun, ToolCallPart, ToolReturnPart } from '@beaver/agent-core/agents/types';
import type {
    WSAskUserQuestionRequest,
    WSBatchApprovalRequest,
    WSCreditConfirmationRequest,
    WSMissingZoteroDataEvent,
} from '@beaver/agent-core/protocol/agentProtocol';
import type { MergeItemsChoices } from '@beaver/agent-core/protocol/duplicates';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import type { FeatureCreditGrant } from '@beaver/agent-core/protocol/agentProtocol';
import type { PageLabelsByAttachmentId } from '@beaver/agent-core/citations/atoms';

/** A message for the user, shown by the window as a popup. */
export interface RunNotice {
    type: 'info' | 'warning' | 'error';
    title: string;
    text: string;
    expire: boolean;
    duration?: number;
}

/** A warning attached to a run. */
export interface RunWarningInput {
    run_id: string;
    type: string;
    message: string;
    data?: Record<string, unknown>;
}

/** `undo` to undo and retry, `skip` to retry without undoing, `cancel` to abort. */
export type UndoConfirmResult = 'undo' | 'skip' | 'cancel';

export interface RunHost {
    // --- Window inputs -----------------------------------------------------
    // Read through the run's getter, so they come from the store the run writes.

    /** Id of the window the run belongs to, as presence claims know it. */
    windowId(): string | undefined;
    /** The model selected in the window. */
    getModel(get: Getter): ModelConfig | null;
    /** The signed-in user. */
    getUserId(get: Getter): string | null;
    /** Increases on every chat navigation in the window. */
    navigationSeq(get: Getter): number;
    /** Choices the user made on a merge-items approval card. */
    actionChanges(get: Getter, actionId: string): MergeItemsChoices | undefined;

    // --- Notices and dialogs -----------------------------------------------

    notify(set: Setter, notice: RunNotice): void;
    addWarning(set: Setter, warning: RunWarningInput): void;
    /** Explain why items the backend asked for are unavailable. */
    reportMissingZoteroData(set: Setter, event: WSMissingZoteroDataEvent): void;
    /**
     * Ask whether to undo the applied actions among `actions`, which belong to
     * the runs a retry removes. Returns 'skip' without asking when none was applied.
     */
    confirmUndo(actions: AgentAction[], removedRuns: readonly AgentRun[], win?: Window): UndoConfirmResult;
    notifyRunComplete(): void;
    notifyCreditConfirmation(event: WSCreditConfirmationRequest): void;
    notifyBatchApproval(event: WSBatchApprovalRequest): void;
    notifyUserQuestion(event: WSAskUserQuestionRequest): void;

    // --- Window-side effects -----------------------------------------------

    dismissDiffPreview(): void;
    /** Reload the chat from the server; resolves once the load has finished. */
    reloadThread(threadId: string, userId: string): Promise<unknown>;
    /** Forget edits the user started on prompts of runs that were removed. */
    dropPromptEditDrafts(set: Setter, runIds: readonly string[]): void;
    /** A run reached the backend, so it is reachable and the session is valid. */
    backendReachable(): void;
    recordFeatureCredit(set: Setter, grant: FeatureCreditGrant & { runId: string }): void;
    markHighTokenUsage(set: Setter, runId: string): void;
    /** Citations changed: the window may show its citation tip. */
    citationsChanged(set: Setter): void;
    /** Page labels for cited attachments, keyed by attachment id. */
    preloadPageLabels(citations: Citation[]): Promise<PageLabelsByAttachmentId>;
    markExternalReferenceImported(set: Setter, externalId: string, ref: ZoteroItemReference): void;
    /** Undo applied actions, newest first. */
    undoAppliedActions(actions: AgentAction[]): Promise<void>;
    cleanupTemporaryAnnotations(logPrefix: string): Promise<void>;
    /** The window is closing: hand off or stop the fill its chat waits on. */
    leaveJobWaitOnClose(): void;

    // --- Display enrichment and once-only window effects --------------------

    /** Load what the window shows for a streamed tool call; undefined when there is nothing to load. */
    enrichToolCall(part: ToolCallPart): Promise<void> | undefined;
    /** Process a tool return for display before it is applied to the run. */
    processToolReturn(part: ToolReturnPart, set: Setter): Promise<void>;
    /** Give a tool return without a valid view one built from its legacy result. */
    upgradeToolReturn(part: ToolReturnPart, toolCallArgs: string | Record<string, any> | null): Promise<void>;
    /** Load item data for new agent actions, then auto-apply annotations. */
    prepareAgentActions(runId: string, actions: AgentAction[]): Promise<void>;
    /** Open the tab of a table the run created. */
    openCreatedTable(tableKey: string, runId: string, toolCallId: string): void;
}
