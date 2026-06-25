import React from 'react';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

interface ConfirmExternalSearchPreviewProps {
    /** Number of additional credits (surcharge) */
    extraCredits: number;
    /** Total credits including base cost */
    totalCredits: number;
    /** Brief label describing the search (e.g., "Hinton's papers") */
    label?: string | null;
    /** Current status of the action */
    status?: ActionStatus;
}

/**
 * Preview component for confirm_external_search actions.
 * Shows a concise cost summary for an external literature search.
 */
export const ConfirmExternalSearchPreview: React.FC<ConfirmExternalSearchPreviewProps> = ({
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
                    <span>Approved external literature search{label ? ` — ${label}` : ''}.</span>
                ) : isRejectedOrUndone ? (
                    <span>Declined external literature search{label ? ` — ${label}` : ''}.</span>
                ) : (
                    <span>
                        {label ? (
                            <>Searching external sources for{' '}
                            <span className="font-color-primary font-medium">{label}</span></>
                        ) : (
                            <>This external search</>
                        )}
                        {' '}will use{' '}
                        <span className="font-color-primary font-medium">
                            {extraCredits} extra credit{extraCredits !== 1 ? 's' : ''}
                        </span>.
                        {' '}You're only charged for successful searches.
                    </span>
                )}
            </div>
        </div>
    );
};

export default ConfirmExternalSearchPreview;
