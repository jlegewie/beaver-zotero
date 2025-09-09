import React, { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { aggregatedErrorMessagesForFailedFilesAtom, errorCodeStatsErrorAtom, errorCodeStatsIsLoadingAtom } from '../../atoms/files';
import { Spinner } from '../icons/icons';
import { useErrorCodeStats } from '../../hooks/useErrorCodeStats';

/**
 * Tooltip content component for displaying processing error codes.
 * Fetches error stats when the tooltip is shown (component mounts).
 */
export const FailedProcessingTooltipContent: React.FC = () => {
    const { fetchStats } = useErrorCodeStats();
    const isLoading = useAtomValue(errorCodeStatsIsLoadingAtom);
    const error = useAtomValue(errorCodeStatsErrorAtom);
    const aggregatedErrorMessagesForFailedFiles = useAtomValue(aggregatedErrorMessagesForFailedFilesAtom);

    // Fetch stats when tooltip is shown (component mounts)
    useEffect(() => {
        fetchStats();
    }, [fetchStats]);

    // Display error codes and counts
    return (
        <div className="display-flex flex-col gap-1">
            <div className="text-base font-color-secondary mb-1 whitespace-nowrap">Processing Errors</div>
            {isLoading &&
                <div className="text-base font-color-secondary mb-1 items-center display-flex flex-row">
                    <div className="mt-1"><Spinner size={14}/></div>
                    <div className="ml-2 font-color-tertiary">Loading...</div>
                </div>
            }
            {!isLoading && error && <div className="text-base font-color-secondary mb-1">{error}</div>}
            {!isLoading && !error && (
                (!aggregatedErrorMessagesForFailedFiles || Object.keys(aggregatedErrorMessagesForFailedFiles).length === 0) ? (
                    <div className="text-base font-color-secondary">No specific error details available.</div>
                ) : (
                    Object.entries(aggregatedErrorMessagesForFailedFiles).map(([errorCode, { message, count }]) => (
                        <div key={message} className="display-flex justify-between items-center text-base whitespace-nowrap">
                            <span className="font-color-tertiary mr-4">{message}:</span>
                            <span className="font-color-secondary font-mono">{count}</span>
                        </div>
                    ))
                )
            )}
        </div>
    );
};
