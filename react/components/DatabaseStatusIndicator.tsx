import { useAtomValue } from "jotai";
import React from "react";
// @ts-ignore no idea why this is needed
import { useEffect, useState } from "react";
import { syncStatusAtom, syncTotalAtom, syncCurrentAtom, syncingFilesAtom } from "../atoms/ui";
import Tooltip from "./Tooltip";
import { syncZoteroDatabase } from '../../src/utils/sync';
import IconButton from "./IconButton";
import { DatabaseStatusIcon } from "./icons";
import { syncingDatabaseAtom } from "../../react/atoms/ui";
import { CheckmarkCircleIcon, CancelCircleIcon, Icon, Spinner } from "./icons";

const COLORS = {
    red: "#db2c3a",
    green: "#39bf68",
    yellow: "#faa700",
}

const DatabaseStatusIndicator: React.FC = () => {
    const syncingDatabase = useAtomValue(syncingDatabaseAtom);
    const syncingFiles = useAtomValue(syncingFilesAtom);
    const syncStatus = useAtomValue(syncStatusAtom);
    const syncTotal = useAtomValue(syncTotalAtom);
    const syncCurrent = useAtomValue(syncCurrentAtom);
    
    let dotColor = "green";
    let fading = false;
    if(syncStatus === "idle") {
        dotColor = "green";
        fading = false;
    } else if(syncStatus === "in_progress") {
        dotColor = "green";
        fading = true;
    } else if(syncStatus === "completed") {
        dotColor = "green";
        fading = false;
    } else if(syncStatus === "failed") {
        dotColor = "red";
        fading = false;
    }

    fading = syncingDatabase || syncingFiles;
    
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

    const customContent = (
        <div className="flex flex-col gap-3 p-0">
            <div className="card flex flex-col gap-3 items-start">
                <div className="flex flex-row justify-between items-center gap-3">
                    {syncingDatabase ? (
                        <Spinner />
                        
                    ) : (
                        <Icon icon={CheckmarkCircleIcon} className="font-color-green scale-14" />
                    )}
                    <span className="font-color-secondary text-base">
                        Zotero Database Sync
                    </span>
                </div>
                <span className="font-color-tertiary text-base">
                    Uploading...
                </span>
            </div>
            <div className="card flex flex-col gap-3 items-start">
                <div className="flex flex-row items-center gap-3">
                    <Icon icon={CheckmarkCircleIcon} className="font-color-green scale-14" />
                    <span className="font-color-secondary text-base">
                        File Uploads
                    </span>
                </div>
                <span className="font-color-tertiary text-base">
                    Uploading...
                </span>
            </div>
        </div>
    );
    
    return (
        <Tooltip content="Database status" showArrow singleLine customContent={customContent}>
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