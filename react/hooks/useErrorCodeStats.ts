import { useState, useEffect } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { errorCodeStatsAtom, fileStatusStatsAtom, lastFetchedErrorCountsAtom } from '../atoms/files';
import { attachmentsService } from '../../src/services/attachmentsService';

/**
 * Custom hook to fetch and manage error code statistics for file processing.
 * It automatically fetches stats when the number of failed or skipped files changes.
 * 
 * @returns An object containing the loading and error state of the fetch operation.
 */
export const useErrorCodeStats = () => {
    const [errorCodeStats, setErrorCodeStats] = useAtom(errorCodeStatsAtom);
    const { failedProcessingCount, skippedProcessingCount } = useAtomValue(fileStatusStatsAtom);
    const [lastFetchedCounts, setLastFetchedCounts] = useAtom(lastFetchedErrorCountsAtom);

    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const totalErrors = failedProcessingCount + skippedProcessingCount;

        const shouldFetch = totalErrors > 0 &&
            (!lastFetchedCounts ||
             failedProcessingCount !== lastFetchedCounts.failed ||
             skippedProcessingCount !== lastFetchedCounts.skipped);

        if (shouldFetch) {
            setIsLoading(true);
            setError(null);
            attachmentsService.getErrorCodeStats('md')
                .then(stats => {
                    setErrorCodeStats(stats);
                    setLastFetchedCounts({ failed: failedProcessingCount, skipped: skippedProcessingCount });
                })
                .catch(err => {
                    console.error("Failed to fetch error code stats:", err);
                    setError("Could not load details.");
                })
                .finally(() => {
                    setIsLoading(false);
                });
        } else if (totalErrors === 0 && errorCodeStats !== null) {
            // Reset stats if error count goes to 0
            setErrorCodeStats(null);
            setLastFetchedCounts(null);
        }
    }, [
        failedProcessingCount,
        skippedProcessingCount,
        lastFetchedCounts,
        setErrorCodeStats,
        setLastFetchedCounts,
        errorCodeStats
    ]);

    return { isLoading, error };
};