
import { useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { userIdAtom } from '../atoms/auth';
import { fileUploader } from '../../src/services/FileUploader';
import { logger } from '../../src/utils/logger';
import { hasAuthorizedAccessAtom, isDeviceAuthorizedAtom } from '../atoms/profile';
import { isAuthenticatedAtom } from '../atoms/auth';

/**
 * Background service for managing upload queue integrity and file uploader lifecycle.
 * This runs independently of the realtime subscription for display data.
 */
export function useUploadQueueManager(): void {
    const userId = useAtomValue(userIdAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const hasAuthorizedAccess = useAtomValue(hasAuthorizedAccessAtom);
    const isDeviceAuthorized = useAtomValue(isDeviceAuthorizedAtom);
    
    const intervalRef = useRef<NodeJS.Timeout | null>(null);
    const lastIntegrityCheckRef = useRef<number>(0);
    const isIntegrityCheckInProgressRef = useRef(false);
    
    const INTEGRITY_CHECK_INTERVAL = 10000; // 10 seconds
    const QUEUE_MONITOR_INTERVAL = 15000; // 15 seconds
    
    const performIntegrityCheck = async (): Promise<void> => {
        if (!userId || isIntegrityCheckInProgressRef.current) return;
        
        const now = Date.now();
        const shouldRunIntegrityCheck = now - lastIntegrityCheckRef.current > INTEGRITY_CHECK_INTERVAL;
        
        if (!shouldRunIntegrityCheck) return;
        
        isIntegrityCheckInProgressRef.current = true;
        lastIntegrityCheckRef.current = now;
        
        try {
            // Check for orphaned pending attachments
            const stats = await Zotero.Beaver.db.getAttachmentUploadStatistics(userId);
            
            if (stats.pending > 0) {
                const queueTotal = await Zotero.Beaver.db.getTotalQueueItems(userId);
                
                if (queueTotal === 0 && stats.pending > 0) {
                    logger(`Upload Queue Manager: Integrity issue detected - ${stats.pending} pending attachments but no queue items. Attempting fix...`, 2);
                    
                    const fixedCount = await Zotero.Beaver.db.fixPendingAttachmentsWithoutQueue(userId);
                    
                    if (fixedCount > 0) {
                        logger(`Upload Queue Manager: Fixed ${fixedCount} orphaned pending attachments`, 3);
                        await fileUploader.start("manual");
                    }
                } else if (queueTotal > 0) {
                    // Normal case: ensure uploader is running
                    await fileUploader.start("manual");
                }
            }
        } catch (error: any) {
            logger(`Upload Queue Manager: Error during integrity check: ${error.message}`, 1);
        } finally {
            isIntegrityCheckInProgressRef.current = false;
        }
    };
    
    useEffect(() => {
        const isEligible = isAuthenticated && userId && hasAuthorizedAccess && isDeviceAuthorized;
        
        if (!isEligible) {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
            return;
        }
        
        // Start monitoring
        logger('Upload Queue Manager: Starting queue monitoring', 3);
        
        // Run initial check
        performIntegrityCheck();
        
        // Set up periodic monitoring
        intervalRef.current = setInterval(performIntegrityCheck, QUEUE_MONITOR_INTERVAL);
        
        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
            logger('Upload Queue Manager: Stopped queue monitoring', 3);
        };
    }, [userId, isAuthenticated, hasAuthorizedAccess, isDeviceAuthorized]);
}
