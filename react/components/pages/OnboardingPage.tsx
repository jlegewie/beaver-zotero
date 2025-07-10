import React, { useState, useEffect } from "react";
import { Spinner, ArrowRightIcon, Icon, AlertIcon } from "../icons/icons";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useFileStatus } from '../../hooks/useFileStatus';
import { fileStatusSummaryAtom } from "../../atoms/files";
import { isSyncCompleteAtom, syncStatusAtom, LibrarySyncStatus } from "../../atoms/sync";
import Button from "../ui/Button";
import { hasAuthorizedAccessAtom } from '../../atoms/profile';
import LibrarySelector from "../auth/LibrarySelector";
import { setPref } from "../../../src/utils/prefs";
import { LibraryStatistics } from "../../../src/utils/libraries";
import { logger } from "../../../src/utils/logger";
import { accountService } from "../../../src/services/accountService";
import FileUploadStatus from "../status/FileUploadStatus";
import { isUploadCompleteAtom } from "../../atoms/files";
import FileProcessingStatus from "../status/FileProcessingStatus";
import { DatabaseSyncStatus } from "../status/DatabaseSyncStatus";
import { profileWithPlanAtom } from "../../atoms/profile";
import { getZoteroUserIdentifier, isLibrarySynced } from "../../../src/utils/zoteroIdentifier";
import { ZoteroLibrary } from "../../types/zotero";
import { userAtom } from "../../atoms/auth";
import { useUploadQueueManager } from "../../hooks/useUploadQueueManager";


const OnboardingPage: React.FC = () => {
    // Auth state
    const [profileWithPlan, setProfileWithPlan] = useAtom(profileWithPlanAtom);
    const user = useAtomValue(userAtom);
    
    // Onboarding state
    const hasAuthorizedAccess = useAtomValue(hasAuthorizedAccessAtom);
    const isUploadComplete = useAtomValue(isUploadCompleteAtom);

    // Track selected libraries
    const [selectedLibraryIds, setSelectedLibraryIds] = useState<number[]>([]);
    const [isLibrarySelectionValid, setIsLibrarySelectionValid] = useState<boolean>(false);

    // Sync toggle state
    const [useZoteroSync, setUseZoteroSync] = useState<boolean>(false);

    // Realtime listening for file status updates
    const { connectionStatus } = useFileStatus();

    // Upload queue manager
    useUploadQueueManager();

    // Library sync state
    const setSyncStatus = useSetAtom(syncStatusAtom);
    const isSyncComplete = useAtomValue(isSyncCompleteAtom);
    
    // State for full library statistics (loaded asynchronously)
    const [libraryStatistics, setLibraryStatistics] = useState<LibraryStatistics[]>([]);

    // Processing state
    const fileStatusSummary = useAtomValue(fileStatusSummaryAtom);

    // Loading states for service calls
    const [isAuthorizing, setIsAuthorizing] = useState(false);
    const [isCompletingOnboarding, setIsCompletingOnboarding] = useState(false);

    // Initialize sync toggle state
    useEffect(() => {
        const syncEnabled = isLibrarySynced(1);
        setUseZoteroSync(syncEnabled);
    }, []);

    // Handle library selection change
    const handleLibrarySelectionChange = (libraryIds: number[]) => {
        setSelectedLibraryIds(libraryIds);
        setIsLibrarySelectionValid(libraryIds.length > 0);
    };

    // Handle sync toggle change
    const handleSyncToggleChange = (checked: boolean) => {
        setUseZoteroSync(checked);
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
            setSyncStatus(selectedLibraries);
            
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
            
            await accountService.authorizeAccess(requireOnboarding, libraries, profileWithPlan.plan.processing_tier, useZoteroSync);

            // Update local state
            if (profileWithPlan) {
                const { userID, localUserKey } = getZoteroUserIdentifier();
                setProfileWithPlan({
                    ...profileWithPlan,
                    libraries: libraries,
                    has_authorized_access: true,
                    consented_at: new Date(),
                    zotero_user_id: userID || profileWithPlan.zotero_user_id,
                    zotero_local_ids: [localUserKey],
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
                
        // Set completing onboarding to true
        setIsCompletingOnboarding(true);
        try {            
            // Call the service to complete onboarding
            await accountService.completeOnboarding(profileWithPlan.plan.processing_tier);

            // Show indexing complete message if indexing is not complete
            if (fileStatusSummary.progress < 100) setPref("showIndexingCompleteMessage", true);

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
        if (!isUploadComplete || !isSyncComplete) {
            return "Please wait for the file uploads to complete.";
        } else if (fileStatusSummary && fileStatusSummary.uploadFailedCount > 0) {
            return "Failed to upload some files. Please retry to use them with Beaver."
        } else if (isUploadComplete && fileStatusSummary && fileStatusSummary.uploadFailedCount === 0 && fileStatusSummary.progress < 100) {
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
            <div id="1" className="overflow-y-auto scrollbar flex-1 p-4 mr-1">
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
                    <div id="2" className="display-flex flex-col gap-4 flex-1 min-h-0">
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
                            useZoteroSync={useZoteroSync}
                            handleSyncToggleChange={handleSyncToggleChange}
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

                            {(connectionStatus === 'error' || connectionStatus === 'idle' || connectionStatus === 'disconnected') && (
                                <div className="p-2 font-color-tertiary display-flex flex-row gap-3 items-start">
                                    <Icon icon={AlertIcon} className="scale-12 mt-020"/>
                                    {/* TODO: Retry button */}
                                    <div>No connection. Please reconnect to continue with the onboarding process.</div>
                                </div>
                            )}
                            {(connectionStatus === 'connecting' || connectionStatus === 'reconnecting') && (
                                <div className="p-2 font-color-tertiary display-flex flex-row gap-3 items-start">
                                    <Spinner size={14} className="mt-015"/>
                                    <div>Connecting...</div>
                                </div>
                            )}
                            {connectionStatus === 'connected' && (
                                <>
                                    {/* Uploading files */}
                                    <FileUploadStatus/>

                                    {/* File Processing */}
                                    <FileProcessingStatus />
                                </>
                            )}
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
                            disabled={!isUploadComplete || !isSyncComplete || isCompletingOnboarding}
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