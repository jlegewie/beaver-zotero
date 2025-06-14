import React, { useState, useMemo } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { syncStatusAtom, syncingAtom, syncErrorAtom, SyncStatus } from "../../../atoms/ui";
import { uploadQueueStatusAtom, uploadQueueTotalAtom } from "../../../atoms/sync";
import { syncZoteroDatabase } from '../../../../src/utils/sync';
import IconButton from "../IconButton";
import { DatabaseStatusIcon } from "../../icons/icons";
import { librarySyncProgressAtom } from "../../../atoms/sync";

// Possible icon states
type IconState = {
    color: "green" | "yellow" | "red";
    fading: boolean;
};

const DatabaseStatusButton: React.FC = () => {
    // Database sync atoms
    const syncStatus = useAtomValue(syncStatusAtom);
    const librarySyncProgress = useAtomValue(librarySyncProgressAtom);
    
    // File upload atoms
    const uploadQueueStatus = useAtomValue(uploadQueueStatusAtom);
    const uploadQueueTotal = useAtomValue(uploadQueueTotalAtom);
    
    // Combined atoms
    const isSyncing = useAtomValue(syncingAtom);
    const hasError = useAtomValue(syncErrorAtom);
    
    // Set sync status atom (to trigger syncs)
    const setSyncStatus = useSetAtom(syncStatusAtom);
    // setSyncStatus('failed');

    // Determine the icon state based on current sync status
    const getIconState = (): IconState => {
        // Error state takes precedence
        if (hasError) {
            return { color: "red", fading: false };
        }
        
        // Check if initial sync (large operation) is in progress
        const isLargeFileUpload = uploadQueueStatus?.status === 'in_progress' && uploadQueueTotal > 20;
                
        // Check if incremental sync or small file upload is in progress
        if (isSyncing) {
            return { color: "green", fading: true };
        }
        
        // All good, no ongoing operations (both 'idle' and 'completed' render the same)
        return { color: "green", fading: false };
    };
    
    // Get current icon state
    const iconState = getIconState();
    
    // Calculate progress percentages with safety checks
    const calculateProgress = (current: number, total: number): number => {
        if (total <= 0) return 0;
        if (current <= 0) return 0;
        // Cap at 100% to prevent display issues
        return Math.min(Math.round((current / total) * 100), 100);
    };
    
    const dbProgress = librarySyncProgress.progress;
    const fileProgress = calculateProgress(uploadQueueStatus?.completed || 0, uploadQueueTotal);
    
    // Progress display text with proper formatting
    const getProgressText = (status: SyncStatus, progress: number, current: number, total: number, type: 'database' | 'file'): string => {
        // Combine 'idle' and 'completed' statuses for display purposes
        if (status === 'idle' || status === 'completed') {
            return type === 'database' ? 'Status: completed' : 'Status: completed';
        }
        if (status === 'failed') return type === 'database' ? 'Status: failed' : 'Status: failed';
        
        // Format the progress display for in_progress state
        if (total > 0) {
            return type === 'database' ? `Syncing... ${progress}% (${current}/${total})` : `Uploading... ${progress}% (${current}/${total})`;
        }
        return type === 'database' ? 'Syncing...' : 'Uploading...';
    };
    
    const dbProgressText = getProgressText(syncStatus, dbProgress, librarySyncProgress.syncedItems, librarySyncProgress.totalItems, 'database');
    const fileProgressText = getProgressText(uploadQueueStatus?.status as SyncStatus, fileProgress, uploadQueueStatus?.pending || 0, uploadQueueTotal, 'file');
    
    // Handle manual sync button click
    const handleSyncClick = () => {
        syncZoteroDatabase();
    };
    
    const [isHovering, setIsHovering] = useState(false);
    
    // Memoize the icon component to prevent recreation on each render
    const memoizedIcon = useMemo(() => {
        return (props: React.SVGProps<SVGSVGElement>) => (
            <DatabaseStatusIcon
                dotColor={iconState.color}
                fading={iconState.fading}
                fadeDuration={1000}
                hover={isHovering}
                {...props}
            />
        );
    }, [iconState.color, iconState.fading, isHovering]);
    
    return (
        <IconButton
            icon={memoizedIcon}
            onClick={handleSyncClick}
            className="scale-12"
            ariaLabel="Sync status"
            onMouseEnter={() => setIsHovering(true)}
            onMouseLeave={() => setIsHovering(false)}
        />
    );
};

export default DatabaseStatusButton;