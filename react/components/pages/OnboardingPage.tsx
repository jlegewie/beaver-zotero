import React, { useState, useEffect } from "react";
import { Spinner, ArrowRightIcon } from "../icons/icons";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useFileStatus } from '../../hooks/useFileStatus';
import { fileStatusSummaryAtom } from "../../atoms/files";
import { overallSyncStatusAtom, syncStatusAtom, LibrarySyncStatus } from "../../atoms/sync";
import Button from "../ui/Button";
import { hasAuthorizedAccessAtom, syncLibrariesAtom } from '../../atoms/profile';
import AuthorizeLibraryAccess from "../auth/AuthorizeLibraryAccess";
import { setPref } from "../../../src/utils/prefs";
import { LibraryStatistics } from "../../../src/utils/libraries";
import { logger } from "../../../src/utils/logger";
import { accountService } from "../../../src/services/accountService";
import { isUploadProcessedAtom } from "../../atoms/files";
import { DatabaseSyncStatus } from "../status/DatabaseSyncStatus";
import { profileWithPlanAtom } from "../../atoms/profile";
import { getZoteroUserIdentifier, isLibrarySynced } from "../../../src/utils/zoteroUtils";
import { userAtom } from "../../atoms/auth";
import FileStatusDisplay from "../status/FileStatusDisplay";
import { isLibraryValidForSync } from "../../../src/utils/sync";
import { store } from "../../store";
import { serializeZoteroLibrary } from "../../../src/utils/zoteroSerializers";
import { ZoteroLibrary } from "../../types/zotero";


const OnboardingPage: React.FC = () => {
    // Auth state
    const [profileWithPlan, setProfileWithPlan] = useAtom(profileWithPlanAtom);
    const user = useAtomValue(userAtom);
    
    // Onboarding state
    const hasAuthorizedAccess = useAtomValue(hasAuthorizedAccessAtom);
    const isUploadProcessed = useAtomValue(isUploadProcessedAtom);

    // Track selected libraries
    const [selectedLibraryIds, setSelectedLibraryIds] = useState<number[]>([1]);
    const [isLibrarySelectionValid, setIsLibrarySelectionValid] = useState<boolean>(false);
    const [validLibraryIds, setValidLibraryIds] = useState<number[]>([]);

    // Sync toggle state
    const [useZoteroSync, setUseZoteroSync] = useState<boolean>(false);
    const [consentToShare, setConsentToShare] = useState<boolean>(false);

    // Realtime listening for file status updates
    const { connectionStatus } = useFileStatus();

    // Library sync state
    const setSyncStatus = useSetAtom(syncStatusAtom);
    const overallSyncStatus = useAtomValue(overallSyncStatusAtom);
    
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

    useEffect(() => {
        const validIds = selectedLibraryIds.filter(id => {
            const library = Zotero.Libraries.get(id);
            return isLibraryValidForSync(library, useZoteroSync);
        });
        setValidLibraryIds(validIds);
        setIsLibrarySelectionValid(validIds.length > 0);
    }, [selectedLibraryIds, useZoteroSync]);

    // Handle sync toggle change
    const handleSyncToggleChange = (checked: boolean) => {
        setUseZoteroSync(checked);
    };

    const handleConsentChange = (checked: boolean) => {
        setConsentToShare(checked);
    };

    // Handle authorization
    const handleAuthorize = async () => {
        if (validLibraryIds.length === 0 || isAuthorizing) return;
        if (!profileWithPlan) return;
        
        setIsAuthorizing(true);
        try {
            // Create a map of library IDs to library sync status
            const selectedLibraries = Object.fromEntries(
                validLibraryIds
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
            const libraries = validLibraryIds
                .map(id => {
                    const library = Zotero.Libraries.get(id);
                    if (!library) return null;
                    return serializeZoteroLibrary(library);
                })
                .filter(library => library !== null);
            logger(`OnboardingPage: Authorizing access with libraries: ${libraries.map(library => library.library_id).join(', ')}`, 2);
            await accountService.authorizeAccess(requireOnboarding, libraries, useZoteroSync, consentToShare);

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

        if (overallSyncStatus === 'partially_completed') {
            const buttonIndex = Zotero.Prompt.confirm({
                window: Zotero.getMainWindow(),
                title: "Complete Onboarding?",
                text: "Are you sure you want to complete onboarding?\n\nLibraries with errors will not be synced with Beaver.",
                button0: Zotero.Prompt.BUTTON_TITLE_YES,
                button1: Zotero.Prompt.BUTTON_TITLE_NO,
                defaultButton: 1,
            });

            if (buttonIndex === 1) {
                setIsCompletingOnboarding(false);
                return;
            }
        }
        try {
            // Get updated libraries
            let updatedLibraries = undefined;
            if (overallSyncStatus === 'partially_completed') {
                const syncStatus = store.get(syncStatusAtom);
                const completedLibraryIds = Object.values(syncStatus as Record<number, LibrarySyncStatus>)
                    .filter((library: LibrarySyncStatus) => library.status === 'completed')
                    .map(library => library.libraryID);
                updatedLibraries = (store.get(syncLibrariesAtom) as ZoteroLibrary[]).filter((library: ZoteroLibrary) => completedLibraryIds.includes(library.library_id));
            }
            
            // Call the service to complete onboarding
            await accountService.completeOnboarding(overallSyncStatus, updatedLibraries);

            // Update local state with updated libraries if they were updated
            if (updatedLibraries) {
                setProfileWithPlan({
                    ...profileWithPlan,
                    libraries: updatedLibraries
                });
            }

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
        if (overallSyncStatus === 'in_progress') {
            return "Initial syncing in progress.";
        } else if (overallSyncStatus === 'failed') {
            return `Initial syncing failed. Please retry or contact support.`;
        } else if (fileStatusSummary.pageBalanceExhausted) {
            return "Free file processing limit reached. Continue to use Beaver with processed files.";
        } else if (!isUploadProcessed) {
            return `Waiting for file uploads to complete (${fileStatusSummary.uploadPendingCount.toLocaleString()} remaining).`;
        } else if (isUploadProcessed && fileStatusSummary?.uploadFailedCount > 0) {
            return "Failed to upload some files. Please retry to use them with Beaver."
        } else if (isUploadProcessed && fileStatusSummary?.uploadFailedCount === 0 && fileStatusSummary.progress < 100) {
            return "File processing incomplete. Expect slower response times & limited search."
        }
        return "";
    };

    const getHeaderMessage = () => {
        if (!hasAuthorizedAccess) {
            // Step 1: Library Selection & Authorization
            return "Beaver syncs your Zotero data, uploads attachments, and indexes them for search and AI features. By continuing, you confirm you're authorized to upload these files and link your Zotero and Beaver account.";
        } else {
            // Step 2: Syncing Process
            return "We're now syncing your Zotero library and processing your files. This usually takes 20-60 minutes, depending on your library size and server load.\n\nYou can safely close Beaver and return later. Just make sure Zotero stays open so syncing can continue in the background.";
        }
    };
    
    return (
        <div 
            id="onboarding-page"
            className="display-flex flex-col flex-1 min-h-0 min-w-0"
        >
            {/* Scrollable content area */}
            <div className="overflow-y-auto scrollbar flex-1 p-4 mr-1 display-flex flex-col">
                {/* Header section - always shown */}
                <div className="display-flex flex-col items-start mb-3">
                    <div className="display-flex flex-row gap-2 items-end">
                        <img src="chrome://beaver/content/icons/beaver.png" style={{ width: '4rem', height: '4rem' }} />
                        <div className="text-2xl font-semibold mb-2">Welcome to Beaver</div>
                    </div>
                    <p className="text-base font-color-secondary" style={{ whiteSpace: 'pre-line' }}>
                        {getHeaderMessage()}
                    </p>
                </div>

                {/* ------------- Step 1: Library Selection & Authorization ------------- */}
                {!hasAuthorizedAccess && (
                    <AuthorizeLibraryAccess
                        selectedLibraryIds={selectedLibraryIds}
                        setSelectedLibraryIds={setSelectedLibraryIds}
                        libraryStatistics={libraryStatistics}
                        setLibraryStatistics={setLibraryStatistics}
                        disableSyncToggle={!isLibrarySynced(1)}
                        useZoteroSync={useZoteroSync}
                        handleSyncToggleChange={handleSyncToggleChange}
                        consentToShare={consentToShare}
                        handleConsentChange={handleConsentChange}
                    />
                )}

                {/* ------------- Step 2: Syncing Process ------------- */}
                {hasAuthorizedAccess && (
                    <div className="display-flex flex-col gap-4">
                        <div className="text-lg font-semibold mb-3">Step 2: Syncing Process</div>

                        <div className="display-flex flex-col gap-4">
                            {/* Syncing your library */}
                            <DatabaseSyncStatus />

                            {/* File status display */}
                            <FileStatusDisplay connectionStatus={connectionStatus}/>
                        </div>

                    </div>
                )}
            </div>

            {/* Fixed button area */}
            <div className="p-4 border-top-quinary">
                {/* Library selection button */}
                {!hasAuthorizedAccess && (
                    <div className="display-flex flex-row items-center gap-1">
                        <div className="font-color-secondary text-sm">
                            {`By continuing, you agree to our `}
                            <a 
                                className="text-link cursor-pointer" 
                                onClick={() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/terms')}
                            >
                                Terms of Service
                            </a>
                            {` and `}
                            <a 
                                className="text-link cursor-pointer" 
                                onClick={() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/privacy-policy')}
                            >
                                Privacy Policy
                            </a>.
                        </div>
                        <div className="flex-1" />
                        <Button
                            variant="solid"
                            className="fit-content"
                            rightIcon={isAuthorizing ? Spinner : ArrowRightIcon}
                            onClick={handleAuthorize}
                            disabled={!isLibrarySelectionValid || isAuthorizing}
                        >
                            Continue
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
                            disabled={(!isUploadProcessed && !fileStatusSummary.pageBalanceExhausted) || (overallSyncStatus === 'in_progress' || overallSyncStatus === 'failed') || isCompletingOnboarding}
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