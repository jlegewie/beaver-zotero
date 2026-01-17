import React from 'react';
import { useSetAtom } from 'jotai';
import { PendingApproval, clearPendingApprovalAtom } from '../../agents/agentActions';
import { EditMetadataPreview } from './EditMetadataPreview';
import { TickIcon, CancelIcon } from '../icons/icons';
import Button from '../ui/Button';

interface ApprovalViewProps {
    approval: PendingApproval;
    /** Callback when user approves or rejects */
    onRespond: (approved: boolean) => void;
}

/**
 * Container component for showing deferred action approval UI.
 * Dispatches to action-specific preview components and shows approve/reject buttons.
 */
export const ApprovalView: React.FC<ApprovalViewProps> = ({ approval, onRespond }) => {
    const clearPendingApproval = useSetAtom(clearPendingApprovalAtom);

    const handleApprove = () => {
        onRespond(true);
        clearPendingApproval();
    };

    const handleReject = () => {
        onRespond(false);
        clearPendingApproval();
    };

    return (
        <div className="display-flex flex-col gap-3">
            <div className="approval-view overflow-hidden">
                {/* Preview section */}
                <ApprovalPreview approval={approval} />

            </div>
            {/* Action buttons */}
            <div className="display-flex flex-row gap-2 p-3 border-top-quinary">
                <div className="flex-1" />
                <Button
                    variant="outline"
                    icon={CancelIcon}
                    onClick={handleReject}
                >
                    Reject
                </Button>
                <Button
                    variant="solid"
                    icon={TickIcon}
                    onClick={handleApprove}
                >
                    Apply
                </Button>
            </div>
        </div>
    );
};

/**
 * Dispatches to action-specific preview components.
 */
const ApprovalPreview: React.FC<{ approval: PendingApproval }> = ({ approval }) => {
    if (approval.actionType === 'edit_metadata') {
        const edits = approval.actionData.edits || [];
        const currentValues = approval.currentValue || {};
        return <EditMetadataPreview edits={edits} currentValues={currentValues} />;
    }

    // Fallback for unsupported action types
    return (
        <div className="text-sm font-color-secondary">
            <div className="font-medium mb-1">Action: {approval.actionType}</div>
            <pre className="text-xs overflow-auto max-h-32 p-2 rounded">
                {JSON.stringify(approval.actionData, null, 2)}
            </pre>
        </div>
    );
};

export default ApprovalView;
