import React from 'react';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

interface ConfirmExternalSearchPreviewProps {
    /** Number of additional credits (surcharge) */
    extraCredits: number;
    /** Total credits including base cost */
    totalCredits: number;
    /** Current status of the action */
    status?: ActionStatus;
}

/**
 * Preview component for confirm_external_search actions.
 * Shows a concise cost summary for an external literature search.
 */
export const ConfirmExternalSearchPreview: React.FC<ConfirmExternalSearchPreviewProps> = ({
    extraCredits,
    status = 'pending',
}) => {
    const isRejectedOrUndone = status === 'rejected' || status === 'undone';
    const isApplied = status === 'applied';

    return (
        <div className={`confirm-extraction-preview overflow-hidden ${isRejectedOrUndone ? 'opacity-60' : ''}`}>
            <div className="px-3 py-3 text-sm font-color-secondary">
                {isApplied ? (
                    <span>Approved external literature search.</span>
                ) : isRejectedOrUndone ? (
                    <span>Declined external literature search.</span>
                ) : (
                    <span>
                        This external search will use{' '}
                        <span className="font-color-primary font-medium">
                            {extraCredits} extra request{extraCredits !== 1 ? 's' : ''}
                        </span>.
                    </span>
                )}
            </div>
        </div>
    );
};

export default ConfirmExternalSearchPreview;
