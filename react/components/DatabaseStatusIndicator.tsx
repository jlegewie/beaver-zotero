import { useAtomValue, useSetAtom } from "jotai";
import React from "react";
// @ts-ignore no idea why this is needed
import { useEffect, useState } from "react";
import { 
    syncStatusAtom, syncTotalAtom, syncCurrentAtom, 
    fileUploadStatusAtom, fileUploadTotalAtom, fileUploadCurrentAtom,
    syncingAtom, syncErrorAtom
} from "../atoms/ui";
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
    const fileStatus = useAtomValue(fileUploadStatusAtom);
    const fileTotal = useAtomValue(fileUploadTotalAtom);
    const fileCurrent = useAtomValue(fileUploadCurrentAtom);
    
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
        const isLargeFileUpload = fileStatus === 'in_progress' && fileTotal > 20;
        
        if (isInitialSync || isLargeFileUpload) {
            return { color: "yellow", fading: true };
        }
        
        // Check if incremental sync or small file upload is in progress
        if (isSyncing) {
            return { color: "green", fading: true };
        }
        
        // All good, no ongoing operations
        return { color: "green", fading: false };
    };
    
    // Get current icon state
    const iconState = getIconState();
    
    // Calculate progress percentages
    const dbProgress = syncTotal > 0 ? Math.round((syncCurrent / syncTotal) * 100) : 0;
    const fileProgress = fileTotal > 0 ? Math.round((fileCurrent / fileTotal) * 100) : 0;
    
    // Handle manual sync button click
    const handleSyncClick = () => {
        syncZoteroDatabase();
    };
    
    // Create the tooltip content
    const customContent = (
        <div className="flex flex-col gap-3 p-0 max-w-xs">
            <div className="card flex flex-col gap-3 items-start">
                <div className="flex flex-row justify-between items-center w-full">
                    <div className="flex items-center gap-3">
                        {syncStatus === 'in_progress' ? (
                            <Spinner size={14} />
                        ) : syncStatus === 'failed' ? (
                            <Icon icon={CancelCircleIcon} className="font-color-red scale-14" />
                        ) : (
                            <Icon icon={CheckmarkCircleIcon} className="font-color-green scale-14" />
                        )}
                        <span className="font-color-secondary text-base">
                            Zotero Database Sync
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
                    {syncStatus === 'idle' ? 'Ready' : 
                     syncStatus === 'in_progress' ? `Syncing... ${dbProgress}%` :
                     syncStatus === 'completed' ? 'Sync completed' : 
                     'Sync failed'}
                </span>
            </div>
            
            <div className="card flex flex-col gap-3 items-start">
                <div className="flex flex-row items-center gap-3">
                    {fileStatus === 'in_progress' ? (
                        <Spinner size={14} />
                    ) : fileStatus === 'failed' ? (
                        <Icon icon={CancelCircleIcon} className="font-color-red scale-14" />
                    ) : (
                        <Icon icon={CheckmarkCircleIcon} className="font-color-green scale-14" />
                    )}
                    <span className="font-color-secondary text-base">
                        File Uploads
                    </span>
                </div>
                
                <span className="font-color-tertiary text-sm">
                    {fileStatus === 'idle' ? 'No uploads in progress' : 
                     fileStatus === 'in_progress' ? `Uploading... ${fileProgress}% (${fileCurrent}/${fileTotal})` :
                     fileStatus === 'completed' ? 'All uploads completed' : 
                     'Upload failed'}
                </span>
            </div>
        </div>
    );
    
    return (
        <Tooltip 
            content="Sync Status" 
            showArrow 
            singleLine 
            customContent={customContent}
        >
            <IconButton
                icon={(props) => (
                    <DatabaseStatusIcon
                        dotColor={iconState.color}
                        fading={iconState.fading}
                        fadeDuration={1000}
                        {...props}
                    />
                )}
                onClick={handleSyncClick}
                className="scale-14"
                ariaLabel="Sync status"
            />
        </Tooltip>
    );
};

export default DatabaseStatusIndicator;