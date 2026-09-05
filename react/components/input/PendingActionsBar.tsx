import React from 'react';
import { useAtomValue } from 'jotai';
import { pendingApprovalsAtom } from '../../agents/agentActions';
import Button from '@beaver/agent-ui/primitives/Button';

interface PendingActionsBarProps {
    /** Answer every pending approval. Owned by the composer, which holds the editor. */
    onDecide: (approved: boolean) => void;
    /** A decision is already on its way out; a second one must not overtake it. */
    disabled?: boolean;
}

/**
 * Bar that appears above the input area when there are pending agent actions.
 * Shows the count and provides "Approve All" / "Reject All" buttons.
 *
 * A decision on the changes alone: it neither sends what the user has typed nor
 * clears it. Sending a message with the decision is the composer's own pair of
 * verdict buttons, which stand in for Send once the field holds anything.
 *
 * Taking the decision still belongs to the composer, which owns the editor and
 * the one-at-a-time claim on answering.
 */
const PendingActionsBar: React.FC<PendingActionsBarProps> = ({ onDecide, disabled = false }) => {
    const pendingApprovalsMap = useAtomValue(pendingApprovalsAtom);

    const pendingCount = pendingApprovalsMap.size;

    // Don't render if no pending approvals
    if (pendingCount === 0) {
        return null;
    }

    const handleBatchAction = (e: React.FormEvent | React.MouseEvent, approved: boolean) => {
        e.preventDefault();
        e.stopPropagation();
        onDecide(approved);
    };

    const label = pendingCount === 1
        ? '1 Pending Approval'
        : `${pendingCount} Pending Approvals`;

    return (
        <div className="composer-docked-bar pending-actions-bar display-flex flex-row items-center px-3 py-2 border-bottom-quinary gap-2">
            {/* Left side: Count, and what happens to a typed message */}
            <span className="font-color-primary text-sm flex-none">{label}</span>

            {/* Spacer */}
            <div className="flex-1" />

            {/* Right side: Action buttons */}
            <div className="display-flex flex-row items-center gap-2 flex-none">
                <Button
                    variant="ghost-secondary"
                    onClick={(e) => handleBatchAction(e, false)}
                    disabled={disabled}
                    style={{ padding: '2px 8px', fontSize: '0.875rem' }}
                >
                    Reject All
                </Button>
                <Button
                    variant="outline"
                    onClick={(e) => handleBatchAction(e, true)}
                    disabled={disabled}
                    style={{ padding: '2px 8px', fontSize: '0.875rem' }}
                >
                    Approve All
                </Button>
            </div>
        </div>
    );
};

export default PendingActionsBar;
