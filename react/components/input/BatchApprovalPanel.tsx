import React, { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import type { PendingBatchApproval } from '@beaver/agent-core/run-state/pendingBatchApprovals';
import type { BatchApprovalDecision } from '@beaver/agent-core/run-state/batchApprovalAnswers';
import { sendBatchApprovalResponseAtom } from '../../atoms/agentRunAtoms';
import BatchApprovalCard from '@beaver/agent-ui/chat/BatchApprovalCard';

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
 * The card owns the draft, the coverage mode and the one-shot guard; this
 * panel only binds send.
 */
export const BatchApprovalPanel: React.FC<BatchApprovalPanelProps> = ({ approval }) => {
    const handleSubmit = useBatchApprovalSubmit(approval.approvalId);

    return (
        <BatchApprovalCard
            approval={approval}
            onSubmit={handleSubmit}
        />
    );
};

export default BatchApprovalPanel;
