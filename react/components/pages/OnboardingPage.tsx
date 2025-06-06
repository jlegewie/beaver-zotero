import React, { useState, useEffect } from "react";
import { Spinner, ArrowRightIcon, RepeatIcon, LogoutIcon, UserIcon } from "../icons/icons";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useFileStatus } from '../../hooks/useFileStatus';
import { fileStatusStatsAtom } from "../../atoms/files";
import { librariesSyncStatusAtom, librarySyncProgressAtom, LibrarySyncStatus } from "../../atoms/sync";
import Button from "../ui/Button";
import { userIdAtom, logoutAtom } from "../../atoms/auth";
import { hasAuthorizedAccessAtom, hasCompletedInitialSyncAtom } from '../../atoms/profile';
import LibrarySelector from "../auth/LibrarySelector";
import { setPref } from "../../../src/utils/prefs";
import { LibraryStatistics } from "../../../src/utils/libraries";
import { syncZoteroDatabase } from "../../../src/utils/sync";
import { planSupportedAtom } from "../../atoms/profile";
import { logger } from "../../../src/utils/logger";
import { accountService } from "../../../src/services/accountService";
import FileUploadStatus from "../status/FileUploadStatus";
import { CancelIcon, CheckmarkIcon, SpinnerIcon } from "../status/icons";
import { isUploadCompleteAtom, uploadStatsAtom } from "../../atoms/status";
import FileProcessingStatus from "../status/FileProcessingStatus";
import { DatabaseSyncStatus } from "../status/DatabaseSyncStatus";


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
                                status: library?.itemCount && library.itemCount > 0 ? 'idle' : 'completed',
                            } as LibrarySyncStatus
                        ];
                    })
            );

            // Save the sync status for the selected libraries
            setPref('selectedLibrary', JSON.stringify(selectedLibraries));
            setLibrariesSyncStatus(selectedLibraries);
            
            // Call the service to authorize access
            const requireOnboarding = (Object.values(selectedLibraries) as LibrarySyncStatus[]).some((library: LibrarySyncStatus) => library.status === 'idle');
            await accountService.authorizeAccess(requireOnboarding);
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

    const getFooterMessage = () => {
        if (!isUploadComplete || !hasCompletedInitialSync) {
            return "Please wait for the file uploads to complete.";
        } else if (uploadStats && uploadStats.failed > 0) {
            return "Failed to upload some files. Please retry to use them with Beaver."
        } else if (isUploadComplete && uploadStats && uploadStats.failed === 0 && fileStats.progress < 100) {
            return "Processing incomplete. Expect slower response times & limited search."
        }
        return "";
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
                        <div className="display-flex flex-row gap-3">
                            <Button variant="outline" icon={UserIcon} onClick={() => Zotero.getActiveZoteroPane().loadURI('https://beaver.org/account')}>Manage Account</Button>
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
                        <DatabaseSyncStatus />
                        
                        {/* Uploading files */}
                        <FileUploadStatus />
                        
                        {/* File Processing */}
                        <FileProcessingStatus />

                    </div>
                )}
            </div>

            {/* Fixed button area */}
            <div className="p-4 border-top-quinary">
                {/* Plan not supported buttons */}
                {!planSupported && (
                    <div className="display-flex flex-row items-center gap-3">
                        <div className="flex-1" />
                        <Button variant="solid" icon={LogoutIcon} onClick={logout}>Logout</Button>
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

                        {/* Footer message */}
                        <div className="font-color-secondary text-sm">
                            {getFooterMessage()}
                        </div>

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