import React from "react";
import { RepeatIcon } from "../icons/icons";
import Tooltip from "../ui/Tooltip";
import IconButton from "../ui/IconButton";
import { ProgressBar } from "../status/ProgressBar";
import { librarySyncProgressAtom, librariesSyncStatusAtom } from "../../atoms/sync";
import { useAtomValue, useSetAtom } from "jotai";
import { CancelIcon, CheckmarkIcon, SpinnerIcon } from "../status/icons";
import { syncZoteroDatabase } from "../../../src/utils/sync";
import { LibrarySyncStatus } from "../../atoms/sync";


export const DatabaseSyncStatus: React.FC = () => {

    const librarySyncProgress = useAtomValue(librarySyncProgressAtom);
    const setLibrariesSyncStatus = useSetAtom(librariesSyncStatusAtom);

    const handleSyncRetryClick = () => {
        setLibrariesSyncStatus(currentStatus => {
            const newStatus: Record<number, LibrarySyncStatus> = {};
            for (const libIdStr in currentStatus) {
                const libId = Number(libIdStr);
                const existingLibStatus = currentStatus[libId];
                if (existingLibStatus) {
                    newStatus[libId] = {
                        ...existingLibStatus, // Preserves libraryID, libraryName, itemCount
                        syncedCount: 0,
                        status: 'in_progress',
                    };
                }
            }
            return newStatus;
        });
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

    return (
        <div className="display-flex flex-row gap-4 p-3 border-popup rounded-md bg-quinary">
            <div className="mt-1">
                {getSyncIcon()}
            </div>
            <div className="display-flex flex-col gap-3 items-start flex-1">
                <div className="display-flex flex-row items-center gap-3 w-full min-w-0">
                    <div className={`text-lg ${librarySyncProgress.anyFailed ? 'font-color-red' : 'font-color-secondary'}`}>Syncing Zotero database</div>
                    <div className="flex-1"/>
                    {librarySyncProgress.anyFailed && (
                        <Tooltip content="Retry syncing" showArrow singleLine>
                            <IconButton icon={RepeatIcon} onClick={handleSyncRetryClick} variant="ghost-secondary" className="scale-12" />
                        </Tooltip>
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
                                {librarySyncProgress ? librarySyncProgress.progress.toFixed(1) + "%" : ""}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};