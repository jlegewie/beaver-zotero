import React, { useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { PendingBatchApproval } from '@beaver/agent-core/run-state/pendingBatchApprovals';
import type { BatchApprovalDecision } from '@beaver/agent-core/run-state/batchApprovalAnswers';
import { isRunReconnectingAtom, sendBatchApprovalResponseAtom } from '../../atoms/agentRunAtoms';
import { useStopRun } from '../../hooks/useStopRun';
import BatchApprovalCard from '@beaver/agent-ui/chat/BatchApprovalCard';
import { RECONNECT_HELD_CAPTION } from '@beaver/agent-core/transport/connectionFailure';
import { useRunReconnectShown } from '../../hooks/useVisibleReconnect';

interface BatchApprovalPanelProps {
    approval: PendingBatchApproval;
}

/**
 * Sends a batch approval decision over the run's connection, correlated on
 * the approval id. Shared by every surface that draws the card — this panel
 * and the closed-sidebar status popup — so the wire binding exists once.
 * A no-op without an id, for a surface whose card may not be up.
 */
export function useBatchApprovalSubmit(approvalId: string | null): (decision: BatchApprovalDecision) => void {
    const sendResponse = useSetAtom(sendBatchApprovalResponseAtom);
    return useCallback((decision: BatchApprovalDecision) => {
        if (!approvalId) return;
        sendResponse({
            approvalId,
            approved: decision.approved,
            mode: decision.mode,
            userInstructions: decision.user_instructions,
            table: decision.table,
        });
    }, [sendResponse, approvalId]);
}

/**
 * Composer takeover for a pending batch approval.
 *
 * Rendered by Sidebar INSTEAD of InputArea while the run blocks on the user's
 * decision, so the card sits where the user is already looking and cannot be
 * scrolled away. The user's draft message is untouched — this panel never
 * reads or writes currentMessageContentAtom, so the composer restores the
 * draft when the card goes away.
 *
 * The decision travels back over the run's WebSocket connection, correlated on
 * the approval id the request arrived with. Both answers leave the run alive:
 * cancelling cancels the batch and lets the run continue with the user's
 * instructions in hand, so this panel never closes the connection.
 *
 * While the run's connection is being recovered the card holds both answers
 * back and offers Stop instead, since this panel replaces the composer and
 * its Stop button.
 *
 * The card owns the draft, the coverage mode and the one-shot guard; this
 * panel only binds send and stop.
 */
export const BatchApprovalPanel: React.FC<BatchApprovalPanelProps> = ({ approval }) => {
    const handleSubmit = useBatchApprovalSubmit(approval.approvalId);
    const isReconnecting = useAtomValue(isRunReconnectingAtom);
    const reconnectShown = useRunReconnectShown();
    const handleStop = useStopRun('BatchApprovalPanel');

    return (
        <BatchApprovalCard
            approval={approval}
            onSubmit={handleSubmit}
            disabled={isReconnecting}
            heldCaption={reconnectShown ? RECONNECT_HELD_CAPTION : undefined}
            onStop={handleStop}
        />
    );
};

export default BatchApprovalPanel;
