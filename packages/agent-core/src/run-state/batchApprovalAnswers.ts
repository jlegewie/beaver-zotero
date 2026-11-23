/**
 * The user's in-progress decision on one batch approval request, and the rules
 * that turn it into the wire response.
 *
 * Host-free on purpose: every client that renders the batch approval card
 * shares these semantics, so they live here rather than in one client's
 * component. All transitions are pure and return a NEW draft — never mutate
 * one. They return the SAME draft object when nothing changes, which is what
 * keeps a React caller holding the draft in state from re-rendering for
 * nothing.
 */

import type { BatchApprovalMode } from '../protocol/agentProtocol';

export type { BatchApprovalMode };

/** The decision as it goes on the wire, minus the correlation id. */
export interface BatchApprovalDecision {
    approved: boolean;
    mode: BatchApprovalMode;
    user_instructions: string | null;
}

/** The user's in-progress decision on one batch approval request. */
export interface BatchApprovalDraft {
    /** Coverage the decision grants for the life of the batch. */
    mode: BatchApprovalMode;
    /** Instructions for the model, stored verbatim; trimmed at read time. */
    userInstructions: string;
}

/**
 * A draft with nothing chosen yet, on the mode a request carries unless it
 * says otherwise. Every seeded draft starts from a copy of this.
 */
export const DEFAULT_BATCH_APPROVAL_DRAFT: BatchApprovalDraft = {
    mode: 'full_access',
    userInstructions: '',
};

/**
 * The draft a card starts from for a request that preselects `defaultMode`.
 *
 * Takes the mode and the prefill rather than the request so these rules stay
 * independent of the pending-store shape, and so a card never has to assemble
 * a draft literal of its own.
 *
 * `instructionsPrefill` seeds an editable draft; the user may change or
 * clear it, and `buildResponse` sends whatever is left.
 *
 * Always a fresh object, so no two cards ever seed onto the same draft.
 */
export function initialDraft(
    defaultMode: BatchApprovalMode,
    instructionsPrefill = '',
): BatchApprovalDraft {
    return {
        ...DEFAULT_BATCH_APPROVAL_DRAFT,
        mode: defaultMode,
        userInstructions: instructionsPrefill,
    };
}

/** Choose the coverage the decision grants. */
export function setMode(mode: BatchApprovalMode, draft: BatchApprovalDraft): BatchApprovalDraft {
    if (draft.mode === mode) return draft;
    return { ...draft, mode };
}

/** Record what the user typed. Stored verbatim — trimming happens at read time. */
export function setUserInstructions(text: string, draft: BatchApprovalDraft): BatchApprovalDraft {
    if (draft.userInstructions === text) return draft;
    return { ...draft, userInstructions: text };
}

/**
 * The wire response for the decision.
 *
 * Instructions travel on both paths: they constrain an approved batch and say
 * what to do instead when it is declined. Text that is empty or only
 * whitespace is not an instruction and goes out as `null`.
 */
export function buildResponse(
    draft: BatchApprovalDraft,
    approved: boolean,
): BatchApprovalDecision {
    return {
        approved,
        mode: draft.mode,
        user_instructions: draft.userInstructions.trim() || null,
    };
}
