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
 * The engine writes only its session's store. Methods that take a `Setter`
 * receive the run's guarded setter for that store and make their window write
 * through it with `runEffect`, so the write is dropped once the run no longer
 * owns the chat, exactly as for the run's own state.
 */

import { atom, type Setter } from 'jotai';
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
import type { WSUndeliveredActionsInfo } from '@beaver/agent-core/protocol/agentProtocol';
import type { TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';

const runEffectAtom = atom(null, (_get, _set, effect: () => void) => {
    effect();
});

/**
 * Run a window write through a run's guarded setter: it happens only if the
 * setter would still write the run's own state.
 */
export function runEffect(set: Setter, effect: () => void): void {
    set(runEffectAtom, effect);
}

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

    /** Id of the window the run belongs to, as presence claims know it. */
    windowId(): string | undefined;
    /** The model selected in the window. */
    getModel(): ModelConfig | null;
    /** The signed-in user. */
    getUserId(): string | null;
    /** Increases on every chat navigation in the window. */
    navigationSeq(): number;
    /** Choices the user made on a merge-items approval card. */
    actionChanges(actionId: string): MergeItemsChoices | undefined;
    /** The agent actions of the chat, which the window owns. */
    agentActions(): AgentAction[];
    /** The latest state of a table fill this window runs for the chat. */
    chatFillSnapshot(jobId: string): TableFillJobSnapshot | undefined;

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
    /** Keep preloaded page labels for rendering. Render state, not chat history. */
    mergePageLabels(labels: PageLabelsByAttachmentId): void;
    markExternalReferenceImported(set: Setter, externalId: string, ref: ZoteroItemReference): void;
    /** Undo applied actions, newest first. */
    undoAppliedActions(actions: AgentAction[]): Promise<void>;
    cleanupTemporaryAnnotations(logPrefix: string): Promise<void>;
    /** The window is closing: hand off or stop the fill its chat waits on. */
    leaveJobWaitOnClose(): void;

    // --- Agent actions (window state) ------------------------------------------

    addAgentActions(set: Setter, actions: AgentAction[]): void;
    upsertAgentActions(set: Setter, actions: AgentAction[]): void;
    /** Drop the actions of runs a retry removed. */
    removeRunActions(set: Setter, runIds: readonly string[]): void;
    /** Replace the chat's actions with saved ones, keeping results not yet recorded. */
    replaceAgentActions(set: Setter, actions: AgentAction[], runIds: ReadonlySet<string>): void;
    /** Applied in Zotero, but the result never reached the server: record it. */
    recordUndeliveredActions(info: WSUndeliveredActionsInfo, revocationsAtRunStart: number | null): void;

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
