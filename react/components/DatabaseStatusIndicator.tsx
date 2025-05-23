import { useAtomValue, useSetAtom } from "jotai";
import React from "react";
// @ts-ignore no idea why this is needed
import { useState, useMemo } from "react";
import { 
    syncStatusAtom, syncTotalAtom, syncCurrentAtom, 
    syncingAtom, syncErrorAtom, SyncStatus
} from "../atoms/ui";
import { uploadQueueStatusAtom } from "../atoms/sync";
import Tooltip from "./Tooltip";
import { syncZoteroDatabase } from '../../src/utils/sync';
import IconButton from "./IconButton";
import { DatabaseStatusIcon } from "./icons";
import { CheckmarkCircleIcon, CancelCircleIcon, Icon, Spinner } from "./icons";

// Possible icon states
type IconState = {
    color: "green" | "yellow" | "red";
    fading: boolean;
};

const DatabaseStatusIndicator: React.FC = () => {
    // Database sync atoms
    const syncStatus = useAtomValue(syncStatusAtom);
    const syncTotal = useAtomValue(syncTotalAtom);
    const syncCurrent = useAtomValue(syncCurrentAtom);
    
    // File upload atoms
    const uploadQueueStatus = useAtomValue(uploadQueueStatusAtom);
    
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
        const isInitialSync = syncStatus === 'in_progress' && syncTotal > 50;
        const isLargeFileUpload = uploadQueueStatus?.status === 'in_progress' && uploadQueueStatus?.total > 20;
        
        if (isInitialSync || isLargeFileUpload) {
            return { color: "yellow", fading: true };
        }
        
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
    
    const dbProgress = calculateProgress(syncCurrent, syncTotal);
    const fileProgress = calculateProgress(uploadQueueStatus?.completed || 0, uploadQueueStatus?.total || 0);
    
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
    
    const dbProgressText = getProgressText(syncStatus, dbProgress, syncCurrent, syncTotal, 'database');
    const fileProgressText = getProgressText(uploadQueueStatus?.status as SyncStatus, fileProgress, uploadQueueStatus?.pending || 0, uploadQueueStatus?.total || 0, 'file');
    
    // Handle manual sync button click
    const handleSyncClick = () => {
        syncZoteroDatabase();
    };
    
    // Create the tooltip content
    const customContent = (
        <div className="display-flex flex-col gap-3 px-0 py-1 max-w-xs">
            <div className="display-flex flex-col gap-3 items-start">
                <div className="display-flex flex-row justify-between items-center w-full">
                    <div className="display-flex items-center gap-3">
                        {syncStatus === 'in_progress' ? (
                            <Spinner size={14} />
                        ) : syncStatus === 'failed' ? (
                            <Icon icon={CancelCircleIcon} className="font-color-red scale-12" />
                        ) : (
                            <Icon icon={CheckmarkCircleIcon} className="font-color-green scale-12" />
                        )}
                        <span className="font-color-secondary text-base">
                            Sync with Beaver
                        </span>
                    </div>
                    
                    {/* {syncStatus !== 'in_progress' && (
                        <IconButton
                            icon={Spinner}
                            onClick={handleSyncClick}
                            className="scale-10 ml-auto"
                            ariaLabel="Sync database"
                            title="Run database sync"
                        />
                    )} */}
                </div>
                
                <span className="font-color-tertiary text-sm">
                    {dbProgressText}
                </span>
            </div>
            
            <div className="display-flex flex-col gap-3 items-start">
                <div className="display-flex flex-row items-center gap-3">
                    {uploadQueueStatus?.status === 'in_progress' ? (
                        <Spinner size={14} />
                    ) : uploadQueueStatus?.status === 'failed' ? (
                        <Icon icon={CancelCircleIcon} className="font-color-red scale-12" />
                    ) : (
                        <Icon icon={CheckmarkCircleIcon} className="font-color-green scale-12" />
                    )}
                    <span className="font-color-secondary text-base">
                        File Uploads
                    </span>
                </div>
                
                <span className="font-color-tertiary text-sm">
                    {fileProgressText}
                </span>
            </div>
        </div>
    );
    
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
        <Tooltip 
            content="Sync Status" 
            showArrow 
            singleLine 
            customContent={customContent}
            stayOpenOnAnchorClick={true}
        >
            <IconButton
                icon={memoizedIcon}
                onClick={handleSyncClick}
                className="scale-12"
                ariaLabel="Sync status"
                onMouseEnter={() => setIsHovering(true)}
                onMouseLeave={() => setIsHovering(false)}
            />
        </Tooltip>
    );
};

export default DatabaseStatusIndicator;