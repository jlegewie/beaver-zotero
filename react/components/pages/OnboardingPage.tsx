import React, { useState, useEffect } from "react";
import { CheckmarkCircleIcon, CancelCircleIcon, ClockIcon, InformationCircleIcon, SyncIcon, Icon, Spinner, ArrowRightIcon, RepeatIcon, AlertIcon, LogoutIcon, UserIcon, ThreeIcon, OneIcon, TwoIcon } from "../icons/icons";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useFileStatus } from '../../hooks/useFileStatus';
import { FileStatusStats, fileStatusStatsAtom } from "../../atoms/ui";
import { librariesSyncStatusAtom, librarySyncProgressAtom, LibrarySyncStatus } from "../../atoms/sync";
import Button from "../ui/Button";
import { userIdAtom, logoutAtom } from "../../atoms/auth";
import { hasAuthorizedAccessAtom, hasCompletedInitialSyncAtom } from '../../atoms/profile';
import LibrarySelector from "../auth/LibrarySelector";
import { setPref } from "../../../src/utils/prefs";
import { LibraryStatistics } from "../../../src/utils/libraries";
import { syncZoteroDatabase } from "../../../src/utils/sync";
import IconButton from "../ui/IconButton";
import { planSupportedAtom } from "../../atoms/profile";
import { logger } from "../../../src/utils/logger";
import { accountService } from "../../../src/services/accountService";
import { StatusItem } from "../ui/buttons/FileStatusButton";
import FileUploadStatus from "../status/FileUploadStatus";
import { CancelIcon, CheckmarkIcon, SpinnerIcon, StepThreeIcon } from "../status/icons";
import { ProgressBar } from "../status/ProgressBar";
import { isUploadCompleteAtom, uploadStatsAtom } from "../../atoms/status";


const ProcessItem: React.FC<{
    icon: React.ReactNode,
    title: string,
    description?: string,
    progress?: number,
    leftText?: string,
    rightText?: string,
    fileStats?: FileStatusStats,
    rightIcon?: React.ComponentType<React.SVGProps<SVGSVGElement>> | undefined,
    onClick?: () => void,
}> = ({ icon, title, description, progress, leftText, rightText, fileStats, rightIcon, onClick }) => {

    const syncIconClassName = fileStats
        ? `scale-90 ${fileStats.activeProcessingCount > 0 ? 'animate-spin' : ''}`
        : '';
    
    return (
        <div className="display-flex flex-row gap-4 p-3 border-popup rounded-md bg-quinary">
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
                                {fileStats ? (
                                    <div className="display-flex flex-row gap-3">
                                        {/* <StatusItem icon={ClockIcon} count={fileStats.queuedProcessingCount + fileStats.uploadPendingCount} textClassName="text-base" iconClassName="scale-90" /> */}
                                        <StatusItem icon={ClockIcon} count={fileStats.queuedProcessingCount} textClassName="text-base" iconClassName="scale-90" />
                                        <StatusItem icon={SyncIcon} count={fileStats.activeProcessingCount} textClassName="text-base" iconClassName={syncIconClassName} />
                                        <StatusItem icon={CheckmarkCircleIcon} count={fileStats.completedFiles} textClassName="text-base" iconClassName="scale-90 text-green-500" />
                                        <StatusItem icon={CancelCircleIcon} count={fileStats.failedCount} textClassName="text-base" iconClassName="scale-90 text-red-500" />
                                    </div>
                                ) : (
                                    leftText || ""
                                )}
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
    const hasAuthorizedAccess = useAtomValue(hasAuthorizedAccessAtom);
    const [hasCompletedInitialSync, setHasCompletedInitialSync] = useAtom(hasCompletedInitialSyncAtom);
    const isUploadComplete = useAtomValue(isUploadCompleteAtom);
    const uploadStats = useAtomValue(uploadStatsAtom);

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

    // Loading states for service calls
    const [isAuthorizing, setIsAuthorizing] = useState(false);
    const [isCompletingOnboarding, setIsCompletingOnboarding] = useState(false);

    // Library Sync complete: Set hasCompletedInitialSync and start upload polling
    useEffect(() => {
        const isSyncComplete = librarySyncProgress.progress >= 100 && !librarySyncProgress.anyFailed;

        // Set hasCompletedInitialSync
        setHasCompletedInitialSync(isSyncComplete);
    }, [librarySyncProgress.progress, librarySyncProgress.anyFailed]);

    // Calculate progress percentages
    const calculateProgress = (current: number, total: number): number => {
        if (total <= 0) return 0;
        return Math.min(Math.round((current / total) * 100), 100);
    };

    // Handle retry clicks
    const handleSyncRetryClick = () => {
        syncZoteroDatabase();
    };

    const getSyncIcon = (): React.ReactNode => {
        if (librarySyncProgress.anyFailed) return CancelIcon;
        if (librarySyncProgress.progress < 100) return SpinnerIcon;
        if (librarySyncProgress.progress >= 100) return CheckmarkIcon;
        return SpinnerIcon;
    };

    const getIndexingIcon = (): React.ReactNode => {
        if (librarySyncProgress.anyFailed) return StepThreeIcon;
        if (fileStats.totalProcessingCount === 0) return StepThreeIcon;
        if (fileStats.progress >= 100) return CheckmarkIcon;
        return SpinnerIcon;
    };

    const getIndexingLeftText = (): string => {
        if (fileStats.totalProcessingCount === 0) return "";
        const textParts: string[] = [];
        textParts.push(`${fileStats.completedFiles.toLocaleString()} completed`);
        if (fileStats.failedProcessingCount > 0) textParts.push(`${fileStats.failedProcessingCount.toLocaleString()} failed`);
        if (fileStats.activeProcessingCount > 0) textParts.push(`${fileStats.activeProcessingCount.toLocaleString()} active`);
        if (fileStats.queuedProcessingCount > 0) textParts.push(`${fileStats.queuedProcessingCount.toLocaleString()} queued`);
        return textParts.join(", ");
    };

    // Handle library selection change
    const handleLibrarySelectionChange = (libraryIds: number[]) => {
        setSelectedLibraryIds(libraryIds);
        setIsLibrarySelectionValid(libraryIds.length > 0);
    };

    // Handle authorization
    const handleAuthorize = async () => {
        if (selectedLibraryIds.length === 0 || isAuthorizing) return;
        
        setIsAuthorizing(true);
        try {
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
            
            // Call the service to authorize access
            await accountService.authorizeAccess();
        } catch (error) {
            logger(`OnboardingPage: Error authorizing access: ${error}`);
        } finally {
            setIsAuthorizing(false);
        }
    };

    const handleCompleteOnboarding = async () => {
        if (isCompletingOnboarding) return;
        
        setIsCompletingOnboarding(true);
        try {
            // Call the service to complete onboarding
            await accountService.completeOnboarding();
            
        } catch (error) {
            logger(`OnboardingPage: Error completing onboarding: ${error}`);
        } finally {
            setIsCompletingOnboarding(false);
        }
    };
    
    return (
        <div 
            id="onboarding-page"
            className="display-flex flex-col flex-1 min-h-0 min-w-0"
        >
            {/* Scrollable content area */}
            <div className="overflow-y-auto scrollbar flex-1 p-4 mr-1">
                {/* Top spacing */}
                <div style={{ height: '5vh' }}></div>

                {/* Header section - always shown */}
                <div className="display-flex flex-col items-start mb-3">
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
                    </div>
                )}

                {/* ------------- Step 2: Syncing Process ------------- */}
                {planSupported && hasAuthorizedAccess && (
                    <div className="display-flex flex-col gap-4">
                        {/* Syncing your library */}
                        <ProcessItem 
                            icon={getSyncIcon()}
                            title="Syncing Zotero database"
                            progress={librarySyncProgress.progress}
                            leftText={librarySyncProgress.totalItems > 0
                                ? `${librarySyncProgress.syncedItems.toLocaleString()} completed`
                                : undefined
                            }
                            rightText={`${librarySyncProgress.progress.toFixed(0)}%`}
                            rightIcon={librarySyncProgress.anyFailed ? RepeatIcon : undefined}
                            onClick={librarySyncProgress.anyFailed ? handleSyncRetryClick : undefined}
                        />
                        
                        {/* Uploading files */}
                        <FileUploadStatus isOnboardingPage={true}/>
                        
                        {/* Indexing files */}
                        <ProcessItem 
                            icon={getIndexingIcon()}
                            title="File processing"
                            progress={fileStats.progress}
                            rightText={fileStats.totalProcessingCount === 0 ? "" : `${Math.min(fileStats.progress, 100).toFixed(0)}%`}
                            leftText={getIndexingLeftText()}
                            fileStats={fileStats}
                        />

                    </div>
                )}
            </div>

            {/* Fixed button area */}
            <div className="p-4 border-top-quinary">
                {/* Plan not supported buttons */}
                {!planSupported && (
                    <div className="display-flex flex-row items-center gap-3">
                        <Button variant="outline" icon={UserIcon} onClick={() => Zotero.getActiveZoteroPane().loadURI('https://beaver.org/account')}>Manage Account</Button>
                        <Button variant="outline" icon={LogoutIcon} onClick={logout}>Logout</Button>
                    </div>
                )}

                {/* Library selection button */}
                {planSupported && !hasAuthorizedAccess && (
                    <div className="display-flex flex-row">
                        <div className="flex-1" />
                        <Button
                            variant="solid"
                            rightIcon={isAuthorizing ? Spinner : ArrowRightIcon}
                            onClick={handleAuthorize}
                            disabled={!isLibrarySelectionValid || isAuthorizing}
                        >
                            Authorize & Continue
                        </Button>
                    </div>
                )}

                {/* Syncing process button */}
                {planSupported && hasAuthorizedAccess && (
                    <div className="display-flex flex-row items-center gap-4">

                        {/* Warning messages */}
                        {uploadStats && uploadStats.failed > 0 && (
                            <div className="font-color-secondary text-sm">
                                Failed to upload some files. Please retry to use them in with Beaver.
                            </div>
                        )}

                        {isUploadComplete && uploadStats && uploadStats.failed === 0 && fileStats.progress < 100 && (
                            <div className="font-color-secondary text-sm">
                                Processing incomplete. Expect slower response times & limited search.
                            </div>
                        )}
                        <div className="flex-1" />

                        {/* Complete onboarding button */}
                        <Button
                            variant="solid"
                            rightIcon={isCompletingOnboarding ? Spinner : ArrowRightIcon}
                            disabled={!isUploadComplete || !hasCompletedInitialSync || isCompletingOnboarding}
                            onClick={handleCompleteOnboarding}
                        >
                            Complete
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default OnboardingPage;