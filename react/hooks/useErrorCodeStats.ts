import { useEffect, useCallback } from 'react';
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

/**
 * Custom hook to fetch and manage error code statistics for file processing.
 * Only fetches when explicitly called, with caching to avoid redundant requests.
 */
export const useErrorCodeStats = () => {
    const errorCodeStats = useAtomValue(errorCodeStatsAtom);
    const setErrorCodeStats = useSetAtom(errorCodeStatsAtom);
    const planFeatures = useAtomValue(planFeaturesAtom);
    const { failedProcessingCount, planLimitProcessingCount } = useAtomValue(fileStatusSummaryAtom);
    const [lastFetchedCounts, setLastFetchedCounts] = useAtom(lastFetchedErrorCountsAtom);

    const setIsLoading = useSetAtom(errorCodeStatsIsLoadingAtom);
    const setError = useSetAtom(errorCodeStatsErrorAtom);
    
    // Clear stats when there are no errors
    useEffect(() => {
        const totalErrors = failedProcessingCount + planLimitProcessingCount;
        if (totalErrors === 0) {
            if (errorCodeStats !== null) {
                setErrorCodeStats(null);
                setLastFetchedCounts(null);
            }
        }
    }, [failedProcessingCount, planLimitProcessingCount, errorCodeStats, setErrorCodeStats, setLastFetchedCounts]);

    const fetchStats = useCallback(async () => {
        const totalErrors = failedProcessingCount + planLimitProcessingCount;

        // Don't fetch if no errors
        if (totalErrors === 0) {
            return;
        }

        // Check if we have valid cached data for current counts and processing tier
        const hasValidCache = lastFetchedCounts &&
            failedProcessingCount === lastFetchedCounts.failed &&
            planLimitProcessingCount === lastFetchedCounts.skipped &&
            lastFetchedCounts.processingTier === planFeatures.processingTier &&
            errorCodeStats !== null;

        // Don't fetch if we have valid cached data
        if (hasValidCache) {
            logger(`useErrorCodeStats: Using cached data for failed=${failedProcessingCount}, skipped=${planLimitProcessingCount}, tier=${planFeatures.processingTier}`);
            return;
        }

        logger(`useErrorCodeStats: Fetching error code stats for failed=${failedProcessingCount}, skipped=${planLimitProcessingCount}, tier=${planFeatures.processingTier}`);
        
        setIsLoading(true);
        setError(null);

        try {
            // Set the type of processing to fetch stats for
            let type = 'text';
            if (planFeatures.processingTier === 'standard') {
                type = 'md';
            } else if (planFeatures.processingTier === 'advanced') {
                type = 'docling';
            }

            // Fetch the error code stats
            const stats = await attachmentsService.getErrorCodeStats(type as 'text' | 'md' | 'docling');
            
            logger(`useErrorCodeStats: Fetched error code stats for ${type}: ${JSON.stringify(stats)}`);
            setErrorCodeStats(stats);
            setLastFetchedCounts({ 
                failed: failedProcessingCount, 
                skipped: planLimitProcessingCount,
                processingTier: planFeatures.processingTier
            });
        } catch (err) {
            console.error("Failed to fetch error code stats:", err);
            setError("Could not load details.");
        } finally {
            setIsLoading(false);
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

    return { fetchStats };
};