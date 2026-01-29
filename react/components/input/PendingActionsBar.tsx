import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { pendingApprovalsAtom, removePendingApprovalAtom } from '../../agents/agentActions';
import { sendApprovalResponseAtom } from '../../atoms/agentRunAtoms';
import Button from '../ui/Button';

/**
 * Bar that appears above the input area when there are pending agent actions.
 * Shows the count and provides "Apply All" / "Reject All" buttons.
 */
const PendingActionsBar: React.FC = () => {
    const pendingApprovalsMap = useAtomValue(pendingApprovalsAtom);
    const sendApprovalResponse = useSetAtom(sendApprovalResponseAtom);
    const removePendingApproval = useSetAtom(removePendingApprovalAtom);

    const pendingCount = pendingApprovalsMap.size;

    // Don't render if no pending approvals
    if (pendingCount === 0) {
        return null;
    }

    const handleApplyAll = (e: React.FormEvent | React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        for (const pendingApproval of pendingApprovalsMap.values()) {
            sendApprovalResponse({
                actionId: pendingApproval.actionId,
                approved: true,
            });
            removePendingApproval(pendingApproval.actionId);
        }
    };

    const handleRejectAll = (e: React.FormEvent | React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        for (const pendingApproval of pendingApprovalsMap.values()) {
            sendApprovalResponse({
                actionId: pendingApproval.actionId,
                approved: false,
            });
            removePendingApproval(pendingApproval.actionId);
        }
    };

    const label = pendingCount === 1 
        ? '1 Pending Change' 
        : `${pendingCount} Pending Changes`;

    return (
        <div className="pending-actions-bar display-flex flex-row items-center px-3 py-2 bg-senary border-bottom-quinary gap-2">
            {/* Left side: Count */}
            <span className="font-color-primary text-sm">{label}</span>

            {/* Spacer */}
            <div className="flex-1" />

            {/* Right side: Action buttons */}
            <div className="display-flex flex-row items-center gap-2">
                <Button
                    variant="ghost-secondary"
                    onClick={handleRejectAll}
                    style={{ padding: '2px 8px', fontSize: '0.875rem' }}
                >
                    Reject All
                </Button>
                <Button
                    variant="outline"
                    onClick={handleApplyAll}
                    style={{ padding: '2px 8px', fontSize: '0.875rem' }}
                >
                    Apply All
                </Button>
            </div>
        </div>
    );
};

export default PendingActionsBar;
