import { useEffect } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
    errorCodeStatsAtom,
    fileStatusStatsAtom,
    lastFetchedErrorCountsAtom,
    errorCodeStatsIsLoadingAtom,
    errorCodeStatsErrorAtom
} from '../atoms/files';
import { attachmentsService } from '../../src/services/attachmentsService';

/**
 * Custom hook to fetch and manage error code statistics for file processing.
 * It automatically fetches stats when the number of failed or skipped files changes.
 * Fetching is debounced to avoid excessive API calls.
 */
export const useErrorCodeStats = () => {
    const errorCodeStats = useAtomValue(errorCodeStatsAtom);
    const setErrorCodeStats = useSetAtom(errorCodeStatsAtom);
    const { failedProcessingCount, skippedProcessingCount } = useAtomValue(fileStatusStatsAtom);
    const [lastFetchedCounts, setLastFetchedCounts] = useAtom(lastFetchedErrorCountsAtom);

    const setIsLoading = useSetAtom(errorCodeStatsIsLoadingAtom);
    const setError = useSetAtom(errorCodeStatsErrorAtom);

    useEffect(() => {
        const totalErrors = failedProcessingCount + skippedProcessingCount;

        const shouldFetch = totalErrors > 0 &&
            (!lastFetchedCounts ||
             failedProcessingCount !== lastFetchedCounts.failed ||
             skippedProcessingCount !== lastFetchedCounts.skipped);

        if (shouldFetch) {
            const handler = setTimeout(() => {
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
            }, 500); // 500ms debounce delay

            return () => {
                clearTimeout(handler);
            };
        } else if (totalErrors === 0 && errorCodeStats !== null) {
            // Reset stats if error count goes to 0
            setErrorCodeStats(null);
            setLastFetchedCounts(null);
        }
    }, [
        failedProcessingCount,
        skippedProcessingCount,
        lastFetchedCounts,
        errorCodeStats,
        setErrorCodeStats,
        setLastFetchedCounts,
        setIsLoading,
        setError,
    ]);
};