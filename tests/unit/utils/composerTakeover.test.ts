/**
 * Composer takeover precedence.
 *
 * Several run-blocking states can be live at once and only one can occupy the
 * footer. These tests pin the order, because getting it wrong strands the user
 * on a card that cannot unblock the run.
 */
import { describe, expect, it } from 'vitest';

import type { PendingBatchApproval } from '@beaver/agent-core/run-state/pendingBatchApprovals';
import type { PendingCreditConfirmation } from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import type { PendingQuestion } from '@beaver/agent-core/run-state/pendingQuestions';
import { selectComposerTakeover } from '@beaver/agent-ui/chat/composerTakeover';

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

function batchApproval(id = 'approval-1'): PendingBatchApproval {
    return {
        approvalId: id,
        runId: 'run-1',
        threadId: 'thread-1',
        toolcallId: 'call-1',
        batchId: 'b1',
        title: 'Approve batch job',
        message: 'Tag every item.',
        destructiveWarning: '',
        creditNote: '',
        defaultMode: 'full_access',
        approveLabel: 'Approve',
        declineLabel: 'Reject',
        timeoutSeconds: 180,
    };
}

const noConfirmations = new Map<string, PendingCreditConfirmation>();
const noQuestions = new Map<string, PendingQuestion>();

describe('selectComposerTakeover', () => {
    it('leaves the composer in place when nothing is pending', () => {
        expect(
            selectComposerTakeover({
                pendingApprovalCount: 0,
                creditConfirmations: noConfirmations,
                questions: noQuestions,
            }),
        ).toEqual({ kind: 'input' });
    });

    it('picks the batch approval over a credit confirmation and a question', () => {
        // The batch gates the work the credits would be spent on, and
        // declining it can remove the cost altogether.
        const takeover = selectComposerTakeover({
            pendingApprovalCount: 0,
            batchApprovals: new Map([['approval-1', batchApproval()]]),
            creditConfirmations: new Map([['conf-1', confirmation()]]),
            questions: new Map([['call-1', question()]]),
        });

        expect(takeover).toEqual({ kind: 'batch-approval', approval: batchApproval() });
    });

    it('picks the credit confirmation over a pending question', () => {
        const takeover = selectComposerTakeover({
            pendingApprovalCount: 0,
            creditConfirmations: new Map([['conf-1', confirmation()]]),
            questions: new Map([['call-1', question()]]),
        });

        expect(takeover).toEqual({ kind: 'credit-confirmation', confirmation: confirmation() });
    });

    it('picks the question when only a question is pending', () => {
        const takeover = selectComposerTakeover({
            pendingApprovalCount: 0,
            creditConfirmations: noConfirmations,
            questions: new Map([['call-1', question()]]),
        });

        expect(takeover).toEqual({ kind: 'question', question: question() });
    });

    it('keeps InputArea when agent-action approvals are pending, whatever else waits', () => {
        // Those approvals are answered on the action cards in the stream, and
        // InputArea owns that flow — a takeover would hide them.
        const takeover = selectComposerTakeover({
            pendingApprovalCount: 1,
            creditConfirmations: new Map([['conf-1', confirmation()]]),
            questions: new Map([['call-1', question()]]),
        });

        expect(takeover).toEqual({ kind: 'input' });
    });

    it('reads an omitted member as no such state, not as a missing argument', () => {
        // A client without an approval flow or a question panel reports only
        // what it can render; the remaining precedence must not change.
        const takeover = selectComposerTakeover({
            creditConfirmations: new Map([['conf-1', confirmation()]]),
        });

        expect(takeover).toEqual({ kind: 'credit-confirmation', confirmation: confirmation() });
        expect(selectComposerTakeover({})).toEqual({ kind: 'input' });
    });

    it('reads an omitted batch-approval map exactly like an empty one', () => {
        const empty = selectComposerTakeover({
            pendingApprovalCount: 0,
            batchApprovals: new Map<string, PendingBatchApproval>(),
            creditConfirmations: new Map([['conf-1', confirmation()]]),
            questions: noQuestions,
        });
        const omitted = selectComposerTakeover({
            pendingApprovalCount: 0,
            creditConfirmations: new Map([['conf-1', confirmation()]]),
            questions: noQuestions,
        });

        expect(empty).toEqual({ kind: 'credit-confirmation', confirmation: confirmation() });
        expect(omitted).toEqual(empty);
    });

    it('keeps InputArea when agent-action approvals are pending, batch included', () => {
        const takeover = selectComposerTakeover({
            pendingApprovalCount: 1,
            batchApprovals: new Map([['approval-1', batchApproval()]]),
        });

        expect(takeover).toEqual({ kind: 'input' });
    });

    it('takes the first confirmation when several are somehow live', () => {
        const takeover = selectComposerTakeover({
            pendingApprovalCount: 0,
            creditConfirmations: new Map([
                ['conf-1', confirmation('conf-1')],
                ['conf-2', confirmation('conf-2')],
            ]),
            questions: noQuestions,
        });

        expect(takeover).toEqual({
            kind: 'credit-confirmation',
            confirmation: confirmation('conf-1'),
        });
    });
});
