import React, { useState, useEffect } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { overallSyncStatusAtom, syncStatusAtom, LibrarySyncStatus } from "../../atoms/sync";
import { hasAuthorizedProAccessAtom, syncLibrariesAtom } from '../../atoms/profile';
import AuthorizeLibraryAccess from "../auth/AuthorizeLibraryAccess";
import { setPref } from "../../../src/utils/prefs";
import { LibraryStatistics } from "../../../src/utils/libraries";
import { logger } from "../../../src/utils/logger";
import { accountService } from "../../../src/services/accountService";
import { DatabaseSyncStatus } from "../status/DatabaseSyncStatus";
import { profileWithPlanAtom } from "../../atoms/profile";
import { getZoteroUserIdentifier, isLibrarySynced } from "../../../src/utils/zoteroUtils";
import { userAtom } from "../../atoms/auth";
import { isLibraryValidForSync } from "../../../src/utils/sync";
import { store } from "../../store";
import SelectLibraries from "./onboarding/SelectLibraries";
import { serializeZoteroLibrary } from "../../../src/utils/zoteroSerializers";
import { ZoteroLibrary } from "../../types/zotero";
import { OnboardingHeader, OnboardingFooter } from "./onboarding";

/**
 * Pro/Beta onboarding flow with two steps:
 * 1. Library selection and authorization (with file upload consent)
 * 2. Syncing process (database sync + file processing)
 */
const ProOnboardingPage: React.FC = () => {
    // Auth state
    const [profileWithPlan, setProfileWithPlan] = useAtom(profileWithPlanAtom);
    const user = useAtomValue(userAtom);
    
    // Onboarding state
    const hasAuthorizedProAccess = useAtomValue(hasAuthorizedProAccessAtom);

    // Track selected libraries
    const [selectedLibraryIds, setSelectedLibraryIds] = useState<number[]>([1]);
    const [isLibrarySelectionValid, setIsLibrarySelectionValid] = useState<boolean>(false);
    const [validLibraryIds, setValidLibraryIds] = useState<number[]>([]);

    // Sync toggle state
    const [useZoteroSync, setUseZoteroSync] = useState<boolean>(false);
    const [consentToShare, setConsentToShare] = useState<boolean>(false);
    const [emailNotifications, setEmailNotifications] = useState<boolean>(false);

    // Library sync state
    const setSyncStatus = useSetAtom(syncStatusAtom);
    const overallSyncStatus = useAtomValue(overallSyncStatusAtom);
    
    // State for full library statistics (loaded asynchronously)
    const [libraryStatistics, setLibraryStatistics] = useState<LibraryStatistics[]>([]);

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

    const handleEmailNotificationsChange = (checked: boolean) => {
        setEmailNotifications(checked);
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
            logger(`ProOnboardingPage: Authorizing access with libraries: ${libraries.map(library => library.library_id).join(', ')}`, 2);
            await accountService.authorizeAccess(requireOnboarding, libraries, useZoteroSync, consentToShare, emailNotifications);

            // Update local state
            if (profileWithPlan) {
                const { userID, localUserKey } = getZoteroUserIdentifier();
                setProfileWithPlan({
                    ...profileWithPlan,
                    libraries: libraries,
                    has_authorized_access: true,
                    consented_at: new Date(),
                    consent_to_share: consentToShare,
                    email_notifications: emailNotifications,
                    zotero_user_id: userID || profileWithPlan.zotero_user_id,
                    zotero_local_ids: [localUserKey],
                    has_completed_onboarding: !requireOnboarding || profileWithPlan.has_completed_onboarding
                });
            }

            // Update user ID and email in prefs
            setPref("userId", user?.id ?? "");
            setPref("userEmail", user?.email ?? "");
            
        } catch (error) {
            logger(`ProOnboardingPage: Error authorizing access: ${error}`);
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

            // Show indexing complete message - users will see this while indexing continues in background
            setPref("showIndexingCompleteMessage", true);

            // Update profile atom for immediate UI feedback
            if (profileWithPlan) {
                setProfileWithPlan({
                    ...profileWithPlan,
                    has_completed_onboarding: true
                });
            }
            
        } catch (error) {
            logger(`ProOnboardingPage: Error completing onboarding: ${error}`);
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
            return "Database sync in progress. You can complete onboarding once the sync finishes.";
        } else if (overallSyncStatus === 'failed') {
            return "Database sync failed. Please retry or contact support.";
        } else if (overallSyncStatus === 'completed' || overallSyncStatus === 'partially_completed') {
            return "Database sync complete! File uploads and processing will continue in the background.";
        }
        return "";
    };

    const getHeaderMessage = () => {
        if (!hasAuthorizedProAccess) {
            // Step 1: Library Selection & Authorization
            return "Beaver syncs your Zotero data, uploads attachments, and indexes them for search and AI features. By continuing, you confirm you're authorized to upload these files and link your Zotero and Beaver account.";
        } else {
            // Step 2: Syncing Process
            return "We're syncing your Zotero library. Once the database sync completes, you can start using Beaver while file uploads and processing continue in the background.";
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
                <OnboardingHeader message={getHeaderMessage()} />

                {/* ------------- Step 1: Library Selection & Authorization ------------- */}
                {!hasAuthorizedProAccess && (
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
                        emailNotifications={emailNotifications}
                        handleEmailNotificationsChange={handleEmailNotificationsChange}
                    />
                )}

                {/* ------------- Step 2: Syncing Process ------------- */}
                {hasAuthorizedProAccess && (
                    <div className="display-flex flex-col gap-4">
                        <div className="text-lg font-semibold mb-3">Step 2: Database Sync</div>

                        <div className="display-flex flex-col gap-4">
                            {/* Syncing your library */}
                            <DatabaseSyncStatus />
                        </div>

                    </div>
                )}
            </div>

            {/* Fixed footer area */}
            {!hasAuthorizedProAccess ? (
                <OnboardingFooter
                    buttonLabel="Continue"
                    isLoading={isAuthorizing}
                    disabled={!isLibrarySelectionValid}
                    onButtonClick={handleAuthorize}
                    showTerms={true}
                />
            ) : (
                <OnboardingFooter
                    message={getFooterMessage()}
                    buttonLabel="Complete"
                    isLoading={isCompletingOnboarding}
                    disabled={overallSyncStatus === 'in_progress' || overallSyncStatus === 'failed'}
                    onButtonClick={handleCompleteOnboarding}
                />
            )}
        </div>
    );
};

export default ProOnboardingPage;