/**
 * Client state for the cards of a parked run.
 *
 * A run that waits on a card the user does not answer in time, or leaves,
 * parks: it ends with its open cards stored, and each answer resumes it (see
 * `openParkedRunAtom`). This module keeps the four card maps in step with the
 * open parked run, and holds the answers on their way to the run that
 * resumes it.
 */

import { atom } from 'jotai';
import { isRunActive, type ParkedCardAnswer } from '@beaver/agent-core/agents/types';
import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';
import { openParkedRunAtom, parkedCardRequests } from '@beaver/agent-core/run-state/parkedRun';
import { addPendingQuestionAtom, pendingQuestionsAtom } from '@beaver/agent-core/run-state/pendingQuestions';
import { addPendingBatchApprovalAtom, pendingBatchApprovalsAtom } from '@beaver/agent-core/run-state/pendingBatchApprovals';
import {
    addPendingTableCardAtom,
    pendingTableCardsAtom,
    tableCardDraftsAtom,
} from '@beaver/agent-core/run-state/pendingTableCards';
import { isCreateCard, isFillCard } from '@beaver/agent-core/protocol/tableCardProtocol';
import { addPendingApprovalAtom, pendingApprovalsAtom, removePendingApprovalsAtom } from '../agents/agentActions';

/** An answer to a parked card, waiting to be sent in the next resume. */
export interface QueuedParkedAnswer {
    threadId: string | null;
    answer: ParkedCardAnswer;
}

/**
 * Answers to parked cards not sent yet, keyed by tool call id. An answer
 * waits here only while another resume of the same run is running; it is
 * sent with any others given meanwhile once that resume ends.
 */
export const parkedAnswerQueueAtom = atom<ReadonlyMap<string, QueuedParkedAnswer>>(new Map());

/** Tool calls whose answers the resume now running carries. */
export const parkedAnswersInFlightAtom = atom<ReadonlySet<string>>(new Set<string>());

/**
 * Tool calls of the live run whose card the user answered over the socket
 * and that have not returned yet. A run with such an answer is not left by
 * parking it: the answer may be mid-way through applying.
 */
export const liveCardAnswersAtom = atom<ReadonlySet<string>>(new Set<string>());

export const addLiveCardAnswerAtom = atom(null, (get, set, toolCallId: string) => {
    if (get(liveCardAnswersAtom).has(toolCallId)) return;
    set(liveCardAnswersAtom, new Set([...get(liveCardAnswersAtom), toolCallId]));
});

export const removeLiveCardAnswerAtom = atom(null, (get, set, toolCallId: string) => {
    const current = get(liveCardAnswersAtom);
    if (!current.has(toolCallId)) return;
    const next = new Set(current);
    next.delete(toolCallId);
    set(liveCardAnswersAtom, next);
});

/**
 * Tool calls whose takeover card (question, batch, table) the user set aside
 * to write a message instead. The composer shows in its place until the user
 * goes back to the card.
 */
export const setAsideParkedCardsAtom = atom<ReadonlySet<string>>(new Set<string>());

/**
 * Whether the open thread rests on a parked run: no run is going, and the
 * last one is waiting on cards the user can answer or write past.
 */
export const isThreadParkedAtom = atom((get) => {
    if (isRunActive(get(activeRunAtom))) return false;
    return get(openParkedRunAtom) !== null;
});

/**
 * Tool calls whose parked card has an answer on its way: queued, or carried
 * by the resume now running. Their cards show the answer as being applied,
 * and offer nothing else to click meanwhile.
 */
export const pendingParkedAnswerIdsAtom = atom<ReadonlySet<string>>((get) => {
    const queued = get(parkedAnswerQueueAtom);
    const inFlight = get(parkedAnswersInFlightAtom);
    if (queued.size === 0) return inFlight;
    return new Set([...queued.keys(), ...inFlight]);
});

/** Forget every answer on its way to a resume, e.g. when the thread changes. */
export const clearParkedAnswersAtom = atom(null, (get, set) => {
    if (get(parkedAnswerQueueAtom).size) set(parkedAnswerQueueAtom, new Map());
    if (get(parkedAnswersInFlightAtom).size) set(parkedAnswersInFlightAtom, new Set<string>());
    if (get(setAsideParkedCardsAtom).size) set(setAsideParkedCardsAtom, new Set<string>());
});

/**
 * Make the card maps show exactly the open parked run's cards that are still
 * waiting for an answer: every listed card that is not queued or being sent,
 * added silently when missing. Everything else leaves the maps.
 *
 * Cards already shown are kept as they are, so their components and drafts
 * survive. Call at run boundaries only: a live run's cards are not parked
 * cards and would be dropped.
 */
export const syncParkedCardsAtom = atom(null, (get, set) => {
    const open = get(openParkedRunAtom);
    const answered = new Set<string>([...get(parkedAnswerQueueAtom).keys(), ...get(parkedAnswersInFlightAtom)]);
    const wanted = parkedCardRequests(open?.deferrals ?? [], answered);

    // Agent-action approvals, keyed by action id.
    const approvals = get(pendingApprovalsAtom);
    const wantedActionIds = new Set(wanted.approvals.map((request) => request.action_id));
    const staleActionIds = [...approvals.keys()].filter((actionId) => !wantedActionIds.has(actionId));
    if (staleActionIds.length) set(removePendingApprovalsAtom, staleActionIds);
    for (const request of wanted.approvals) {
        if (!approvals.has(request.action_id)) set(addPendingApprovalAtom, request, { silent: true });
    }

    // Questions, keyed by tool call id.
    const questions = get(pendingQuestionsAtom);
    const wantedQuestionIds = new Set(wanted.questions.map((request) => request.toolcall_id));
    if ([...questions.keys()].some((toolCallId) => !wantedQuestionIds.has(toolCallId))) {
        set(pendingQuestionsAtom, new Map([...questions].filter(([toolCallId]) => wantedQuestionIds.has(toolCallId))));
    }
    for (const request of wanted.questions) {
        if (!questions.has(request.toolcall_id)) set(addPendingQuestionAtom, request);
    }

    // Batch approvals, keyed by approval id.
    const batchApprovals = get(pendingBatchApprovalsAtom);
    const wantedApprovalIds = new Set(wanted.batchApprovals.map((request) => request.approval_id));
    if ([...batchApprovals.keys()].some((approvalId) => !wantedApprovalIds.has(approvalId))) {
        set(pendingBatchApprovalsAtom, new Map([...batchApprovals].filter(([approvalId]) => wantedApprovalIds.has(approvalId))));
    }
    for (const request of wanted.batchApprovals) {
        if (!batchApprovals.has(request.approval_id)) set(addPendingBatchApprovalAtom, request);
    }

    // Table cards, keyed by card id. A card this client cannot show is left
    // out, as when it arrives live.
    const tableRequests = wanted.tableCards.filter((request) => isCreateCard(request) || isFillCard(request));
    const tableCards = get(pendingTableCardsAtom);
    const wantedCardIds = new Set(tableRequests.map((request) => request.card_id));
    if ([...tableCards.keys()].some((cardId) => !wantedCardIds.has(cardId))) {
        set(pendingTableCardsAtom, new Map([...tableCards].filter(([cardId]) => wantedCardIds.has(cardId))));
    }
    // Edits are kept for every open card, an answered one included: if its
    // answer does not reach a run, the card comes back with them.
    const openCardIds = new Set(parkedCardRequests(open?.deferrals ?? []).tableCards.map((request) => request.card_id));
    const drafts = get(tableCardDraftsAtom);
    if ([...drafts.keys()].some((cardId) => !openCardIds.has(cardId))) {
        set(tableCardDraftsAtom, new Map([...drafts].filter(([cardId]) => openCardIds.has(cardId))));
    }
    for (const request of tableRequests) {
        if (!tableCards.has(request.card_id)) set(addPendingTableCardAtom, request);
    }

    // A card set aside stays set aside only while it is still open.
    const setAside = get(setAsideParkedCardsAtom);
    if ([...setAside].some((toolCallId) => !open?.toolCallIds.has(toolCallId))) {
        set(setAsideParkedCardsAtom, new Set([...setAside].filter((toolCallId) => open?.toolCallIds.has(toolCallId))));
    }
});
