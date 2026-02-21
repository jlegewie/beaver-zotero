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
    /** Brief label describing the extraction (e.g., "Extracting wealth measures") */
    label?: string | null;
    /** Current status of the action */
    status?: ActionStatus;
}

/**
 * Preview component for confirm_extraction actions.
 * Shows a concise cost summary for a batch extraction.
 */
export const ConfirmExtractionPreview: React.FC<ConfirmExtractionPreviewProps> = ({
    attachmentCount,
    extraCredits,
    label,
    status = 'pending',
}) => {
    const isRejectedOrUndone = status === 'rejected' || status === 'undone';
    const isApplied = status === 'applied';

    return (
        <div className={`confirm-extraction-preview overflow-hidden ${isRejectedOrUndone ? 'opacity-60' : ''}`}>
            <div className="px-3 py-3 text-sm font-color-secondary">
                {isApplied ? (
                    <span>Approved extraction from {attachmentCount} paper{attachmentCount !== 1 ? 's' : ''}{label ? ` — ${label}` : ''}.</span>
                ) : isRejectedOrUndone ? (
                    <span>Declined extraction from {attachmentCount} paper{attachmentCount !== 1 ? 's' : ''}{label ? ` — ${label}` : ''}.</span>
                ) : (
                    <span>
                        {label ? (
                            <>Extracting{' '}
                            <span className="font-color-primary font-medium">{label}</span>
                            {' '}from{' '}
                            <span className="font-color-primary font-medium">{attachmentCount} paper{attachmentCount !== 1 ? 's' : ''}</span></>
                        ) : (
                            <>Extracting from{' '}
                            <span className="font-color-primary font-medium">{attachmentCount} paper{attachmentCount !== 1 ? 's' : ''}</span></>
                        )}
                        {' '}will use up to{' '}
                        <span className="font-color-primary font-medium">{extraCredits} extra credit{extraCredits !== 1 ? 's' : ''}</span>.
                        {' '}You're only charged for successful extractions.
                    </span>
                )}
            </div>
        </div>
    );
};

export default ConfirmExtractionPreview;
