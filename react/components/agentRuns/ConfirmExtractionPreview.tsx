import React from 'react';

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
 * Shows a concise cost summary for a batch extraction.
 */
export const ConfirmExtractionPreview: React.FC<ConfirmExtractionPreviewProps> = ({
    attachmentCount,
    totalCredits,
    status = 'pending',
}) => {
    const isRejectedOrUndone = status === 'rejected' || status === 'undone';
    const isApplied = status === 'applied';

    return (
        <div className={`confirm-extraction-preview overflow-hidden ${isRejectedOrUndone ? 'opacity-60' : ''}`}>
            <div className="px-3 py-3 text-sm font-color-secondary">
                {isApplied ? (
                    <span>Approved extraction from {attachmentCount} paper{attachmentCount !== 1 ? 's' : ''} ({totalCredits} request{totalCredits !== 1 ? 's' : ''}).</span>
                ) : isRejectedOrUndone ? (
                    <span>Declined extraction from {attachmentCount} paper{attachmentCount !== 1 ? 's' : ''}.</span>
                ) : (
                    <span>
                        Extracting from <span className="font-color-primary font-medium">{attachmentCount} paper{attachmentCount !== 1 ? 's' : ''}</span> will
                        use <span className="font-color-primary font-medium">{totalCredits} extra request{totalCredits !== 1 ? 's' : ''}</span>.
                    </span>
                )}
            </div>
        </div>
    );
};

export default ConfirmExtractionPreview;
