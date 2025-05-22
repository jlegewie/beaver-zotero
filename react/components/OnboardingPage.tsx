import React, { useEffect, useState } from "react";
import { CheckmarkCircleIcon, CancelCircleIcon, Icon, Spinner, ArrowRightIcon, OneIcon as OneCircleIcon, TwoIcon as TwoCircleIcon, ThreeIcon as ThreeCircleIcon, CSSItemTypeIcon, CSSIcon } from "./icons";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useFileStatus } from '../hooks/useFileStatus';
import { 
    syncStatusAtom, syncTotalAtom, syncCurrentAtom, 
    fileUploadStatusAtom, fileUploadTotalAtom, fileUploadCurrentAtom,
    fileStatusStatsAtom, SyncStatus,
} from "../atoms/ui";
import { librariesSyncStatusAtom, librarySyncProgressAtom, LibrarySyncStatus } from "../atoms/sync";
import Button from "./button";
import { userAuthorizationAtom } from '../atoms/profile';
import LibrarySelector from "./LibrarySelector";
import { getPref, setPref } from "../../src/utils/prefs";
import { LibraryStatistics } from "../../src/utils/libraries";

const ProgressBar: React.FC<{ progress: number }> = ({ progress }) => (
    <div className="w-full h-2 bg-tertiary rounded-sm overflow-hidden mt-1 mb-2" style={{ height: '8px' }}>
        <div
            className="h-full bg-secondary rounded-sm transition-width duration-500 ease-in-out"
            style={{ width: `${Math.min(progress, 100)}%` }}
        />
    </div>
);

const ProcessItem: React.FC<{
    status: SyncStatus,
    icon: React.ReactNode,
    title: string,
    description?: string,
    progress?: number,
    leftText?: string,
    rightText?: string,
}> = ({ status, icon, title, description, progress, leftText, rightText }) => {
    return (
        <div className="display-flex flex-row gap-4">
            <div className="mt-1">
                {icon}
            </div>
            <div className="display-flex flex-col gap-3 items-start flex-1">
                <div className="font-color-primary text-lg">{title}</div>
                {description && (
                    <div className="font-color-tertiary text-base">
                        {description}
                    </div>
                )}
                {progress !== undefined && (
                    <div className="w-full">
                        <ProgressBar progress={progress} />
                        <div className="display-flex flex-row gap-4">
                            <div className="font-color-tertiary text-base">
                                {leftText || ""}
                            </div>
                            <div className="flex-1"/>
                            <div className="font-color-tertiary text-base">
                                {rightText || ""}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

const OnboardingPage: React.FC = () => {
    // User authorization state
    const [userAuthorization, setUserAuthorization] = useAtom(userAuthorizationAtom);
    
    // Database sync state
    const syncStatus = useAtomValue(syncStatusAtom);
    const syncTotal = useAtomValue(syncTotalAtom);
    const syncCurrent = useAtomValue(syncCurrentAtom);
    // File upload state
    const fileStatus = useAtomValue(fileUploadStatusAtom);
    const fileTotal = useAtomValue(fileUploadTotalAtom);
    const fileCurrent = useAtomValue(fileUploadCurrentAtom);

    // Track selected libraries
    const [selectedLibraryIds, setSelectedLibraryIds] = useState<number[]>([]);
    const [isLibrarySelectionValid, setIsLibrarySelectionValid] = useState<boolean>(false);

    // Realtime listening for file status updates
    useFileStatus();

    // Library sync state
    const setLibrariesSyncStatus = useSetAtom(librariesSyncStatusAtom);
    
    const librarySyncProgress = useAtomValue(librarySyncProgressAtom);
    
    // State for full library statistics (loaded asynchronously)
    const [libraryStatistics, setLibraryStatistics] = useState<LibraryStatistics[]>([]);

    // Processing state
    const fileStats = useAtomValue(fileStatusStatsAtom);

    // Calculate progress percentages
    const calculateProgress = (current: number, total: number): number => {
        if (total <= 0) return 0;
        return Math.min(Math.round((current / total) * 100), 100);
    };
    
    const syncProgress = calculateProgress(syncCurrent, syncTotal);
    const uploadProgress = calculateProgress(fileStats.uploadCompletedCount, fileStats.uploadPendingCount + fileStats.uploadCompletedCount + fileStats.uploadFailedCount);
    const indexingProgress = fileStats.progress;

    // Status messages
    const getSyncDescription = () => {
        if (syncStatus === 'idle') return "Waiting to begin library sync...";
        if (syncStatus === 'in_progress') return "Beaver is syncing your Zotero library...";
        if (syncStatus === 'failed') return "There was an error syncing your library.";
        return "Your Zotero library has been synced successfully.";
    };

    const getUploadDescription = () => {
        if (fileStatus === 'idle') return "Waiting to begin file upload...";
        if (fileStatus === 'in_progress') return "Uploading your PDF files to Beaver...";
        if (fileStatus === 'failed') return "There was an error uploading some files.";
        return "Your files have been uploaded successfully.";
    };

    const getIndexingDescription = () => {
        const { activeProcessingCount, queuedProcessingCount, completedFiles, failedProcessingCount } = fileStats;
        const totalProcessing = activeProcessingCount + queuedProcessingCount + completedFiles + failedProcessingCount;
        
        if (totalProcessing === 0) return "Waiting to begin file indexing...";
        if (activeProcessingCount > 0 || queuedProcessingCount > 0) return "Indexing your files for search...";
        if (failedProcessingCount > 0) return `Indexing completed with ${failedProcessingCount} errors.`;
        return "All your files have been indexed successfully.";
    };

    const getIndexingStatus = (): SyncStatus => {
        const { activeProcessingCount, queuedProcessingCount, completedFiles, failedProcessingCount } = fileStats;
        const totalProcessing = activeProcessingCount + queuedProcessingCount + completedFiles + failedProcessingCount;
        
        if (totalProcessing === 0) return 'idle';
        if (activeProcessingCount > 0 || queuedProcessingCount > 0) return 'in_progress';
        if (failedProcessingCount > 0) return 'failed';
        return 'completed';
    };

    const CancelIcon = <Icon icon={CancelCircleIcon} className="font-color-red scale-14" />;
    const CheckmarkIcon = <Icon icon={CheckmarkCircleIcon} className="font-color-green scale-14" />;
    const SpinnerIcon = <Spinner className="scale-14" />;

    const getSyncIcon = (): React.ReactNode => {
        if (librarySyncProgress.progress === 0) return SpinnerIcon;
        if (librarySyncProgress.progress < 100) return SpinnerIcon;
        if (librarySyncProgress.anyFailed) return CancelIcon;
        if (librarySyncProgress.completed) return CheckmarkIcon;
        return SpinnerIcon;
    };

    // Handle library selection change
    const handleLibrarySelectionChange = (libraryIds: number[]) => {
        setSelectedLibraryIds(libraryIds);
        setIsLibrarySelectionValid(libraryIds.length > 0);
    };
    
    // Handle authorization
    const handleAuthorize = () => {
        if (selectedLibraryIds.length > 0) {
            // Create a map of library IDs to library sync status
            const selectedLibraries = Object.fromEntries(
                selectedLibraryIds
                    .map(id => {
                        const library = libraryStatistics.find(library => library.libraryID === id);
                        return [
                            library?.libraryID,
                            {
                                libraryID: library?.libraryID,
                                libraryName: library?.name || '',
                                itemCount: library?.itemCount || 0,
                                syncedCount: 0,
                                status: 'idle',
                            } as LibrarySyncStatus
                        ];
                    })
            );

            // Save the sync status for the selected libraries
            setPref('selectedLibrary', JSON.stringify(selectedLibraries));
            setLibrariesSyncStatus(selectedLibraries);
            
            // Update authorization status
            setUserAuthorization(true);
            setPref('userAuthorization', true);
        }
    };
    
    return (
        <div 
            id="onboarding-page"
            className="display-flex flex-col flex-1 min-h-0 overflow-y-auto scrollbar min-w-0 p-4 mr-1"
        >
            {/* Top spacing */}
            <div style={{ height: '5vh' }}></div>

            {/* Header section - always shown */}
            <div className="display-flex flex-col items-start mb-4">
                <h1 className="text-2xl font-semibold">Welcome to Beaver 🦫</h1>
                <p className="text-base font-color-secondary -mt-2">
                    {!userAuthorization 
                        ? "Let's set up your Beaver environment by connecting to your Zotero library."
                        : "Beaver will sync your library, upload your PDFs, and index your files for search. This process can take 20-60 min."
                    }
                </p>
            </div>

            {/* Step 1: Library Selection & Authorization */}
            {!userAuthorization ? (
                <div className="display-flex flex-col gap-3">
                    <div className="text-lg font-semibold mb-3">Step 1: Authorize Library Access</div>
                    <div className="text-base font-color-secondary">
                        Select the libraries you want to sync with Beaver. By continuing, you authorize 
                        Beaver to access your selected libraries, upload your PDFs, and index your files 
                        for enhanced search capabilities.
                    </div>
                    
                    {/* Library Selector Component */}
                    <LibrarySelector
                        onSelectionChange={handleLibrarySelectionChange}
                        libraryStatistics={libraryStatistics}
                        setLibraryStatistics={setLibraryStatistics}
                    />
                    
                    {/* Button */}
                    <div className="display-flex flex-row mt-6">
                        <div className="flex-1" />
                        <Button
                            variant="solid"
                            rightIcon={ArrowRightIcon}
                            className="scale-11"
                            onClick={handleAuthorize}
                            disabled={!isLibrarySelectionValid}
                        >
                            Authorize & Continue
                        </Button>
                    </div>
                </div>
            ) : (
                // Step 2: Syncing Process
                <div className="display-flex flex-col gap-5">
                    {/* Syncing your library */}
                    <ProcessItem 
                        status={syncStatus}
                        icon={getSyncIcon()}
                        title="Syncing Zotero database"
                        progress={librarySyncProgress.progress}
                        leftText={librarySyncProgress.totalItems > 0
                            ? `${librarySyncProgress.syncedItems.toLocaleString()} of ${librarySyncProgress.totalItems.toLocaleString()} items`
                            : undefined
                        }
                        rightText={`${librarySyncProgress.progress}%`}
                    />
                    
                    {/* Uploading files */}
                    <ProcessItem 
                        status={fileStatus}
                        icon={CheckmarkIcon}
                        title={`Uploading ${fileStats.uploadPendingCount + fileStats.uploadCompletedCount + fileStats.uploadFailedCount} files`}
                        leftText={fileStats.uploadFailedCount > 0
                            ? `${fileStats.uploadFailedCount.toLocaleString()} failed`
                            : undefined
                        }
                        rightText={`${uploadProgress}%`}
                        progress={uploadProgress}
                    />
                    
                    {/* Indexing files */}
                    <ProcessItem 
                        status={getIndexingStatus()}
                        icon={CheckmarkIcon}
                        title="Indexing files"
                        progress={indexingProgress}
                    />

                    <div className="flex-1"/>

                    {/* Button */}
                    <div className="display-flex flex-row mb-1">
                        <div className="flex-1" />
                        <Button
                            variant="solid"
                            rightIcon={ArrowRightIcon}
                            className="scale-11"
                        >
                            Complete
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default OnboardingPage;