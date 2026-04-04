import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { pendingApprovalsAtom } from '../../agents/agentActions';
import { sendApprovalResponseAtom } from '../../atoms/agentRunAtoms';
import { dismissDiffPreview } from '../../utils/noteEditorDiffPreview';
import { diffPreviewNoteKeyAtom } from '../../utils/diffPreviewCoordinator';
import Button from '../ui/Button';

/**
 * Bar that appears above the input area when there are pending agent actions.
 * Shows the count and provides "Approve All" / "Reject All" buttons.
 */
const PendingActionsBar: React.FC = () => {
    const pendingApprovalsMap = useAtomValue(pendingApprovalsAtom);
    const sendApprovalResponse = useSetAtom(sendApprovalResponseAtom);
    const setPendingApprovals = useSetAtom(pendingApprovalsAtom);
    const setDiffPreviewNoteKey = useSetAtom(diffPreviewNoteKeyAtom);

    const pendingCount = pendingApprovalsMap.size;

    // Don't render if no pending approvals
    if (pendingCount === 0) {
        return null;
    }

    const handleBatchAction = (e: React.FormEvent | React.MouseEvent, approved: boolean) => {
        e.preventDefault();
        e.stopPropagation();

        // Dismiss the diff preview first to prevent re-showing during removal.
        // Same batch pattern as handleBannerAction in diffPreviewCoordinator:
        // send all responses, then remove all from the map in one update.
        dismissDiffPreview();
        setDiffPreviewNoteKey(null);

        const idsToRemove: string[] = [];
        for (const pendingApproval of pendingApprovalsMap.values()) {
            sendApprovalResponse({
                actionId: pendingApproval.actionId,
                approved,
            });
            idsToRemove.push(pendingApproval.actionId);
        }
        if (idsToRemove.length > 0) {
            setPendingApprovals((prev) => {
                const next = new Map(prev);
                for (const id of idsToRemove) next.delete(id);
                return next;
            });
        }
    };

    const handleApproveAll = (e: React.FormEvent | React.MouseEvent) => handleBatchAction(e, true);
    const handleRejectAll = (e: React.FormEvent | React.MouseEvent) => handleBatchAction(e, false);

    const label = pendingCount === 1 
        ? '1 Pending Approval' 
        : `${pendingCount} Pending Approvals`;

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
                    onClick={handleApproveAll}
                    style={{ padding: '2px 8px', fontSize: '0.875rem' }}
                >
                    Approve All
                </Button>
            </div>
        </div>
    );
};

export default PendingActionsBar;
