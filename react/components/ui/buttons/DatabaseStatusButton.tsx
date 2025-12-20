import React, { useState } from "react";
import { useAtomValue } from "jotai";
import { syncingAtom, syncErrorAtom } from "../../../atoms/sync";
import { syncZoteroDatabase } from '../../../../src/utils/sync';
import IconButton from "../IconButton";
import { AlertIcon, SyncIcon } from "../../icons/icons";
import { syncLibraryIdsAtom } from "../../../atoms/profile";
import { logger } from '../../../../src/utils/logger';
import Tooltip from "../Tooltip";


const DatabaseStatusButton: React.FC = () => {
    const [isHovered, setIsHovered] = useState(false);
    
    // Combined atoms
    const isSyncing = useAtomValue(syncingAtom);
    const hasError = useAtomValue(syncErrorAtom);
    const syncLibraryIds = useAtomValue(syncLibraryIdsAtom);
    
    // Handle manual sync button click
    const handleSyncClick = () => {
        if (!isSyncing) {
            logger(`Beaver Sync: User-initiated database sync`);
            syncZoteroDatabase(syncLibraryIds, { resetSyncStatus: true });
        }
    };
    
    if (!isSyncing && !hasError) return null;
    
    // Determine which icon to show
    const icon = isSyncing ? SyncIcon : (isHovered ? SyncIcon : AlertIcon);
    const iconClassName = isSyncing 
        ? "animate-spin" 
        : (isHovered ? "" : "font-color-red");
    
    return (
        <Tooltip
            content={isSyncing ? "Syncing..." : hasError ? "Sync Error" : "Sync Database"}
            secondaryContent={hasError && !isSyncing ? "Click to retry Beaver sync" : undefined}
            showArrow
        >
            <div
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
            >
                <IconButton
                    icon={icon}
                    onClick={handleSyncClick}
                    className="scale-13"
                    iconClassName={iconClassName}
                    ariaLabel={isSyncing ? "Syncing..." : "Sync Database"}
                    disabled={isSyncing}
                />
            </div>
        </Tooltip>
    );
};

export default DatabaseStatusButton;