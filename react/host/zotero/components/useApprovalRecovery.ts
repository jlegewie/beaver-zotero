import { useCallback, useEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { logger } from '@beaver/agent-core/platform/logger';
import {
    isWSChatPendingAtom,
    removeApprovalResponseIntentAtom,
    staleApprovalActionIdsAtom,
} from '../../../atoms/agentRunAtoms';
import type { ActionStatus } from './agentActionViewHelpers';

interface ApprovalRecoveryOptions {
    /**
     * Whether this view is waiting on a backend decision — whether it sent the
     * decision itself or another surface did (Approve All, the composer, the
     * diff-preview banner). Both leave the card on a spinner, so both need the
     * same escape.
     */
    isAwaitingDecision: boolean;
    /** True once the tool call this approval belongs to has returned. */
    hasToolReturn: boolean;
    /** Status of the stored action, if one exists yet. */
    actionStatus: ActionStatus | undefined;
    /** Drop the waiting state and restore the view's own apply/reject controls. */
    onRecover: () => void;
    /** Identifies the view in logs. */
    label: string;
}

interface ApprovalRecovery {
    /**
     * Record the decision a click is waiting on. The decision is required, not
     * defaulted: it is what keeps an approval from being abandoned mid-execution
     * (see below), so a call site must say which one it made.
     */
    setProcessingApproval: (decision: { actionId: string; kind: 'approve' | 'reject' } | null) => void;
}

export interface ApprovalRecoverySignals {
    /** The backend told us it is no longer waiting, or the send never went out. */
    isStale: boolean;
    /** The tool call this approval belongs to has returned. */
    hasToolReturn: boolean;
    /** Status of the stored action, if one exists yet. */
    actionStatus: ActionStatus | undefined;
    /** True when the pending decision was a rejection rather than an approval. */
    decisionWasReject: boolean;
    /** Whether a run is still in flight. */
    isRunPending: boolean;
}

/**
 * Whether a decision in flight can be declared lost. Pure so the invariant that
 * matters most — an approval is never abandoned merely because the run
 * stopped — is directly testable.
 */
export function shouldRecoverApproval({
    isStale,
    hasToolReturn,
    actionStatus,
    decisionWasReject,
    isRunPending,
}: ApprovalRecoverySignals): boolean {
    if (isStale) return true;
    if (hasToolReturn && actionStatus === 'pending') return true;
    return decisionWasReject && !isRunPending;
}

/**
 * Restore a view's local controls when a decision the user made never reached
 * the run.
 *
 * Views stop showing apply/reject while an approval is in flight and rely on
 * the action reaching a final status to bring them back. A decision that misses
 * its window never changes that status, so without this the card would wait
 * forever on a reply that cannot come — the user clicked Apply and, as far as
 * the UI is concerned, nothing happened.
 *
 * Two signals prove the channel is closed for any decision:
 *  - the action id was marked stale — the backend answered `deferred_approval_stale`,
 *    or the response never left the client;
 *  - the tool already returned while its action is still `pending`, which is
 *    what a backend-side approval timeout looks like on the wire. Kept as an
 *    independent check so recovery also works against a backend that does not
 *    send the stale event.
 *
 * A third signal — the run no longer being in flight — is only used for a
 * *rejection*. It cannot be trusted for an approval: the backend executes an
 * approved action by asking this client to perform the mutation, and the action
 * only turns `applied` locally when the follow-up `agent_actions` frame lands.
 * Cancelling (or dropping the socket) mid-execution therefore looks exactly
 * like a decision that never arrived, and restoring Apply there would offer to
 * repeat a change that is already being made — duplicating a created
 * collection, note, or item. A rejection executes nothing, so there is nothing
 * to repeat.
 *
 * Recovery is safe because the proposal itself survives: the backend persists
 * it before it starts waiting, so the view's own `status === 'pending'`
 * controls can still apply it.
 *
 * Not covered: an approval whose response was sent and then lost with the
 * connection. Whether it executed is genuinely unknown to this client, so the
 * card keeps waiting rather than risk a duplicate.
 *
 * The rejection-only rule binds this hook, not the whole view. A card that was
 * decided from another surface also has the older `isExternallyProcessing`
 * clear, which releases on `!isRunPending` whatever the decision was — so the
 * mid-execution ambiguity above is still reachable that way. Left as is
 * deliberately: confirm-only approvals (extraction, external search) have no
 * local apply path, so tightening that clear would strand them with nothing to
 * gain, since they mutate nothing.
 */
export function useApprovalRecovery({
    isAwaitingDecision,
    hasToolReturn,
    actionStatus,
    onRecover,
    label,
}: ApprovalRecoveryOptions): ApprovalRecovery {
    // Kept separately from the pending approval itself, which is cleared the
    // moment the response is sent — the id is still needed to match against.
    const [processing, setProcessing] = useState<{ actionId: string; kind: 'approve' | 'reject' } | null>(null);
    const staleApprovalActionIds = useAtomValue(staleApprovalActionIdsAtom);
    const isRunPending = useAtomValue(isWSChatPendingAtom);
    const removeApprovalResponseIntent = useSetAtom(removeApprovalResponseIntentAtom);

    const processingApprovalId = processing?.actionId ?? null;
    const isStale = processingApprovalId !== null
        && staleApprovalActionIds.has(processingApprovalId);
    const decisionWasReject = processing?.kind === 'reject';

    useEffect(() => {
        if (!isAwaitingDecision) return;
        const missedItsWindow = shouldRecoverApproval({
            isStale,
            hasToolReturn,
            actionStatus,
            decisionWasReject,
            isRunPending,
        });
        if (!missedItsWindow) return;

        logger(
            `${label}: approval ${processingApprovalId ?? '(unknown)'} did not reach the run; restoring local controls`,
            1,
        );
        if (processingApprovalId) removeApprovalResponseIntent(processingApprovalId);
        setProcessing(null);
        onRecover();
    }, [
        isAwaitingDecision,
        isStale,
        hasToolReturn,
        actionStatus,
        decisionWasReject,
        isRunPending,
        processingApprovalId,
        removeApprovalResponseIntent,
        onRecover,
        label,
    ]);

    const setProcessingApproval = useCallback(
        (decision: { actionId: string; kind: 'approve' | 'reject' } | null) => {
            setProcessing(decision);
        },
        [],
    );

    return { setProcessingApproval };
}
