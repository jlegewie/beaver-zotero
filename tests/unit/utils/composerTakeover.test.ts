/**
 * Composer takeover precedence.
 *
 * Three run-blocking states can be live at once and only one can occupy the
 * footer. These tests pin the order, because getting it wrong strands the user
 * on a card that cannot unblock the run.
 */
import { describe, expect, it } from 'vitest';

import type { PendingCreditConfirmation } from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import type { PendingQuestion } from '@beaver/agent-core/run-state/pendingQuestions';
import { selectComposerTakeover } from '../../../react/utils/composerTakeover';

function confirmation(id = 'conf-1'): PendingCreditConfirmation {
    return {
        confirmationId: id,
        runId: 'run-1',
        threadId: 'thread-1',
        title: 'Continue?',
        message: 'Over your limit.',
        details: [],
        approveLabel: 'Continue',
        declineLabel: 'Wrap up now',
        pendingCredits: 4,
        projectedTotalCredits: 9,
        threshold: 5,
        timeoutSeconds: 300,
    };
}

function question(toolcallId = 'call-1'): PendingQuestion {
    return {
        questionId: 'q-1',
        toolcallId,
        title: 'Topic',
        questions: [],
    };
}

const noConfirmations = new Map<string, PendingCreditConfirmation>();
const noQuestions = new Map<string, PendingQuestion>();

describe('selectComposerTakeover', () => {
    it('leaves the composer in place when nothing is pending', () => {
        expect(selectComposerTakeover(0, noConfirmations, noQuestions)).toEqual({ kind: 'input' });
    });

    it('picks the credit confirmation over a pending question', () => {
        const takeover = selectComposerTakeover(
            0,
            new Map([['conf-1', confirmation()]]),
            new Map([['call-1', question()]]),
        );

        expect(takeover).toEqual({ kind: 'credit-confirmation', confirmation: confirmation() });
    });

    it('picks the question when only a question is pending', () => {
        const takeover = selectComposerTakeover(
            0,
            noConfirmations,
            new Map([['call-1', question()]]),
        );

        expect(takeover).toEqual({ kind: 'question', question: question() });
    });

    it('keeps InputArea when agent-action approvals are pending, whatever else waits', () => {
        // Those approvals are answered on the action cards in the stream, and
        // InputArea owns that flow — a takeover would hide them.
        const takeover = selectComposerTakeover(
            1,
            new Map([['conf-1', confirmation()]]),
            new Map([['call-1', question()]]),
        );

        expect(takeover).toEqual({ kind: 'input' });
    });

    it('takes the first confirmation when several are somehow live', () => {
        const takeover = selectComposerTakeover(
            0,
            new Map([
                ['conf-1', confirmation('conf-1')],
                ['conf-2', confirmation('conf-2')],
            ]),
            noQuestions,
        );

        expect(takeover).toEqual({
            kind: 'credit-confirmation',
            confirmation: confirmation('conf-1'),
        });
    });
});
