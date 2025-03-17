import { useAtomValue } from "jotai";
import React from "react";
// @ts-ignore no idea why this is needed
import { useEffect, useState } from "react";
import { syncStatusAtom, syncTotalAtom, syncCurrentAtom } from "../atoms/ui";
import Tooltip from "./Tooltip";
import { syncZoteroDatabase } from '../../src/utils/sync';
import IconButton from "./IconButton";
import { DatabaseStatusIcon } from "./icons";

const COLORS = {
    red: "#db2c3a",
    green: "#39bf68",
    yellow: "#faa700",
}

const DatabaseStatusIndicator: React.FC = () => {
    const syncStatus = useAtomValue(syncStatusAtom);
    const syncTotal = useAtomValue(syncTotalAtom);
    const syncCurrent = useAtomValue(syncCurrentAtom);
    
    let dotColor = "green";
    let fading = false;
    if(syncStatus === "idle") {
        dotColor = "green";
        fading = false;
    } else if(syncStatus === "in_progress") {
        dotColor = "yellow";
        fading = true;
    } else if(syncStatus === "completed") {
        dotColor = "green";
        fading = false;
    } else if(syncStatus === "failed") {
        dotColor = "red";
        fading = false;
    }
    
    const color = dotColor in COLORS ? COLORS[dotColor as keyof typeof COLORS] : dotColor;
    
    // Create a wrapper component that passes the props to DatabaseStatusIcon
    const IconWithProps = (props: React.SVGProps<SVGSVGElement>) => (
        <DatabaseStatusIcon 
            dotColor={dotColor} 
            fading={fading} 
            fadeDuration={1000} 
            {...props} 
        />
    );
    
    return (
        <Tooltip content="Database status" showArrow singleLine>
            <IconButton
                icon={IconWithProps}
                onClick={() => syncZoteroDatabase()}
                className="scale-14"
                ariaLabel="Database status"
                // disabled={threadMessages.length === 0}
            />
        </Tooltip>
    );
};

export default DatabaseStatusIndicator;