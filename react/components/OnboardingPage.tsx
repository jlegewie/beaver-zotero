import React, { useState, useEffect } from "react";
import { CheckmarkCircleIcon, CancelCircleIcon, Icon, Spinner, ArrowRightIcon, RepeatIcon, LogoutIcon, UserIcon, ThreeIcon, OneIcon, TwoIcon } from "./icons";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useFileStatus } from '../hooks/useFileStatus';
import { useUploadProgress } from '../hooks/useUploadProgress';
import { fileStatusStatsAtom } from "../atoms/ui";
import {
    librariesSyncStatusAtom,
    librarySyncProgressAtom,
    LibrarySyncStatus,
    uploadQueueStatusAtom,
    uploadQueueTotalAtom
} from "../atoms/sync";
import Button from "./button";
import { userIdAtom, logoutAtom } from "../atoms/auth";
import { hasCompletedOnboardingAtom, hasAuthorizedAccessAtom, hasCompletedInitialSyncAtom, hasCompletedInitialUploadAtom } from '../atoms/profile';
import LibrarySelector from "./LibrarySelector";
import { setPref } from "../../src/utils/prefs";
import { LibraryStatistics } from "../../src/utils/libraries";
import { syncZoteroDatabase } from "../../src/utils/sync";
import IconButton from "./IconButton";
import { planSupportedAtom } from "../atoms/profile";
import { logger } from "../../src/utils/logger";
import { resetFailedUploads } from '../../src/services/FileUploader';

const MAX_FAILED_UPLOAD_PERCENTAGE = 0.2;

const ProgressBar: React.FC<{ progress: number }> = ({ progress }) => (
    <div className="w-full h-2 bg-tertiary rounded-sm overflow-hidden mt-1 mb-2" style={{ height: '8px' }}>
        <div
            className="h-full bg-secondary rounded-sm transition-width duration-500 ease-in-out"
            style={{ width: `${Math.min(progress, 100)}%` }}
        />
    </div>
);

const ProcessItem: React.FC<{
    icon: React.ReactNode,
    title: string,
    description?: string,
    progress?: number,
    leftText?: string,
    rightText?: string,
    rightIcon?: React.ComponentType<React.SVGProps<SVGSVGElement>> | undefined,
    onClick?: () => void,
}> = ({ icon, title, description, progress, leftText, rightText, rightIcon, onClick }) => {
    return (
        <div className="display-flex flex-row gap-4">
            <div className="mt-1">
                {icon}
            </div>
            <div className="display-flex flex-col gap-3 items-start flex-1">
                <div className="display-flex flex-row items-center gap-3 w-full min-w-0">
                    <div className="font-color-primary text-lg">{title}</div>
                    <div className="flex-1"/>
                    {rightIcon && onClick && (
                        <IconButton icon={rightIcon} onClick={onClick} variant="ghost-secondary" className="scale-12" />
                    )}
                </div>
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
    // Auth state
    const logout = useSetAtom(logoutAtom);
    const userId = useAtomValue(userIdAtom);
    const planSupported = useAtomValue(planSupportedAtom);
    
    // Onboarding state
    const [hasAuthorizedAccess, setHasAuthorizedAccess] = useAtom(hasAuthorizedAccessAtom);
    const [hasCompletedInitialSync, setHasCompletedInitialSync] = useAtom(hasCompletedInitialSyncAtom);
    const [hasCompletedInitialUpload, setHasCompletedInitialUpload] = useAtom(hasCompletedInitialUploadAtom);
    const setHasCompletedOnboarding = useSetAtom(hasCompletedOnboardingAtom);
    
    // File upload state
    const uploadQueueStatus = useAtomValue(uploadQueueStatusAtom);
    const uploadQueueTotal = useAtomValue(uploadQueueTotalAtom);

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

    // Upload progress hook
    const {
        stats: uploadStats,
        isPolling: isUploadPolling,
        isLoading: isUploadLoading,
        error: uploadError,
        startPolling: startUploadPolling,
        stopPolling: stopUploadPolling,
        refresh: refreshUploadStats,
        progress: uploadProgress,
        isComplete: isUploadComplete
    } = useUploadProgress(
        {
            interval: 1500,
            autoStart: false,
            autoStop: true,
            onComplete: (stats) => {
                // Check if upload is complete with acceptable failure rate
                const failureRate = stats.total > 0 ? stats.failed / stats.total : 0;
                if (failureRate <= MAX_FAILED_UPLOAD_PERCENTAGE) {
                    setHasCompletedInitialUpload(true);
                    setPref('hasCompletedInitialUpload', true);
                }
            },
            onError: (error: any) => {
                logger('Upload progress polling error:', error);
            }
        }
    );

    // Library Sync complete: Set hasCompletedInitialSync and start upload polling
    useEffect(() => {
        const isSyncComplete = librarySyncProgress.progress >= 100 && !librarySyncProgress.anyFailed;

        // Set hasCompletedInitialSync
        setHasCompletedInitialSync(isSyncComplete);
        setPref('hasCompletedInitialSync', isSyncComplete);

        // Start upload polling
        const shouldStartPolling = isSyncComplete && !isUploadPolling && !isUploadComplete && !!userId;
        const shouldStopPolling = (!isSyncComplete || isUploadComplete) && isUploadPolling;
        logger(`Polling: isSyncComplete: ${isSyncComplete} isUploadPolling: ${isUploadPolling} isUploadComplete: ${isUploadComplete} userId: ${userId}`);
        logger(`Polling: shouldStartPolling: ${shouldStartPolling} shouldStopPolling: ${shouldStopPolling}`);
        if (shouldStartPolling) {
            startUploadPolling();
        } else if (shouldStopPolling) {
            stopUploadPolling();
        }
    }, [librarySyncProgress.progress, librarySyncProgress.anyFailed, isUploadPolling, isUploadComplete, userId, startUploadPolling, stopUploadPolling]);

    // Update ready state based on upload completion and failure rate
    useEffect(() => {
        if (isUploadComplete && uploadStats) {
            const failureRate = uploadStats.total > 0 ? uploadStats.failed / uploadStats.total : 0;
            setHasCompletedInitialUpload(failureRate <= MAX_FAILED_UPLOAD_PERCENTAGE);
        }
    }, [isUploadComplete, uploadStats, setHasCompletedInitialUpload]);

    // Calculate progress percentages
    const calculateProgress = (current: number, total: number): number => {
        if (total <= 0) return 0;
        return Math.min(Math.round((current / total) * 100), 100);
    };

    // Handle retry clicks
    const handleSyncRetryClick = () => {
        syncZoteroDatabase();
    };

    const handleUploadRetryClick = async () => {
        await resetFailedUploads();
        startUploadPolling();
    };

    // Icons
    const CancelIcon = <Icon icon={CancelCircleIcon} className="font-color-red scale-14" />;
    const CheckmarkIcon = <Icon icon={CheckmarkCircleIcon} className="font-color-green scale-14" />;
    const StepOneIcon = <Icon icon={OneIcon} className="font-color-secondary scale-14" />;
    const StepTwoIcon = <Icon icon={TwoIcon} className="font-color-secondary scale-14" />;
    const StepThreeIcon = <Icon icon={ThreeIcon} className="font-color-secondary scale-14" />;
    const SpinnerIcon = <Spinner className="scale-14 -mr-1" />;

    const getSyncIcon = (): React.ReactNode => {
        if (librarySyncProgress.anyFailed) return CancelIcon;
        if (librarySyncProgress.progress < 100) return SpinnerIcon;
        if (librarySyncProgress.progress >= 100) return CheckmarkIcon;
        return SpinnerIcon;
    };

    const getUploadIcon = (): React.ReactNode => {
        // Ensure library sync is complete
        if (librarySyncProgress.anyFailed) return StepTwoIcon;
        if (librarySyncProgress.progress < 100) return StepTwoIcon;

        // Use upload stats from hook
        if (uploadStats) {
            const failureRate = uploadStats.total > 0 ? uploadStats.failed / uploadStats.total : 0;
            if (failureRate > MAX_FAILED_UPLOAD_PERCENTAGE) return CancelIcon;
            if (isUploadComplete) return CheckmarkIcon;
        }
        
        if (uploadError) return CancelIcon;
        return SpinnerIcon;
    };

    const getIndexingIcon = (): React.ReactNode => {
        if (librarySyncProgress.anyFailed) return StepThreeIcon;
        if (fileStats.totalProcessingCount === 0) return StepThreeIcon;
        if (fileStats.processingProgress >= 100) return CheckmarkIcon;
        return SpinnerIcon;
    };

    const getUploadLeftText = (): string => {
        if (!uploadStats) return "";
        
        const textParts: string[] = [];
        if (uploadStats.total > 0) textParts.push(`${uploadStats.completed.toLocaleString()} completed`);
        if (uploadStats.failed > 0) textParts.push(`${uploadStats.failed.toLocaleString()} failed`);
        if (uploadStats.skipped > 0) textParts.push(`${uploadStats.skipped.toLocaleString()} skipped`);
        return textParts.join(", ");
    };

    const getIndexingLeftText = (): string => {
        if (fileStats.totalProcessingCount === 0) return "";
        const textParts: string[] = [];
        if (fileStats.failedProcessingCount > 0) textParts.push(`${fileStats.failedProcessingCount.toLocaleString()} failed`);
        if (fileStats.activeProcessingCount > 0) textParts.push(`${fileStats.activeProcessingCount.toLocaleString()} active`);
        if (fileStats.queuedProcessingCount > 0) textParts.push(`${fileStats.queuedProcessingCount.toLocaleString()} queued`);
        return textParts.join(", ");
    };

    const hasUploadFailures = (): boolean => {
        if (!uploadStats) return false;
        const failureRate = uploadStats.total > 0 ? uploadStats.failed / uploadStats.total : 0;
        return failureRate > MAX_FAILED_UPLOAD_PERCENTAGE;
    };

    // Handle library selection change
    const handleLibrarySelectionChange = (libraryIds: number[]) => {
        setSelectedLibraryIds(libraryIds);
        setIsLibrarySelectionValid(libraryIds.length > 0);
    };

    // Handle authorization
    const handleAuthorize = () => {
        if (selectedLibraryIds.length === 0) return;
        
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
        setPref('hasAuthorizedAccess', true);
        setHasAuthorizedAccess(true);
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
                    {!hasAuthorizedAccess 
                        ? "Let's set up your Beaver environment by connecting to your Zotero library."
                        : "Beaver will sync your library, upload your PDFs, and index your files for search. This process can take 20-60 min."
                    }
                </p>
            </div>

            {/* ------------- Plan not supported ------------- */}
            {!planSupported && (
                <div className="display-flex flex-col gap-3">
                    <div className="text-lg font-semibold mb-3">Plan not supported</div>
                    <div className="text-base font-color-secondary">
                        Your plan does not support the features required for Beaver. Please upgrade your plan to continue.
                    </div>
                    <div className="display-flex flex-row items-center gap-3 mt-2">
                        <Button variant="outline" icon={UserIcon} onClick={() => Zotero.getActiveZoteroPane().loadURI('https://beaver.org/account')}>Manage Account</Button> {/* Example: Open web page */}
                        <Button variant="outline" icon={LogoutIcon} onClick={logout}>Logout</Button>
                    </div>
                </div>
            )}

            {/* ------------- Step 1: Library Selection & Authorization ------------- */}
            {planSupported && !hasAuthorizedAccess && (
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
            )}

            {/* ------------- Step 2: Syncing Process ------------- */}
            {planSupported && hasAuthorizedAccess && (
                <div className="display-flex flex-col gap-5">
                    {/* Syncing your library */}
                    <ProcessItem 
                        icon={getSyncIcon()}
                        title="Syncing Zotero database"
                        progress={librarySyncProgress.progress}
                        leftText={librarySyncProgress.totalItems > 0
                            ? `${librarySyncProgress.syncedItems.toLocaleString()} of ${librarySyncProgress.totalItems.toLocaleString()} items`
                            : undefined
                        }
                        rightText={`${librarySyncProgress.progress}%`}
                        rightIcon={librarySyncProgress.anyFailed ? RepeatIcon : undefined}
                        onClick={librarySyncProgress.anyFailed ? handleSyncRetryClick : undefined}
                    />
                    
                    {/* Uploading files */}
                    <ProcessItem 
                        icon={getUploadIcon()}
                        title="Uploading files"
                        leftText={getUploadLeftText()}
                        rightText={librarySyncProgress.progress < 100 ? "" : `${uploadProgress}%`}
                        progress={uploadProgress}
                        rightIcon={hasUploadFailures() ? RepeatIcon : undefined}
                        onClick={hasUploadFailures() ? handleUploadRetryClick : undefined}
                    />
                    
                    {/* Indexing files */}
                    <ProcessItem 
                        icon={getIndexingIcon()}
                        title="File processing"
                        progress={fileStats.processingProgress}
                        rightText={fileStats.totalProcessingCount === 0 ? "" : `${fileStats.progress}%`}
                        leftText={getIndexingLeftText()}
                    />

                    <div className="flex-1"/>

                    {/* Button */}
                    <div className="display-flex flex-row items-center mb-1">
                        <div className="flex-1 font-color-secondary text-sm">
                            {fileStats.processingProgress < 100 ? "Processing incomplete. Expect slower response times & limited search." : ""}
                        </div>
                        <Button
                            variant="solid"
                            rightIcon={ArrowRightIcon}
                            className="scale-11"
                            disabled={!hasCompletedInitialUpload || !hasCompletedInitialSync}
                            onClick={() => {
                                setPref('hasCompletedOnboarding', true)
                                setHasCompletedOnboarding(true)
                            }}
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