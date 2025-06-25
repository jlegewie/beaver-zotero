import React, { useState, useEffect } from "react";
import { Spinner, ArrowRightIcon } from "../icons/icons";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useFileStatus } from '../../hooks/useFileStatus';
import { fileStatusStatsAtom } from "../../atoms/files";
import { librariesSyncStatusAtom, librarySyncProgressAtom, LibrarySyncStatus } from "../../atoms/sync";
import Button from "../ui/Button";
import { hasAuthorizedAccessAtom, hasCompletedInitialSyncAtom } from '../../atoms/profile';
import LibrarySelector from "../auth/LibrarySelector";
import { setPref } from "../../../src/utils/prefs";
import { LibraryStatistics } from "../../../src/utils/libraries";
import { syncZoteroDatabase } from "../../../src/utils/sync";
import { logger } from "../../../src/utils/logger";
import { accountService } from "../../../src/services/accountService";
import FileUploadStatus from "../status/FileUploadStatus";
import { CancelIcon, CheckmarkIcon, SpinnerIcon } from "../status/icons";
import { isUploadCompleteAtom, uploadStatsAtom } from "../../atoms/status";
import FileProcessingStatus from "../status/FileProcessingStatus";
import { DatabaseSyncStatus } from "../status/DatabaseSyncStatus";
import { profileWithPlanAtom } from "../../atoms/profile";
import { getZoteroUserIdentifier } from "../../../src/utils/zoteroIdentifier";
import { ZoteroLibrary } from "../../types/zotero";
import { userAtom } from "../../atoms/auth";


const OnboardingPage: React.FC = () => {
    // Auth state
    const [profileWithPlan, setProfileWithPlan] = useAtom(profileWithPlanAtom);
    const user = useAtomValue(userAtom);
    
    // Onboarding state
    const hasAuthorizedAccess = useAtomValue(hasAuthorizedAccessAtom);
    const [hasCompletedInitialSync, setHasCompletedInitialSync] = useAtom(hasCompletedInitialSyncAtom);
    const isUploadComplete = useAtomValue(isUploadCompleteAtom);
    const uploadStats = useAtomValue(uploadStatsAtom);

    // Track selected libraries
    const [selectedLibraryIds, setSelectedLibraryIds] = useState<number[]>([]);
    const [isLibrarySelectionValid, setIsLibrarySelectionValid] = useState<boolean>(false);

    // Realtime listening for file status updates
    const { connectionStatus } = useFileStatus();

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
        if (!profileWithPlan) return;
        
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
            
            // Determine if onboarding is required
            const requireOnboarding = (Object.values(selectedLibraries) as LibrarySyncStatus[]).some((library: LibrarySyncStatus) => library.status === 'idle');
            
            // Call the service to authorize access
            const libraries = selectedLibraryIds
                .map(id => {
                    const library = Zotero.Libraries.get(id);
                    if (!library) return null;
                    return {
                        library_id: library.libraryID,
                        name: library.name,
                        is_group: library.isGroup,
                        type: library.libraryType,
                        type_id: library.libraryTypeID,
                    } as ZoteroLibrary;
                })
                .filter(library => library !== null);
            
            await accountService.authorizeAccess(requireOnboarding, libraries, profileWithPlan.plan.processing_tier);

            // Update profile atoms
            if (profileWithPlan) {
                const { userID, localUserKey } = getZoteroUserIdentifier();
                setProfileWithPlan({
                    ...profileWithPlan,
                    has_authorized_access: true,
                    consented_at: new Date(),
                    zotero_user_id: userID || profileWithPlan.zotero_user_id,
                    zotero_local_id: localUserKey,
                    has_completed_onboarding: !requireOnboarding || profileWithPlan.has_completed_onboarding
                });
            }

            // Update user ID and email in prefs
            setPref("userId", user?.id ?? "");
            setPref("userEmail", user?.email ?? "");
            
        } catch (error) {
            logger(`OnboardingPage: Error authorizing access: ${error}`);
            // Revert optimistic update on error by fetching fresh profile
            // Note: We could store currentProfile outside try block, but a fresh fetch is safer
        } finally {
            setIsAuthorizing(false);
        }
    };

    const handleCompleteOnboarding = async () => {
        if (isCompletingOnboarding) return;
        if (!profileWithPlan) return;
        
        setIsCompletingOnboarding(true);
        try {            
            // Call the service to complete onboarding
            await accountService.completeOnboarding(profileWithPlan.plan.processing_tier);

            // Update profile atom for immediate UI feedback
            if (profileWithPlan) {
                setProfileWithPlan({
                    ...profileWithPlan,
                    has_completed_onboarding: true
                });
            }
            
        } catch (error) {
            logger(`OnboardingPage: Error completing onboarding: ${error}`);
            // Revert optimistic update on error
            if (profileWithPlan) {
                setProfileWithPlan({
                    ...profileWithPlan,
                    has_completed_onboarding: false
                });
            }
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
                {/* <div style={{ height: '5vh' }}></div> */}

                {/* Header section - always shown */}
                <div className="display-flex flex-col items-start mb-3">
                    <h1 className="text-2xl font-semibold">Welcome to Beaver 🦫</h1>
                    <p className="text-base font-color-secondary -mt-1">
                        Beaver syncs your library, uploads your PDFs, and indexes your files for search. This process typically takes 20–60 minutes.
                    </p>
                </div>

                {/* ------------- Step 1: Library Selection & Authorization ------------- */}
                {!hasAuthorizedAccess && (
                    <div className="display-flex flex-col gap-4">
                        <div className="text-lg font-semibold">Step 1: Authorize Library Access</div>
                        <div className="text-base font-color-secondary">
                            Select the libraries you want to sync with Beaver. By continuing, you link this Zotero account to your Beaver account and authorize 
                            Beaver to access your selected libraries, upload your PDFs, and index your files.
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
                {hasAuthorizedAccess && (
                    <div className="display-flex flex-col gap-4">
                        <div className="text-lg font-semibold mb-3">Step 2: Syncing Process</div>

                        <div className="display-flex flex-col gap-4">
                            {/* Syncing your library */}
                            <DatabaseSyncStatus />
                            
                            {/* Uploading files */}
                            <FileUploadStatus />
                            
                            {/* File Processing */}
                            <FileProcessingStatus connectionStatus={connectionStatus} />
                        </div>

                    </div>
                )}
            </div>

            {/* Fixed button area */}
            <div className="p-4 border-top-quinary">
                {/* Library selection button */}
                {!hasAuthorizedAccess && (
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
                {hasAuthorizedAccess && (
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