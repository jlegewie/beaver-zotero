/**
 * What the closed-sidebar status popup says, derived from run state.
 *
 * Pure: the hook next door subscribes to the store and calls these; nothing
 * here reads an atom, touches the DOM, or knows how a card is drawn.
 */
import type { AgentRun, ToolCallPart } from '@beaver/agent-core/agents/types';
import { isAutoLoadingToolCall, isThinkingInProgress } from '@beaver/agent-core/agents/messageVisibility';
import { getToolCallStatus, type ToolResult } from '@beaver/agent-core/run-state/atoms';
import type { PendingApproval } from '@beaver/agent-ui/host';
import type { PendingQuestion } from '@beaver/agent-core/run-state/pendingQuestions';
import type { AskUserQuestionAnswer } from '@beaver/agent-core/protocol/agentProtocol';
import type { RunPermissionMode } from '../ui/buttons/RunPermissionButton';
import { getActionLabel } from '../../host/zotero/components/agentActionViewHelpers';

/** How many threads the popup will layer behind the front card, at most. */
export const MAX_STACK_DEPTH = 2;

/** Artifacts listed on a completed card before the rest is left to the sidebar. */
export const MAX_COMPLETED_ARTIFACTS = 3;

/** Longest thread name drawn before the prompt is cut, when no name exists yet. */
const MAX_PROMPT_TITLE_CHARS = 60;

export interface RunStatusArtifact {
    key: string;
    /** The action type that produced it, for its icon. */
    actionType: string;
    /** What was made, in the sidebar's words: "Created Note". */
    label: string;
    /** The artifact's own name; null when the action has none. */
    title: string | null;
    /** Opens the artifact itself; absent when it has not been written yet. */
    open?: () => void;
}

interface RunStatusCardBase {
    threadName: string;
    /** Further running threads layered behind this card, capped by MAX_STACK_DEPTH. */
    stackDepth: number;
    /** Opens Beaver on this thread. The whole card is the target. */
    onOpen: () => void;
    /**
     * Closes this card. It stays closed for exactly what it was about — see
     * `runStatusPopupDismissedAtom` — and the next thing the run has to say
     * gets a card of its own.
     */
    onDismiss: () => void;
}

export interface RunningCard extends RunStatusCardBase {
    kind: 'running';
    /** What the run is doing now: "Thinking", "Generating", or a tool-call label. */
    statusLine: string;
}

export interface ApprovalCard extends RunStatusCardBase {
    kind: 'approval';
    /** One action's label and title, or the aggregate for several. */
    label: string;
    count: number;
    /** The one pending action's type, for its tool icon; null for several. */
    actionType: string | null;
    /** The run-scoped permission control; null for a confirm-only card. */
    permission: {
        mode: RunPermissionMode;
        pendingCoveredCount: number;
        onChange: (mode: RunPermissionMode) => void;
    } | null;
    approveLabel: string;
    rejectLabel: string;
    onDecide: (approved: boolean) => void;
    /** A decision is already on its way; the next click must wait. */
    decideDisabled: boolean;
}

export interface CreditCard extends RunStatusCardBase {
    kind: 'credit';
    title: string;
    message: string;
    approveLabel: string;
    declineLabel: string;
    onDecide: (approved: boolean) => void;
    decideDisabled: boolean;
}

export interface BatchCard extends RunStatusCardBase {
    kind: 'batch';
    title: string;
    /** The population, e.g. "184 items in Methods". Empty when unknown. */
    scope: string;
}

export interface QuestionCard extends RunStatusCardBase {
    kind: 'question';
    /** The request itself; the card draws the shared question UI for it. */
    question: PendingQuestion;
    onSubmit: (answers: AskUserQuestionAnswer[]) => void;
}

export interface CompletedCard extends RunStatusCardBase {
    kind: 'completed';
    outcome: 'completed' | 'error' | 'canceled';
    /** What went wrong, in the run error display's words; null for a clean finish. */
    detail: string | null;
    artifacts: RunStatusArtifact[];
    /** How many artifacts the card left out, for the "+N more" line. */
    hiddenArtifactCount: number;
    /** The changes card's trail ("2 applied, 1 pending"), or null with no changes. */
    changes: string | null;
    /** Opens Beaver with the answer's changes card expanded. */
    onReviewChanges: () => void;
}

export type RunStatusPopupCard =
    | RunningCard
    | ApprovalCard
    | CreditCard
    | BatchCard
    | QuestionCard
    | CompletedCard;

export type RunStatusPopupKind = RunStatusPopupCard['kind'];

/** What a live run is doing right now, for the running card's second line. */
export type RunActivity =
    | { kind: 'thinking' }
    | { kind: 'generating' }
    | { kind: 'tool'; part: ToolCallPart };

/**
 * The visible activity in a run: a tool call still waiting on its result, or
 * failing that, whether the newest response is reasoning or writing.
 *
 * A tool call wins because it is the most specific thing the popup can say,
 * and because the model says nothing while one runs. Auto-loading calls are
 * plumbing the sidebar hides, and `return_suggestions` is the answer's
 * follow-up chips, so neither reads as activity. The newest of several
 * parallel calls is the one named, since it is the one that started last.
 *
 * With no tool running, the newest response decides: reasoning with nothing
 * else yet is "thinking", a text part is "generating", and anything else —
 * including a run that has produced nothing at all, or whose newest message is
 * a tool return the model has yet to answer — is the wait before the next
 * token, which reads as thinking too.
 */
/** Plumbing the sidebar hides, and the answer's follow-up chips: neither is activity. */
function isIgnoredToolCall(part: ToolCallPart): boolean {
    return isAutoLoadingToolCall(part) || part.tool_name === 'return_suggestions';
}

export function deriveRunActivity(
    run: AgentRun,
    toolResults: ReadonlyMap<string, ToolResult>,
): RunActivity {
    let inProgress: ToolCallPart | null = null;
    for (const message of run.model_messages) {
        if (message.kind !== 'response') continue;
        for (const part of message.parts) {
            if (part.part_kind !== 'tool-call' || isIgnoredToolCall(part)) continue;
            if (getToolCallStatus(part.tool_call_id, toolResults, run.status) === 'in_progress') {
                inProgress = part;
            }
        }
    }
    if (inProgress) return { kind: 'tool', part: inProgress };

    const newest = run.model_messages[run.model_messages.length - 1];
    if (!newest || newest.kind !== 'response') return { kind: 'thinking' };
    if (isThinkingInProgress(newest)) return { kind: 'thinking' };
    for (let i = newest.parts.length - 1; i >= 0; i--) {
        const part = newest.parts[i];
        if (part.part_kind === 'text') return part.content.trim() ? { kind: 'generating' } : { kind: 'thinking' };
        if (part.part_kind === 'thinking') return { kind: 'thinking' };
        // A completed tool call: the model is between steps. The calls the
        // in-progress scan ignores are ignored here too — the suggestion chips
        // come after the answer's text, and must not hide it.
        if (part.part_kind === 'tool-call' && !isIgnoredToolCall(part)) return { kind: 'thinking' };
    }
    return { kind: 'thinking' };
}

/**
 * The name the card carries for a thread. The backend names a thread after
 * its first run; until then the prompt itself is the best title there is.
 */
export function threadDisplayName(threadName: string | null | undefined, run: AgentRun | null | undefined): string {
    const named = threadName?.trim();
    if (named) return named;
    const prompt = run?.user_prompt?.content?.replace(/\s+/g, ' ').trim() ?? '';
    if (!prompt) return 'New chat';
    return prompt.length > MAX_PROMPT_TITLE_CHARS
        ? `${prompt.slice(0, MAX_PROMPT_TITLE_CHARS - 1).trimEnd()}…`
        : prompt;
}

/** Cost and off-device confirmations: no library write, so no permission grant covers them. */
export function isConfirmActionType(actionType: string): boolean {
    return actionType === 'confirm_extraction' || actionType === 'confirm_external_search';
}

export interface PendingApprovalSummary {
    label: string;
    count: number;
    /** Every pending request is a confirmation rather than a library change. */
    confirmOnly: boolean;
}

/**
 * One line for the approvals a run is waiting on.
 *
 * A single request reads like its in-stream card: the action label, then the
 * title of what it touches when the caller has resolved one. Several collapse
 * into a count with the labels that make it up, each with its own tally, so
 * "3 changes · Edit ×2, Create Note" says what the Approve All button covers.
 */
export function describePendingApprovals(
    approvals: readonly PendingApproval[],
    singleTitle: string | null,
): PendingApprovalSummary {
    const confirmOnly = approvals.length > 0 && approvals.every((a) => isConfirmActionType(a.actionType));
    if (approvals.length === 1) {
        const [approval] = approvals;
        const label = getActionLabel(approval.actionType, approval.actionData);
        // A confirmation's title already says what is being confirmed
        // ("Confirm 12 Item Batch Processing"); a verb in front of it would
        // only repeat it.
        return {
            label: !singleTitle ? label : confirmOnly ? singleTitle : `${label} · ${singleTitle}`,
            count: 1,
            confirmOnly,
        };
    }

    const tallies = new Map<string, number>();
    for (const approval of approvals) {
        const label = getActionLabel(approval.actionType, approval.actionData);
        tallies.set(label, (tallies.get(label) ?? 0) + 1);
    }
    const parts = [...tallies.entries()].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label));
    const noun = confirmOnly ? 'confirmations' : 'changes';
    return {
        label: `${approvals.length} ${noun} · ${parts.join(', ')}`,
        count: approvals.length,
        confirmOnly,
    };
}
