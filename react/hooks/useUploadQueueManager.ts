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
    const isMonitoringRef = useRef(false);
    
    const MONITOR_INTERVAL = 10000; // Unified 10 second interval
    const INTEGRITY_CHECK_INTERVAL = 30000; // Less frequent integrity checks (30 seconds)
    
    const monitorQueue = async (): Promise<void> => {
        if (!userId || isMonitoringRef.current) return;
        
        isMonitoringRef.current = true;
        
        try {
            const stats = await Zotero.Beaver.db.getAttachmentUploadStatistics(userId);
            
            // Only proceed if there are pending attachments
            if (stats.pending > 0) {
                const queueTotal = await Zotero.Beaver.db.getTotalQueueItems(userId);
                const now = Date.now();
                
                // Always start uploader if there are queue items (basic monitoring)
                if (queueTotal > 0) {
                    logger(`Upload Queue Manager: Found ${queueTotal} queue items with ${stats.pending} pending attachments, ensuring uploader is running`, 3);
                    await fileUploader.start("manual");
                }
                // Integrity check: fix orphaned pending attachments (less frequent)
                else if (now - lastIntegrityCheckRef.current > INTEGRITY_CHECK_INTERVAL) {
                    logger(`Upload Queue Manager: Integrity issue detected - ${stats.pending} pending attachments but no queue items. Attempting fix...`, 2);
                    
                    const fixedCount = await Zotero.Beaver.db.fixPendingAttachmentsWithoutQueue(userId);
                    
                    if (fixedCount > 0) {
                        logger(`Upload Queue Manager: Fixed ${fixedCount} orphaned pending attachments`, 3);
                        await fileUploader.start("manual");
                    } else {
                        logger(`Upload Queue Manager: No orphaned attachments found to fix`, 3);
                    }
                    
                    lastIntegrityCheckRef.current = now;
                }
            } else if (stats.total > 0) {
                // All uploads complete, log occasionally
                const now = Date.now();
                if (now - lastIntegrityCheckRef.current > INTEGRITY_CHECK_INTERVAL) {
                    logger(`Upload Queue Manager: All uploads complete (${stats.completed} completed, ${stats.failed} failed, ${stats.skipped} skipped)`, 3);
                    lastIntegrityCheckRef.current = now;
                }
            }
        } catch (error: any) {
            logger(`Upload Queue Manager: Error during queue monitoring: ${error.message}`, 1);
            // Continue monitoring despite errors - don't stop the service
        } finally {
            isMonitoringRef.current = false;
        }
    };
    
    useEffect(() => {
        const isEligible = isAuthenticated && userId && hasAuthorizedAccess && isDeviceAuthorized;
        
        if (!isEligible) {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
            logger('Upload Queue Manager: Stopped - user not eligible for monitoring', 3);
            return;
        }
        
        // Start monitoring
        logger('Upload Queue Manager: Starting queue monitoring', 3);
        
        // Run initial check
        monitorQueue();
        
        // Set up periodic monitoring with unified interval
        intervalRef.current = setInterval(monitorQueue, MONITOR_INTERVAL);
        
        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
            isMonitoringRef.current = false;
            logger('Upload Queue Manager: Stopped queue monitoring', 3);
        };
    }, [userId, isAuthenticated, hasAuthorizedAccess, isDeviceAuthorized]);
}
