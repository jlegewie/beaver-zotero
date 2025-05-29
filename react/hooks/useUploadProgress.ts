import { useEffect, useCallback, useRef } from 'react';
import { AttachmentUploadStatistics } from '../../src/services/database';
import { logger } from '../../src/utils/logger';
import { store } from '../index';
import { userIdAtom } from '../atoms/auth';
import { fileUploader } from '../../src/services/FileUploader';
import { uploadStatsAtom, uploadErrorAtom, uploadProgressAtom, isUploadCompleteAtom } from '../atoms/status';
import { useSetAtom } from 'jotai';


// Hook configuration options
interface UseUploadProgressOptions {
    /** Polling interval in milliseconds (default: 1500ms) */
    interval?: number;
    /** Auto-stop when all uploads are complete (default: true) */
    autoStop?: boolean;
    /** Callback when polling completes */
    onComplete?: (stats: AttachmentUploadStatistics) => void;
    /** Callback when an error occurs */
    onError?: (error: Error) => void;
}

/**
* Custom hook for polling attachment upload progress
* 
* @param options - Configuration options
*/
export function useUploadProgress(
    options: UseUploadProgressOptions = {}
): void {
    const {
        interval = 1500,
        autoStop = true,
        onComplete,
        onError
    } = options;
    
    logger(`useUploadProgress: Hook initialized with options: ${interval} ${autoStop}`);
    
    // Atom setters
    const setUploadStats = useSetAtom(uploadStatsAtom);
    const setUploadError = useSetAtom(uploadErrorAtom);
    const setUploadProgress = useSetAtom(uploadProgressAtom);
    const setIsUploadComplete = useSetAtom(isUploadCompleteAtom);
    
    // Refs for cleanup and avoiding stale closures
    const timeoutRef = useRef<NodeJS.Timeout | null>(null);
    const isMountedRef = useRef(true); // Initialized to true
    const isPollingRef = useRef(true); // Always start as true
    
    // Effect to manage isMountedRef correctly based on component lifecycle
    useEffect(() => {
        // isMountedRef is true upon initialization and during the component's mounted lifecycle.
        // This effect's cleanup function will run only when the component unmounts.
        return () => {
            logger(`useUploadProgress: Component unmounting, setting isMountedRef to false.`);
            isMountedRef.current = false;
        };
    }, []); // Empty dependency array: runs on mount and cleans up on unmount

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
            const newStats = await Zotero.Beaver.db.getAttachmentUploadStatistics(userId);
            logger(`useUploadProgress: Successfully fetched upload stats: ${JSON.stringify(newStats)}`);
            return newStats;
        } catch (err) {
            const error = err instanceof Error ? err : new Error('Failed to fetch upload statistics');
            logger(`useUploadProgress: Error fetching upload statistics: ${error.message}`);
            throw error;
        }
    }, []);
    
    // Polling function
    const poll = useCallback(async () => {
        logger(`useUploadProgress: Poll cycle started, mounted: ${isMountedRef.current} isPolling: ${isPollingRef.current}`);
        
        if (!isMountedRef.current || !isPollingRef.current) {
            logger(`useUploadProgress: Skipping poll - component unmounted or polling stopped. Mounted: ${isMountedRef.current}, Polling: ${isPollingRef.current}`);
            return;
        }
        
        try {
            const newStats = await fetchStats();
            
            if (!isMountedRef.current) {
                logger(`useUploadProgress: Component unmounted during poll (after fetch), discarding results. Mounted: ${isMountedRef.current}`);
                return;
            }
            
            if (newStats) {
                logger(`useUploadProgress: Poll successful, updating stats. Progress: ${newStats.completed + newStats.failed + newStats.skipped}/${newStats.total} (${Math.round(((newStats.completed + newStats.failed + newStats.skipped) / newStats.total) * 100)}%)`);
                
                // Update atoms - ensure component is mounted before state updates
                setUploadStats(newStats);
                setUploadError(null);
                
                const progress = newStats.total > 0 ? Math.round((newStats.completed / newStats.total) * 100) : 0;
                setUploadProgress(progress);
                
                const uploadComplete = newStats.pending === 0 && newStats.total > 0;
                setIsUploadComplete(uploadComplete);
                
                if (uploadComplete) {
                    logger(`useUploadProgress: Upload completed! Final stats: ${JSON.stringify(newStats)}`);
                    onComplete?.(newStats);
                    
                    if (autoStop) {
                        logger(`useUploadProgress: Auto-stopping polling after completion. Mounted: ${isMountedRef.current}, Polling: ${isPollingRef.current}`);
                        isPollingRef.current = false;
                    }
                }
                
                // Start file uploader if there are pending files
                if (newStats.pending > 0) {
                    fileUploader.start("manual");
                }
            } else {
                logger(`useUploadProgress: Poll returned null stats. Mounted: ${isMountedRef.current}, Polling: ${isPollingRef.current}`);
            }
            
            // Schedule next poll if still mounted and polling
            if (isMountedRef.current && isPollingRef.current) {
                logger(`useUploadProgress: Scheduling next poll in ${interval}ms`);
                timeoutRef.current = setTimeout(poll, interval);
            } else {
                logger(`useUploadProgress: Not scheduling next poll. Mounted: ${isMountedRef.current}, Polling: ${isPollingRef.current}`);
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error('Polling failed');
            
            if (isMountedRef.current) {
                logger(`useUploadProgress: Poll failed with error: ${error.message} - stopping polling. Mounted: ${isMountedRef.current}, Polling: ${isPollingRef.current}`);
                setUploadError(error);
                isPollingRef.current = false; // Stop polling on error
                onError?.(error);
            } else {
                logger(`useUploadProgress: Poll failed but component unmounted. Error: ${error.message}. Mounted: ${isMountedRef.current}`);
            }
        }
    }, [fetchStats, interval, autoStop, onComplete, onError, setUploadStats, setUploadError, setUploadProgress, setIsUploadComplete]);
    
    // Start polling immediately when hook mounts or dependencies change
    useEffect(() => {
        logger(`useUploadProgress: Polling useEffect setup. Interval: ${interval}ms. Starting polling.`);
        isPollingRef.current = true; // Ensure polling is active
        
        poll(); // Start polling immediately
        
        return () => {
            // This cleanup runs if:
            // 1. Component unmounts (isMountedRef will be false due to the other effect)
            // 2. Dependencies (poll, interval) change
            logger(`useUploadProgress: Polling useEffect cleanup. Mounted: ${isMountedRef.current}. Clearing timeout and setting isPollingRef to false.`);
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
                logger(`useUploadProgress: Cleared timeout ${timeoutRef.current} during polling useEffect cleanup.`);
                timeoutRef.current = null;
            }
            // Stop the current polling logic if dependencies changed or component is unmounting.
            isPollingRef.current = false; 
        };
    }, [poll, interval]);
}