import React from 'react';
import { useAtomValue } from 'jotai';
import { pendingApprovalsAtom } from '../../agents/agentActions';
import Button from '@beaver/agent-ui/primitives/Button';
import { RECONNECT_UNAVAILABLE_TOOLTIP } from '@beaver/agent-core/transport/connectionFailure';

interface PendingActionsBarProps {
    /** Answer every pending approval. Owned by the composer, which holds the editor. */
    onDecide: (approved: boolean) => void;
    /** A decision is already on its way out; a second one must not overtake it. */
    disabled?: boolean;
    /** Why both answers are unavailable (the run is reconnecting), when it is not that. */
    heldCaption?: string;
}

/**
 * Bar that appears above the input area when there are pending agent actions.
 * Shows the count and provides "Approve All" / "Reject All" buttons.
 *
 * A click here is the same decision as the composer's verdict pair: typed text
 * goes with the answer as user instructions. The composer owns the editor and
 * the one-at-a-time claim on answering.
 */
const PendingActionsBar: React.FC<PendingActionsBarProps> = ({
    onDecide,
    disabled = false,
    heldCaption,
}) => {
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
            {/* The caption wraps under the count: the bar is as narrow as the
                sidebar. The cards themselves announce it. */}
            <div className="display-flex flex-col min-w-0">
                <span className="font-color-primary text-sm">{label}</span>
                {heldCaption && (
                    <span className="font-color-secondary text-sm">{heldCaption}</span>
                )}
            </div>

            {/* Spacer */}
            <div className="flex-1" />

            {/* Right side: approve / reject every pending card */}
            <div className="display-flex flex-row items-center gap-2 flex-none">
                <Button
                    variant="ghost-secondary"
                    onClick={(e) => handleBatchAction(e, false)}
                    disabled={disabled}
                    title={heldCaption ? RECONNECT_UNAVAILABLE_TOOLTIP : undefined}
                    style={{ padding: '2px 8px', fontSize: '0.875rem' }}
                >
                    Reject All
                </Button>
                <Button
                    variant="outline"
                    onClick={(e) => handleBatchAction(e, true)}
                    disabled={disabled}
                    title={heldCaption ? RECONNECT_UNAVAILABLE_TOOLTIP : undefined}
                    style={{ padding: '2px 8px', fontSize: '0.875rem' }}
                >
                    Approve All
                </Button>
            </div>
        </div>
    );
};

export default PendingActionsBar;
