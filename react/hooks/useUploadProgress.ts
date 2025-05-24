import { useState, useEffect, useCallback, useRef } from 'react';
import { AttachmentUploadStatistics } from '../../src/services/database';
import { logger } from '../../src/utils/logger';
import { store } from '../index';
import { userIdAtom } from '../atoms/auth';

// Hook configuration options
interface UseUploadProgressOptions {
    /** Polling interval in milliseconds (default: 1500ms) */
    interval?: number;
    /** Auto-start polling when hook mounts (default: false) */
    autoStart?: boolean;
    /** Auto-stop when all uploads are complete (default: true) */
    autoStop?: boolean;
    /** Callback when polling completes */
    onComplete?: (stats: AttachmentUploadStatistics) => void;
    /** Callback when an error occurs */
    onError?: (error: Error) => void;
}

// Hook return type
interface UseUploadProgressReturn {
    /** Current upload statistics */
    stats: AttachmentUploadStatistics | null;
    /** Whether currently polling */
    isPolling: boolean;
    /** Whether initial load is happening */
    isLoading: boolean;
    /** Any error that occurred */
    error: Error | null;
    /** Start polling */
    startPolling: () => void;
    /** Stop polling */
    stopPolling: () => void;
    /** Manually refresh stats once */
    refresh: () => Promise<void>;
    /** Progress percentage (0-100) */
    progress: number;
    /** Whether upload is complete */
    isComplete: boolean;
}

/**
* Custom hook for polling attachment upload progress
* 
* @param options - Configuration options
*/
export function useUploadProgress(
    options: UseUploadProgressOptions = {}
): UseUploadProgressReturn {
    const {
        interval = 1500,
        autoStart = false,
        autoStop = true,
        onComplete,
        onError
    } = options;
    
    logger(`useUploadProgress: Hook initialized with options: ${interval} ${autoStart} ${autoStop}`);
    
    // State
    const [stats, setStats] = useState<AttachmentUploadStatistics | null>(null);
    const [isPolling, setIsPolling] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<Error | null>(null);
    
    // Refs for cleanup and avoiding stale closures
    const timeoutRef = useRef<NodeJS.Timeout | null>(null);
    const isMountedRef = useRef(true);
    const isPollingRef = useRef(false);
    
    // Derived state
    const progress = stats
        ? (stats.total > 0 ? Math.round(((stats.completed + stats.failed + stats.skipped) / stats.total) * 100) : 0)
        // ? (stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0)
        : 0;
    
    const isComplete = stats
        ? stats.pending === 0 && stats.total > 0 
        : false;
    
    // Fetch statistics function
    const fetchStats = useCallback(async (): Promise<AttachmentUploadStatistics | null> => {
        logger('useUploadProgress: Fetching upload statistics');
        const userId = store.get(userIdAtom);
        
        if (!userId) {
            logger('useUploadProgress: No user ID found, skipping stats fetch');
            return null;
        }
        
        logger(`useUploadProgress: Fetching stats for user: ${userId}`);
        
        try {
            // @ts-ignore Beaver is untyped
            const newStats = await Zotero.Beaver.db.getAttachmentUploadStatistics(userId);
            logger(`useUploadProgress: Successfully fetched upload stats: ${JSON.stringify(newStats)}`);
            return newStats;
        } catch (err) {
            const error = err instanceof Error ? err : new Error('Failed to fetch upload statistics');
            logger(`useUploadProgress: Error fetching upload statistics: ${error.message}`);
            throw error;
        }
    }, []);
    
    // Refresh function (for manual refresh)
    const refresh = useCallback(async () => {
        logger(`useUploadProgress: Manual refresh requested ${isMountedRef.current}`);
        
        if (!isMountedRef.current) {
            logger(`useUploadProgress: Component unmounted, skipping refresh ${isMountedRef.current}`);
            return;
        }
        
        setError(null);
        setIsLoading(true);
        logger('useUploadProgress: Starting refresh, setting loading state');
        
        try {
            const newStats = await fetchStats();
            if (isMountedRef.current && newStats) {
                logger(`useUploadProgress: Refresh successful, updating stats: ${JSON.stringify(newStats)}`);
                setStats(newStats);
            } else if (!isMountedRef.current) {
                logger('useUploadProgress: Component unmounted during refresh, discarding results');
            } else {
                logger('useUploadProgress: Refresh returned null stats');
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error('Unknown error');
            if (isMountedRef.current) {
                logger(`useUploadProgress: Refresh failed with error: ${error.message}`);
                setError(error);
                onError?.(error);
            }
        } finally {
            if (isMountedRef.current) {
                logger(`useUploadProgress: Refresh completed, clearing loading state ${isMountedRef.current}`);
                setIsLoading(false);
            }
        }
    }, [fetchStats, onError]);
    
    // Polling function
    const poll = useCallback(async () => {
        logger(`useUploadProgress: Poll cycle started, mounted: ${isMountedRef.current} isPolling: ${isPollingRef.current}`);
        
        if (!isMountedRef.current || !isPollingRef.current) {
            logger(`useUploadProgress: Skipping poll - component unmounted or polling stopped ${isMountedRef.current} ${isPollingRef.current}`);
            return;
        }
        
        try {
            const newStats = await fetchStats();
            
            if (!isMountedRef.current) {
                logger(`useUploadProgress: Component unmounted during poll, discarding results ${isMountedRef.current}`);
                return;
            }
            
            if (newStats) {
                logger(`useUploadProgress: Poll successful, updating stats. Progress: ${newStats.completed + newStats.failed + newStats.skipped}/${newStats.total} (${Math.round(((newStats.completed + newStats.failed + newStats.skipped) / newStats.total) * 100)}%)`);
                setStats(newStats);
                setError(null);
                
                // Check if upload is complete
                const uploadComplete = newStats.pending === 0 && newStats.total > 0;
                
                if (uploadComplete) {
                    logger(`useUploadProgress: Upload completed! Final stats: ${JSON.stringify(newStats)}`);
                    onComplete?.(newStats);
                    
                    if (autoStop) {
                        logger(`useUploadProgress: Auto-stopping polling after completion ${isMountedRef.current} ${isPollingRef.current}`);
                        isPollingRef.current = false;
                        setIsPolling(false);
                        return; // Don't schedule next poll
                    }
                }
            } else {
                logger(`useUploadProgress: Poll returned null stats ${isMountedRef.current} ${isPollingRef.current}`);
            }
            
            // Schedule next poll if still polling
            if (isMountedRef.current && isPollingRef.current) {
                logger(`useUploadProgress: Scheduling next poll in ${interval}ms`);
                timeoutRef.current = setTimeout(poll, interval);
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error('Polling failed');
            
            if (isMountedRef.current) {
                logger(`useUploadProgress: Poll failed with error: ${error.message} - stopping polling ${isMountedRef.current} ${isPollingRef.current}`);
                setError(error);
                isPollingRef.current = false;
                setIsPolling(false); // Stop polling on error
                onError?.(error);
            }
        }
    }, [fetchStats, interval, autoStop, onComplete, onError]);
    
    // Start polling function
    const startPolling = useCallback(() => {
        logger(`useUploadProgress: Start polling requested, current state: ${isPollingRef.current}`);
        
        if (isPollingRef.current) {
            logger(`useUploadProgress: Already polling, ignoring start request ${isPollingRef.current}`);
            return;
        }
        
        logger(`useUploadProgress: Starting polling with interval: ${interval}ms`);
        isPollingRef.current = true;
        setIsPolling(true);
        setError(null);
        
        // Start polling immediately
        poll();
    }, [poll, interval]);
    
    // Stop polling function
    const stopPolling = useCallback(() => {
        logger(`useUploadProgress: Stop polling requested ${isPollingRef.current}`);
        isPollingRef.current = false;
        setIsPolling(false);
        
        if (timeoutRef.current) {
            logger(`useUploadProgress: Clearing existing timeout ${timeoutRef.current}`);
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }
        
        logger(`useUploadProgress: Polling stopped ${isPollingRef.current}`);
    }, []);
    
    // Sync ref with state
    useEffect(() => {
        isPollingRef.current = isPolling;
    }, [isPolling]);
    
    // Auto-start effect
    useEffect(() => {
        if (autoStart) {
            logger(`useUploadProgress: Auto-start enabled, starting polling ${autoStart}`);
            startPolling();
        } else {
            logger(`useUploadProgress: Auto-start disabled ${autoStart}`);
        }
    }, [autoStart, startPolling]);
    
    // Cleanup effect
    useEffect(() => {
        logger(`useUploadProgress: Hook mounted, setting up cleanup ${isMountedRef.current}`);
        
        return () => {
            logger(`useUploadProgress: Hook unmounting, cleaning up ${isMountedRef.current}`);
            isMountedRef.current = false;
            isPollingRef.current = false;
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
                logger(`useUploadProgress: Cleared timeout during cleanup ${timeoutRef.current}`);
            }
        };
    }, []);
    
    // Stop polling when isPolling changes to false
    useEffect(() => {
        if (!isPolling && timeoutRef.current) {
            logger(`useUploadProgress: Polling state changed to false, clearing timeout ${timeoutRef.current}`);
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }
    }, [isPolling]);
    
    // Log state changes
    useEffect(() => {
        logger(`useUploadProgress: State update - isPolling: ${isPolling} isLoading: ${isLoading} progress: ${progress}%`);
    }, [isPolling, isLoading, progress]);
    
    useEffect(() => {
        if (error) {
            logger(`useUploadProgress: Error state updated: ${error.message}`);
        }
    }, [error]);
    
    useEffect(() => {
        if (stats) {
            logger(`useUploadProgress: Stats updated: ${JSON.stringify(stats)}`);
            logger(`useUploadProgress: Progress: ${progress}%`);
            logger(`useUploadProgress: Is complete: ${isComplete}`);
        }
    }, [stats, progress, isComplete]);
    
    return {
        stats,
        isPolling,
        isLoading,
        error,
        startPolling,
        stopPolling,
        refresh,
        progress,
        isComplete
    };
}