import React, { useState, useMemo } from "react";
import { useAtomValue } from "jotai";
import { syncingAtom, syncErrorAtom } from "../../../atoms/ui";
import { syncZoteroDatabase } from '../../../../src/utils/sync';
import IconButton from "../IconButton";
import { DatabaseStatusIcon } from "../../icons/icons";

// Possible icon states
type IconState = {
    color: "green" | "yellow" | "red";
    fading: boolean;
};

const DatabaseStatusButton: React.FC = () => {
        
    // Combined atoms
    const isSyncing = useAtomValue(syncingAtom);
    const hasError = useAtomValue(syncErrorAtom);
    
    // Determine the icon state based on current sync status
    const getIconState = (): IconState => {
        // Error state takes precedence
        if (hasError) {
            return { color: "red", fading: false };
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