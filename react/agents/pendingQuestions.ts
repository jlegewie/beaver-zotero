/**
 * Pending user-question state (ask_user_question tool).
 *
 * Deliberately separate from the agent-action state in `agentActions.ts`:
 * a question is NOT an agent action — it has no apply/undo/validate lifecycle
 * and no AgentActionType. It is a run-blocking request for user input,
 * answered through a dedicated WS event pair (`ask_user_question_request` /
 * `ask_user_question_response`) correlated by `question_id`.
 *
 * This module is client-agnostic (jotai + wire types only), so a non-Zotero
 * shell can reuse it without pulling in the Zotero-coupled action machinery.
 */

import { atom } from 'jotai';
import type {
    AskUserQuestionItem,
    WSAskUserQuestionRequest,
} from '../../src/services/agentProtocol';

/**
 * Pending ask_user_question request from the backend.
 * When set, the composer is replaced by the interactive question panel
 * (AskUserQuestionPanel) and the run blocks until the user submits or skips.
 */
export interface PendingQuestion {
    /** Correlation id for the wire response (WSAskUserQuestionResponse) */
    questionId: string;
    /** Tool call ID this question belongs to (the map key) */
    toolcallId: string;
    /** Optional card title */
    title?: string | null;
    /** The questions to present */
    questions: AskUserQuestionItem[];
}

/**
 * Atom storing pending question requests, keyed by toolcallId.
 * Unlike approvals (keyed by action_id with a linear-search getter), questions
 * are keyed by toolcallId directly — the per-toolcall removal on tool return
 * (the backend-timeout path) keys by tool call, and questionId rides along
 * for the wire response.
 */
export const pendingQuestionsAtom = atom<Map<string, PendingQuestion>>(new Map());

/** Add a pending question from a WS event. */
export const addPendingQuestionAtom = atom(
    null,
    (_, set, event: WSAskUserQuestionRequest) => {
        set(pendingQuestionsAtom, (prev) => {
            const next = new Map(prev);
            next.set(event.toolcall_id, {
                questionId: event.question_id,
                toolcallId: event.toolcall_id,
                title: event.title,
                questions: event.questions,
            });
            return next;
        });
    }
);

/** Remove a specific pending question by toolcallId (after the user responds
 * or the tool return arrives). */
export const removePendingQuestionAtom = atom(
    null,
    (_get, set, toolcallId: string) => {
        set(pendingQuestionsAtom, (prev) => {
            if (!prev.has(toolcallId)) return prev;
            const next = new Map(prev);
            next.delete(toolcallId);
            return next;
        });
    }
);

/** Clear all pending questions (thread switch, run complete, disconnect, ...). */
export const clearAllPendingQuestionsAtom = atom(
    null,
    (_get, set) => {
        set(pendingQuestionsAtom, new Map());
    }
);
