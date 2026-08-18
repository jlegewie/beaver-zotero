/**
 * Which run-blocking request, if any, owns the composer.
 *
 * Several states can block a run at once, and only one of them can occupy the
 * footer. The order below is the whole rule; it lives here rather than inline
 * in a client's sidebar so it stays a single, testable decision that every
 * client answers the same way.
 */

import type { PendingCreditConfirmation } from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import type { PendingQuestion } from '@beaver/agent-core/run-state/pendingQuestions';

export type ComposerTakeover =
    | { kind: 'input' }
    | { kind: 'credit-confirmation'; confirmation: PendingCreditConfirmation }
    | { kind: 'question'; question: PendingQuestion };

/**
 * The blocking state a client actually has.
 *
 * Every member is optional because clients render different subsets of these
 * surfaces: one without an agent-action approval flow, or without an
 * ask_user_question panel, has no value to report rather than a zero or an
 * empty map it invented. Omitting a member means "this client has no such
 * state" and behaves exactly like the empty value, so the precedence between
 * whatever remains is unchanged.
 */
export interface ComposerTakeoverInput {
    pendingApprovalCount?: number;
    creditConfirmations?: ReadonlyMap<string, PendingCreditConfirmation>;
    questions?: ReadonlyMap<string, PendingQuestion>;
}

const INPUT: ComposerTakeover = { kind: 'input' };

/**
 * Pick the composer's occupant.
 *
 * Precedence, highest first:
 *
 * 1. Pending agent-action approvals keep the input area in place. Those
 *    approvals are answered on the action cards in the stream and the input
 *    area owns that flow, so a takeover would hide the controls the run is
 *    waiting on.
 * 2. A pending credit confirmation. It gates the run's spending decision, so
 *    nothing else the run is waiting on can make progress behind it.
 * 3. A pending ask_user_question. Answering it cannot unblock a run that is
 *    already stopped on a credit decision, so it waits its turn.
 *
 * Only one entry of each map is ever live per run; the first is taken when
 * several exist so the choice does not depend on iteration luck.
 */
export function selectComposerTakeover(input: ComposerTakeoverInput): ComposerTakeover {
    if ((input.pendingApprovalCount ?? 0) > 0) return INPUT;

    const confirmation = input.creditConfirmations?.values().next().value;
    if (confirmation) return { kind: 'credit-confirmation', confirmation };

    const question = input.questions?.values().next().value;
    if (question) return { kind: 'question', question };

    return INPUT;
}
