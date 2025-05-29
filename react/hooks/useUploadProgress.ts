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
export function useUploadProgress(options: UseUploadProgressOptions = {}): void {
    const initializedRef = useRef(false);

    const {
        interval = 1500,
        autoStop = true,
        onComplete,
        onError
    } = options;

    if (!initializedRef.current) {
        logger(`useUploadProgress: Hook initialized with options: interval=${interval}, autoStop=${autoStop}`);
        initializedRef.current = true;
    }
    
    // Use refs for values that might change
    const optionsRef = useRef({ interval, autoStop, onComplete, onError });
    optionsRef.current = { interval, autoStop, onComplete, onError };
    
    // Refs for state management
    const timeoutRef = useRef<NodeJS.Timeout | null>(null);
    const isMountedRef = useRef(true);
    const isPollingRef = useRef(true);
    const lastPollTimeRef = useRef<number>(0);
    const isPollingInProgressRef = useRef(false);
    
    // Atom setters (stable references)
    const setUploadStats = useSetAtom(uploadStatsAtom);
    const setUploadError = useSetAtom(uploadErrorAtom);
    const setUploadProgress = useSetAtom(uploadProgressAtom);
    const setIsUploadComplete = useSetAtom(isUploadCompleteAtom);
    
    // Fetch statistics function
    const fetchStats = useCallback(async (): Promise<AttachmentUploadStatistics | null> => {
        const userId = store.get(userIdAtom);
        
        if (!userId) {
            logger('useUploadProgress: No user ID found, skipping stats fetch');
            return null;
        }
        
        try {
            const newStats = await Zotero.Beaver.db.getAttachmentUploadStatistics(userId);
            logger(`useUploadProgress: Fetched stats - Total: ${newStats.total}, Completed: ${newStats.completed}, Pending: ${newStats.pending}, Failed: ${newStats.failed}`);
            return newStats;
        } catch (err) {
            const error = err instanceof Error ? err : new Error('Failed to fetch upload statistics');
            logger(`useUploadProgress: Error fetching upload statistics: ${error.message}`);
            throw error;
        }
    }, []);
    
    // Polling function
    const poll = useCallback(async () => {
        if (!isMountedRef.current || !isPollingRef.current || isPollingInProgressRef.current) {
            return;
        }
        
        isPollingInProgressRef.current = true;
        const pollStartTime = Date.now();
        
        try {
            const newStats = await fetchStats();
            
            if (!isMountedRef.current) {
                return;
            }
            
            if (newStats) {
                setUploadStats(newStats);
                setUploadError(null);
                
                const progress = newStats.total > 0 
                    ? Math.round((newStats.completed / newStats.total) * 100) 
                    : 0;
                setUploadProgress(progress);
                
                const uploadComplete = newStats.pending === 0 && newStats.total > 0;
                setIsUploadComplete(uploadComplete);
                
                if (uploadComplete) {
                    logger(`useUploadProgress: Upload completed! Final stats: ${JSON.stringify(newStats)}`);
                    optionsRef.current.onComplete?.(newStats);
                    if (optionsRef.current.autoStop) {
                        logger(`useUploadProgress: Auto-stopping polling after completion`);
                        isPollingRef.current = false;
                    } else {
                        logger(`useUploadProgress: Upload complete but continuing to poll (autoStop: false)`);
                    }
                }
                
                // Start file uploader if there are pending files
                if (newStats.pending > 0) {
                    fileUploader.start("manual");
                }
            }
            
            // Schedule next poll with minimum interval guarantee
            if (isMountedRef.current && isPollingRef.current) {
                const elapsedTime = Date.now() - pollStartTime;
                const nextPollDelay = Math.max(0, optionsRef.current.interval - elapsedTime);
                
                timeoutRef.current = setTimeout(poll, nextPollDelay);
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error('Polling failed');
            if (isMountedRef.current) {
                logger(`useUploadProgress: Polling failed: ${error.message} - stopping polling`);
                setUploadError(error);
                isPollingRef.current = false;
                optionsRef.current.onError?.(error);
            }
        } finally {
            isPollingInProgressRef.current = false;
        }
    }, [fetchStats, setUploadStats, setUploadError, setUploadProgress, setIsUploadComplete]);
    
    // Single effect for lifecycle management
    useEffect(() => {
        isMountedRef.current = true;
        isPollingRef.current = true;
        
        // Respect interval on initial poll
        const timeSinceLastPoll = Date.now() - lastPollTimeRef.current;
        const initialDelay = timeSinceLastPoll < interval ? interval - timeSinceLastPoll : 0;
        
        if (initialDelay > 0) {
            timeoutRef.current = setTimeout(poll, initialDelay);
        } else {
            poll();
        }
        
        return () => {
            isMountedRef.current = false;
            isPollingRef.current = false;
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
                timeoutRef.current = null;
            }
        };
    }, []);
}