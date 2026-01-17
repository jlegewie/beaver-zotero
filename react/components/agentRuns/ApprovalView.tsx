import React from 'react';
import { useSetAtom } from 'jotai';
import { PendingApproval, clearPendingApprovalAtom } from '../../agents/agentActions';
import { EditMetadataPreview } from './EditMetadataPreview';
import { TickIcon, CancelIcon } from '../icons/icons';

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
        <div className="approval-view border-popup rounded-md overflow-hidden">
            {/* Preview section */}
            <div className="p-3 bg-senary">
                <ApprovalPreview approval={approval} />
            </div>

            {/* Action buttons */}
            <div className="flex flex-row gap-2 p-3 border-top-quinary bg-primary">
                <button
                    type="button"
                    className="flex-1 btn btn-primary flex items-center justify-center gap-1"
                    onClick={handleApprove}
                >
                    <TickIcon className="w-4 h-4" />
                    <span>Apply</span>
                </button>
                <button
                    type="button"
                    className="flex-1 btn btn-secondary flex items-center justify-center gap-1"
                    onClick={handleReject}
                >
                    <CancelIcon className="w-4 h-4" />
                    <span>Reject</span>
                </button>
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
            <pre className="text-xs overflow-auto max-h-32 bg-primary p-2 rounded">
                {JSON.stringify(approval.actionData, null, 2)}
            </pre>
        </div>
    );
};

export default ApprovalView;
