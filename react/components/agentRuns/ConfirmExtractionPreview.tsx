import React from 'react';
import { Icon, DollarCircleIcon } from '../icons/icons';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

interface ConfirmExtractionPreviewProps {
    /** Total number of attachments to extract from */
    attachmentCount: number;
    /** Number of additional credits (surcharge) */
    extraCredits: number;
    /** Total credits including base cost */
    totalCredits: number;
    /** Number of papers included in base cost */
    includedFree: number;
    /** Current status of the action */
    status?: ActionStatus;
}

/**
 * Preview component for confirm_extraction actions.
 * Shows the cost breakdown for a large extraction.
 */
export const ConfirmExtractionPreview: React.FC<ConfirmExtractionPreviewProps> = ({
    attachmentCount,
    extraCredits,
    totalCredits,
    includedFree,
    status = 'pending',
}) => {
    const isApplied = status === 'applied';
    const isRejectedOrUndone = status === 'rejected' || status === 'undone';
    const additionalPapers = attachmentCount - includedFree;

    return (
        <div className={`confirm-extraction-preview overflow-hidden ${isRejectedOrUndone ? 'opacity-60' : ''}`}>
            <div className="flex flex-col px-3 py-2 gap-2">
                {/* Main info */}
                <div className="display-flex flex-row items-center gap-2">
                    <Icon icon={DollarCircleIcon} className="font-color-secondary" />
                    <span className="text-sm font-color-primary font-medium">
                        Extract from {attachmentCount} paper{attachmentCount !== 1 ? 's' : ''}
                    </span>
                </div>

                {/* Cost breakdown */}
                <div className="flex flex-col gap-1 ml-6 text-sm font-color-secondary">
                    <div>
                        Estimated cost: {totalCredits} request{totalCredits !== 1 ? 's' : ''}
                    </div>
                    {extraCredits > 0 && (
                        <div className="text-xs">
                            {includedFree} paper{includedFree !== 1 ? 's' : ''} included free, {additionalPapers} additional
                        </div>
                    )}
                </div>

                {/* Status message for resolved states */}
                {isApplied && (
                    <div className="text-xs font-color-secondary ml-6 italic">
                        Approved
                    </div>
                )}
                {isRejectedOrUndone && (
                    <div className="text-xs font-color-secondary ml-6 italic">
                        Declined
                    </div>
                )}
            </div>
        </div>
    );
};

export default ConfirmExtractionPreview;
