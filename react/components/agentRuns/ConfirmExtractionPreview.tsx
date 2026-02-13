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
    const isRejectedOrUndone = status === 'rejected' || status === 'undone';
    const additionalPapers = attachmentCount - includedFree;

    // Use warning styling for the cost box
    const warningStyle = {
        backgroundColor: 'var(--tag-yellow-senary)',
        border: '1px solid var(--tag-yellow-quarternary)',
    };

    return (
        <div className={`confirm-extraction-preview overflow-hidden ${isRejectedOrUndone ? 'opacity-60' : ''}`}>
            <div className="flex flex-col px-3 py-3 gap-3">
                {/* Summary Text */}
                <div className="text-sm font-color-primary">
                    You are about to extract data from <span className="font-semibold">{attachmentCount} papers</span>.
                </div>

                {/* Cost Box */}
                <div 
                    className="flex flex-col gap-2 rounded-md p-3 text-sm"
                    style={warningStyle}
                >
                    <div className="flex flex-row items-center gap-2 font-medium" style={{ color: 'var(--tag-orange)' }}>
                        <Icon icon={DollarCircleIcon} />
                        <span>Additional Cost Required</span>
                    </div>

                    <div className="flex flex-col gap-1">
                        <div className="flex justify-between text-xs font-color-secondary">
                            <span>Base limit (included):</span>
                            <span>{includedFree} paper{includedFree !== 1 ? 's' : ''}</span>
                        </div>
                        <div className="flex justify-between text-xs font-color-secondary">
                            <span>Additional (charged):</span>
                            <span>{additionalPapers} paper{additionalPapers !== 1 ? 's' : ''}</span>
                        </div>
                        
                        <div className="my-1" style={{ borderTop: '1px solid var(--tag-yellow-quarternary)' }}></div>
                        
                        <div className="flex justify-between font-bold font-color-primary">
                            <span>Total Cost:</span>
                            <span>{totalCredits} request{totalCredits !== 1 ? 's' : ''}</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ConfirmExtractionPreview;
