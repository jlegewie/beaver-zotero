import { useEffect } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { logger } from '../../src/utils/logger';
import {
    errorCodeStatsAtom,
    fileStatusStatsAtom,
    lastFetchedErrorCountsAtom,
    errorCodeStatsIsLoadingAtom,
    errorCodeStatsErrorAtom
} from '../atoms/files';
import { attachmentsService } from '../../src/services/attachmentsService';
import { planFeaturesAtom } from '../atoms/profile';

/**
 * Custom hook to fetch and manage error code statistics for file processing.
 * It automatically fetches stats when the number of failed or skipped files changes.
 * Fetching is debounced to avoid excessive API calls.
 */
export const useErrorCodeStats = () => {
    const errorCodeStats = useAtomValue(errorCodeStatsAtom);
    const setErrorCodeStats = useSetAtom(errorCodeStatsAtom);
    const planFeatures = useAtomValue(planFeaturesAtom);
    const { failedProcessingCount, planLimitProcessingCount } = useAtomValue(fileStatusStatsAtom);
    const [lastFetchedCounts, setLastFetchedCounts] = useAtom(lastFetchedErrorCountsAtom);


    const setIsLoading = useSetAtom(errorCodeStatsIsLoadingAtom);
    const setError = useSetAtom(errorCodeStatsErrorAtom);
    
    
    useEffect(() => {
        const totalErrors = failedProcessingCount + planLimitProcessingCount;

        const shouldFetch = totalErrors > 0 &&
            (!lastFetchedCounts || failedProcessingCount !== lastFetchedCounts.failed || planLimitProcessingCount !== lastFetchedCounts.skipped);
            
        logger(`useErrorCodeStats: useEffect running with shouldFetch=${shouldFetch} (totalErrors=${totalErrors}, failedProcessingCount=${failedProcessingCount}, planLimitProcessingCount=${planLimitProcessingCount})`);
        if (shouldFetch) {
            logger("useErrorCodeStats: Fetching error code stats");
            const handler = setTimeout(() => {
                setIsLoading(true);
                setError(null);

                // Set the type of processing to fetch stats for
                let type = 'text';
                if (planFeatures.processingTier === 'standard') {
                    type = 'md';
                } else if (planFeatures.processingTier === 'advanced') {
                    type = 'docling';
                }

                // Fetch the error code stats
                attachmentsService.getErrorCodeStats(type as 'text' | 'md' | 'docling')
                    .then(stats => {
                        setErrorCodeStats(stats);
                        setLastFetchedCounts({ failed: failedProcessingCount, skipped: planLimitProcessingCount });
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
        planLimitProcessingCount,
        lastFetchedCounts,
        errorCodeStats,
        setErrorCodeStats,
        setLastFetchedCounts,
        setIsLoading,
        setError,
        planFeatures.processingTier
    ]);
};