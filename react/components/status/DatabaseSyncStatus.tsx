import React from "react";
import { AlertIcon, ArrowDownIcon, ArrowRightIcon, CSSIcon, Icon, RepeatIcon } from "../icons/icons";
import Tooltip from "../ui/Tooltip";
import IconButton from "../ui/IconButton";
import Button from "../ui/Button";
import { ProgressBar } from "../status/ProgressBar";
import { syncStatusSummaryAtom, syncStatusAtom, failedSyncLibraryIdsAtom, overallSyncStatusAtom } from "../../atoms/sync";
import { useAtomValue, useSetAtom } from "jotai";
import { CancelIcon, CheckmarkIcon, AlertIcon as AlertIconIcon, SpinnerIcon } from "../status/icons";
import { syncZoteroDatabase } from "../../../src/utils/sync";
import { LibrarySyncStatus } from "../../atoms/sync";
import { syncLibraryIdsAtom } from "../../atoms/profile";


export const DatabaseSyncStatus: React.FC = () => {

    const syncLibraryIds = useAtomValue(syncLibraryIdsAtom);
    const syncStatusSummary = useAtomValue(syncStatusSummaryAtom);
    const failedSyncLibraryIds = useAtomValue(failedSyncLibraryIdsAtom);
    const setSyncStatus = useSetAtom(syncStatusAtom);
    const syncStatus = useAtomValue(overallSyncStatusAtom);
    const [showFailedLibraries, setShowFailedLibraries] = React.useState(false);

    const failedLibraries = React.useMemo(() => (
        failedSyncLibraryIds
            .map((libraryId) => {
                const library = Zotero.Libraries.get(libraryId);
                if (!library) return null;
                return { id: libraryId, name: library.name, isGroup: library.isGroup };
            })
            .filter((library): library is { id: number; name: string; isGroup: boolean } => library !== null)
    ), [failedSyncLibraryIds]);

    const failedLibrariesCount = failedLibraries.length;

    const handleSyncRetryClick = async () => {
        // Reset the sync status for all libraries for instant UI update
        setSyncStatus(currentStatus => {
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
        await syncZoteroDatabase(syncLibraryIds);
    };
    
    const getLeftText = (): string => {
        const countText = syncStatusSummary.totalItems > 0 && syncStatusSummary.syncedItems > 0 ? `${syncStatusSummary.syncedItems.toLocaleString()} done` : '';
        if (!syncStatus) return countText;
        if (syncStatus === 'in_progress') return countText;
        if (syncStatus === 'completed') return countText;
        if (syncStatus === 'partially_completed') return 'Completed with errors';
        if (syncStatus === 'failed') return 'Sync failed: Retry or contact support';
        return countText;
    };

    const getSyncIcon = (): React.ReactNode => {
        if (!syncStatus) return SpinnerIcon;
        if (syncStatus === 'in_progress') return SpinnerIcon;
        if (syncStatus === 'completed') return CheckmarkIcon;
        if (syncStatus === 'partially_completed') return AlertIconIcon;
        if (syncStatus === 'failed') return CancelIcon;
        return SpinnerIcon;
    };

    const getProgress = (): number => {
        if (!syncStatus) return syncStatusSummary ? syncStatusSummary.progress : 0;
        if (syncStatus === 'in_progress') return syncStatusSummary ? syncStatusSummary.progress : 0;
        if (syncStatus === 'completed') return 100;
        if (syncStatus === 'partially_completed') return 100;
        if (syncStatus === 'failed') return 0;
        return syncStatusSummary ? syncStatusSummary.progress : 0;
    };

    const getProgressText = (): string => {
        if (syncStatus === 'failed') return "";
        return `${getProgress().toFixed(1) + "%"}`;
    };

    const getTitleColor = (): string => {
        if (!syncStatus) return 'font-color-secondary';
        if (syncStatus === 'partially_completed') return 'font-color-yellow';
        if (syncStatus === 'failed') return 'font-color-red';
        return 'font-color-secondary';
    };

    return (
        <div className="display-flex flex-col gap-2 p-3 rounded-md bg-quinary">
            <div className="display-flex flex-row gap-4">
                <div className="mt-1">
                    {getSyncIcon()}
                </div>
                <div className="display-flex flex-col gap-3 items-start flex-1">
                    <div className="display-flex flex-row items-center gap-3 w-full min-w-0">
                        <div className={`text-lg ${getTitleColor()}`}>Syncing Zotero Library</div>
                        <div className="flex-1"/>
                        {(syncStatus === 'partially_completed' || syncStatus === 'failed') && (
                            <Tooltip content="Retry syncing" showArrow singleLine>
                                <IconButton icon={RepeatIcon} onClick={handleSyncRetryClick} variant="ghost-secondary" className="scale-12" />
                            </Tooltip>
                        )}
                    </div>
                    {(syncStatusSummary.progress !== undefined || syncStatus !== 'in_progress') && (
                        <div className="w-full">
                            <ProgressBar progress={getProgress()} />
                            <div className="display-flex flex-row gap-4">
                                <div className="font-color-tertiary text-base">
                                    {getLeftText()}
                                </div>
                                <div className="flex-1"/>
                                <div className="font-color-tertiary text-base">
                                    {getProgressText()}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
            {failedLibrariesCount > 0 && (
                <div className="display-flex flex-col gap-4 min-w-0">
                    <div className="display-flex flex-row gap-4 min-w-0">
                        <div className="flex-shrink-0">
                            <Icon icon={AlertIcon} className={`scale-12 mt-15 font-color-secondary`} />
                        </div>
                        <div className="display-flex flex-col items-start gap-3 w-full min-w-0">
                            <div className="display-flex flex-row items-start gap-3 w-full">
                                <Button
                                    variant="ghost"
                                    onClick={() => setShowFailedLibraries(prev => !prev)}
                                    rightIcon={showFailedLibraries ? ArrowDownIcon : ArrowRightIcon}
                                    iconClassName={`mr-0 mt-015 scale-12 font-color-secondary`}
                                >
                                    <span className={`text-base font-color-secondary`} style={{ marginLeft: '-3px' }}>
                                        {`${failedLibrariesCount.toLocaleString()} Librar${failedLibrariesCount === 1 ? 'y' : 'ies'} failed`}
                                    </span>
                                </Button>
                                <div className="flex-1"/>
                                {/* <Tooltip content="Retry syncing" showArrow singleLine>
                                    <IconButton icon={RepeatIcon} onClick={handleSyncRetryClick} variant="ghost-secondary" className="scale-12 mt-015" />
                                </Tooltip> */}
                            </div>
                            {showFailedLibraries && (
                                <div className="display-flex flex-col gap-3 w-full">
                                    {failedLibraries.map((library) => (
                                        <div key={library.id} className="display-flex flex-row gap-3 items-center w-full min-w-0">
                                            <div className="flex-shrink-0">
                                                <CSSIcon name={library.isGroup ? "library-group" : "library"} className="icon-16 scale-95" />
                                            </div>
                                            <div className={`text-base font-color-secondary truncate`} style={{ marginLeft: '-3px' }}>
                                                {library.name}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                    {/* <div className="font-color-tertiary text-sm">
                        Failed libraries will not be synced with Beaver.
                    </div> */}
                </div>
            )}
        </div>
    );
};
