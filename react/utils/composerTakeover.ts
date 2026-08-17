/**
 * Which run-blocking request, if any, owns the composer.
 *
 * Three states can block a run at once, and only one of them can occupy the
 * footer. The order below is the whole rule; keep it here rather than inline in
 * the sidebar so it stays a single, testable decision.
 */

import type { PendingCreditConfirmation } from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import type { PendingQuestion } from '@beaver/agent-core/run-state/pendingQuestions';

export type ComposerTakeover =
    | { kind: 'input' }
    | { kind: 'credit-confirmation'; confirmation: PendingCreditConfirmation }
    | { kind: 'question'; question: PendingQuestion };

const INPUT: ComposerTakeover = { kind: 'input' };

/**
 * Pick the composer's occupant.
 *
 * Precedence, highest first:
 *
 * 1. Pending agent-action approvals keep InputArea in place. Those approvals
 *    are answered on the action cards in the stream and InputArea owns that
 *    flow, so a takeover would hide the controls the run is waiting on.
 * 2. A pending credit confirmation. It gates the run's spending decision, so
 *    nothing else the run is waiting on can make progress behind it.
 * 3. A pending ask_user_question. Answering it cannot unblock a run that is
 *    already stopped on a credit decision, so it waits its turn.
 *
 * Only one entry of each map is ever live per run; the first is taken when
 * several exist so the choice does not depend on iteration luck.
 */
export function selectComposerTakeover(
    pendingApprovalCount: number,
    pendingCreditConfirmations: ReadonlyMap<string, PendingCreditConfirmation>,
    pendingQuestions: ReadonlyMap<string, PendingQuestion>,
): ComposerTakeover {
    if (pendingApprovalCount > 0) return INPUT;

    const confirmation = pendingCreditConfirmations.values().next().value;
    if (confirmation) return { kind: 'credit-confirmation', confirmation };

    const question = pendingQuestions.values().next().value;
    if (question) return { kind: 'question', question };

    return INPUT;
}
