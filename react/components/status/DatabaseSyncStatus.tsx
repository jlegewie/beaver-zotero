import React from "react";
import { CheckmarkCircleIcon, CancelCircleIcon, ClockIcon, SyncIcon, RepeatIcon } from "../icons/icons";
import { FileStatusStats } from "../../atoms/ui";
import IconButton from "../ui/IconButton";
import { StatusItem } from "../ui/buttons/FileStatusButton";
import { ProgressBar } from "../status/ProgressBar";
import { librarySyncProgressAtom } from "../../atoms/sync";
import { useAtomValue } from "jotai";
import { CancelIcon, CheckmarkIcon, SpinnerIcon } from "../status/icons";
import { syncZoteroDatabase } from "../../../src/utils/sync";


export const DatabaseSyncStatus: React.FC = () => {

    const librarySyncProgress = useAtomValue(librarySyncProgressAtom);

    const handleSyncRetryClick = () => {
        syncZoteroDatabase();
    };
    
    const getLeftText = (): string => {
        if (librarySyncProgress.totalItems > 0 && librarySyncProgress.syncedItems > 0) return `${librarySyncProgress.syncedItems.toLocaleString()} done`;
        return "";
    };

    const getSyncIcon = (): React.ReactNode => {
        if (librarySyncProgress.anyFailed) return CancelIcon;
        if (librarySyncProgress.progress < 100) return SpinnerIcon;
        if (librarySyncProgress.progress >= 100) return CheckmarkIcon;
        return SpinnerIcon;
    };

    const rightIcon = librarySyncProgress.anyFailed ? RepeatIcon : undefined;

    return (
        <div className="display-flex flex-row gap-4 p-3 border-popup rounded-md bg-quinary">
            <div className="mt-1">
                {getSyncIcon()}
            </div>
            <div className="display-flex flex-col gap-3 items-start flex-1">
                <div className="display-flex flex-row items-center gap-3 w-full min-w-0">
                    <div className={`text-lg ${librarySyncProgress.anyFailed ? 'font-color-red' : 'font-color-secondary'}`}>Syncing Zotero database</div>
                    <div className="flex-1"/>
                    {rightIcon && librarySyncProgress.anyFailed && (
                        <IconButton icon={rightIcon} onClick={handleSyncRetryClick} variant="ghost-secondary" className="scale-12" />
                    )}
                </div>
                {librarySyncProgress.progress !== undefined && (
                    <div className="w-full">
                        <ProgressBar progress={librarySyncProgress.progress} />
                        <div className="display-flex flex-row gap-4">
                            <div className="font-color-tertiary text-base">
                                {getLeftText()}
                            </div>
                            <div className="flex-1"/>
                            <div className="font-color-tertiary text-base">
                                {librarySyncProgress ? librarySyncProgress.progress.toFixed(0) + "%" : ""}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};