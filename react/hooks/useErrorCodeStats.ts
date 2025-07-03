import { useEffect } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { logger } from '../../src/utils/logger';
import {
    errorCodeStatsAtom,
    fileStatusSummaryAtom,
    lastFetchedErrorCountsAtom,
    errorCodeStatsIsLoadingAtom,
    errorCodeStatsErrorAtom
} from '../atoms/files';
import { attachmentsService } from '../../src/services/attachmentsService';
import { planFeaturesAtom } from '../atoms/profile';

const DEBOUNCE_DELAY = 1000;

/**
 * Custom hook to fetch and manage error code statistics for file processing.
 * It automatically fetches stats when the number of failed or skipped files changes.
 * Fetching is debounced to avoid excessive API calls.
 * Uses in-memory caching to avoid redundant backend calls.
 */
export const useErrorCodeStats = () => {
    const errorCodeStats = useAtomValue(errorCodeStatsAtom);
    const setErrorCodeStats = useSetAtom(errorCodeStatsAtom);
    const planFeatures = useAtomValue(planFeaturesAtom);
    const { failedProcessingCount, planLimitProcessingCount } = useAtomValue(fileStatusSummaryAtom);
    const [lastFetchedCounts, setLastFetchedCounts] = useAtom(lastFetchedErrorCountsAtom);

    const setIsLoading = useSetAtom(errorCodeStatsIsLoadingAtom);
    const setError = useSetAtom(errorCodeStatsErrorAtom);
    
    useEffect(() => {
        const totalErrors = failedProcessingCount + planLimitProcessingCount;

        // If no errors, clear the stats and cache
        if (totalErrors === 0) {
            if (errorCodeStats !== null) {
                setErrorCodeStats(null);
                setLastFetchedCounts(null);
            }
            return;
        }

        // Check if we have valid cached data for current counts and processing tier
        const hasValidCache = lastFetchedCounts &&
            failedProcessingCount === lastFetchedCounts.failed &&
            planLimitProcessingCount === lastFetchedCounts.skipped &&
            lastFetchedCounts.processingTier === planFeatures.processingTier &&
            errorCodeStats !== null;

        const shouldFetch = totalErrors > 0 && !hasValidCache;
            
        logger(`useErrorCodeStats: useEffect running with shouldFetch=${shouldFetch} (totalErrors=${totalErrors}, hasValidCache=${hasValidCache}, failedProcessingCount=${failedProcessingCount}, planLimitProcessingCount=${planLimitProcessingCount})`);
        
        if (shouldFetch) {
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
                        logger(`useErrorCodeStats: Fetched error code stats for ${type}: ${JSON.stringify(stats)}`);
                        setErrorCodeStats(stats);
                        setLastFetchedCounts({ 
                            failed: failedProcessingCount, 
                            skipped: planLimitProcessingCount,
                            processingTier: planFeatures.processingTier
                        });
                    })
                    .catch(err => {
                        console.error("Failed to fetch error code stats:", err);
                        setError("Could not load details.");
                    })
                    .finally(() => {
                        setIsLoading(false);
                    });
            }, DEBOUNCE_DELAY);

            return () => {
                clearTimeout(handler);
            };
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