import React, { useState, useEffect, useMemo } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { overallSyncStatusAtom, syncStatusAtom, LibrarySyncStatus } from "../../atoms/sync";
import { hasAuthorizedProAccessAtom, syncLibrariesAtom } from '../../atoms/profile';
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
import { OnboardingHeader, OnboardingFooter, ExamplePrompts } from "./onboarding";
import ConsentToggles from "./onboarding/ConsentToggles";
import FileStatusDisplay from "../status/FileStatusDisplay";
import { LockIcon, Icon, AlertIcon, InformationCircleIcon, ArrowRightIcon, ArrowDownIcon } from "../icons/icons";
import ZoteroSyncToggle from "../preferences/SyncToggle";
import { useFileStatus } from "../../hooks/useFileStatus";
import FileStatusButton from "../ui/buttons/FileStatusButton";
import Button from "../ui/Button";
import FileStatusIcons from "../ui/FileStatusIcons";

/**
 * Pro/Beta onboarding flow with two steps:
 * 1. Consent page (similar to FreeOnboardingPage)
 * 2. Library selection and syncing process
 */
const ProOnboardingPage: React.FC = () => {
    // Auth state
    const [profileWithPlan, setProfileWithPlan] = useAtom(profileWithPlanAtom);
    const user = useAtomValue(userAtom);
    
    // Onboarding state
    const hasAuthorizedProAccess = useAtomValue(hasAuthorizedProAccessAtom);

    // Step 1: Consent state
    const [agreedToTerms, setAgreedToTerms] = useState<boolean>(false);
    const [consentToShare, setConsentToShare] = useState<boolean>(false);
    const [emailNotifications, setEmailNotifications] = useState<boolean>(false);
    const [isSubmittingConsent, setIsSubmittingConsent] = useState(false);

    // Step 2: Library selection state
    const [selectedLibraryIds, setSelectedLibraryIds] = useState<number[]>([1]);
    const [validLibraryIds, setValidLibraryIds] = useState<number[]>([]);
    const [libraryStatistics, setLibraryStatistics] = useState<LibraryStatistics[]>([]);
    const [useZoteroSync, setUseZoteroSync] = useState<boolean>(false);
    const [isStartingSync, setIsStartingSync] = useState(false);
    const [showFileStatusDetails, setShowFileStatusDetails] = useState(false);

    // Has sync started
    const hasSyncStarted = useMemo(() => (profileWithPlan?.libraries && profileWithPlan?.libraries?.length > 0) || false, [profileWithPlan]);

    // Connection status
    const { connectionStatus } = useFileStatus();

    // Library sync state
    const setSyncStatus = useSetAtom(syncStatusAtom);
    const overallSyncStatus = useAtomValue(overallSyncStatusAtom);
    
    // Loading state for completing onboarding
    const [isCompletingOnboarding, setIsCompletingOnboarding] = useState(false);

    // Initialize sync toggle state
    useEffect(() => {
        const syncEnabled = isLibrarySynced(1);
        setUseZoteroSync(syncEnabled);
    }, []);

    // Update valid library IDs when selection or sync toggle changes
    useEffect(() => {
        const validIds = selectedLibraryIds.filter(id => {
            const library = Zotero.Libraries.get(id);
            return isLibraryValidForSync(library, useZoteroSync);
        });
        setValidLibraryIds(validIds);
    }, [selectedLibraryIds, useZoteroSync]);

    const isLibrarySelectionValid = useMemo(() => validLibraryIds.length > 0, [validLibraryIds]);

    // Consent handlers
    const handleTermsChange = (checked: boolean) => {
        setAgreedToTerms(checked);
    };

    const handleConsentChange = (checked: boolean) => {
        setConsentToShare(checked);
    };

    const handleEmailNotificationsChange = (checked: boolean) => {
        setEmailNotifications(checked);
    };

    // Sync toggle handler
    const handleSyncToggleChange = (checked: boolean) => {
        setUseZoteroSync(checked);
    };

    /**
     * Handle Step 1: Consent submission
     * Authorizes access and moves to Step 2
     */
    const handleConsentSubmit = async () => {
        if (isSubmittingConsent || !profileWithPlan) return;

        setIsSubmittingConsent(true);

        try {
            // Get all libraries initially (we'll refine selection in step 2)
            // const allLibraries = Zotero.Libraries.getAll();
            // const libraries = allLibraries
            //     .map(library => serializeZoteroLibrary(library))
            //     .filter(library => library !== null);

            logger(`ProOnboardingPage: Authorizing access (consent step)`, 2);

            // Call the service to authorize access (without starting sync yet)
            await accountService.authorizeAccess(
                true,
                [],  // No library selection yet
                useZoteroSync,
                consentToShare,
                emailNotifications
            );

            // Update local state
            const { userID, localUserKey } = getZoteroUserIdentifier();
            setProfileWithPlan({
                ...profileWithPlan,
                libraries: [],
                has_authorized_access: true,
                consented_at: new Date(),
                consent_to_share: consentToShare,
                email_notifications: emailNotifications,
                zotero_user_id: userID || profileWithPlan.zotero_user_id,
                zotero_local_ids: [localUserKey],
            });

            // Update user ID and email in prefs
            setPref("userId", user?.id ?? "");
            setPref("userEmail", user?.email ?? "");

        } catch (error) {
            logger(`ProOnboardingPage: Error during consent authorization: ${error}`);
        } finally {
            setIsSubmittingConsent(false);
        }
    };

    /**
     * Handle Step 2a: Start library sync
     */
    const handleStartSync = async () => {
        if (validLibraryIds.length === 0 || isStartingSync) return;
        if (!profileWithPlan) return;
        
        setIsStartingSync(true);
        try {
            // Create sync status for selected libraries
            const selectedLibraries = Object.fromEntries(
                validLibraryIds.map(id => {
                    const library = libraryStatistics.find(lib => lib.libraryID === id);
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

            // Update profile with selected libraries
            const libraries = validLibraryIds
                .map(id => {
                    const library = Zotero.Libraries.get(id);
                    if (!library) return null;
                    return serializeZoteroLibrary(library);
                })
                .filter(library => library !== null);

            logger(`ProOnboardingPage: Starting sync with libraries: ${libraries.map(lib => lib.library_id).join(', ')}`, 2);

            // Update backend with selected libraries
            await accountService.updateSyncLibraries(libraries);

            // Update local profile
            setProfileWithPlan({
                ...profileWithPlan,
                libraries: libraries,
            });

        } catch (error) {
            logger(`ProOnboardingPage: Error starting sync: ${error}`);
        } finally {
            setIsStartingSync(false);
        }
    };

    /**
     * Handle Step 2b: Complete onboarding
     */
    const handleCompleteOnboarding = async () => {
        if (isCompletingOnboarding) return;
        if (!profileWithPlan) return;
                
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
            // Get updated libraries if partially completed
            let updatedLibraries = undefined;
            if (overallSyncStatus === 'partially_completed') {
                const syncStatus = store.get(syncStatusAtom);
                const completedLibraryIds = Object.values(syncStatus as Record<number, LibrarySyncStatus>)
                    .filter((library: LibrarySyncStatus) => library.status === 'completed')
                    .map(library => library.libraryID);
                updatedLibraries = (store.get(syncLibrariesAtom) as ZoteroLibrary[])
                    .filter((library: ZoteroLibrary) => completedLibraryIds.includes(library.library_id));
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

            // Show indexing complete message
            setPref("showIndexingCompleteMessage", true);

            // Update profile atom for immediate UI feedback
            setProfileWithPlan({
                ...profileWithPlan,
                has_completed_onboarding: true
            });
            
        } catch (error) {
            logger(`ProOnboardingPage: Error completing onboarding: ${error}`);
            // Revert optimistic update on error
            setProfileWithPlan({
                ...profileWithPlan,
                has_completed_onboarding: false
            });
        } finally {
            setIsCompletingOnboarding(false);
        }
    };

    // Footer message for Step 2
    const getStep2FooterMessage = () => {
        if (!hasSyncStarted) {
            return "";
        }
        if (overallSyncStatus === 'in_progress') {
            return "Database sync in progress. You can complete onboarding once the sync finishes.";
        } else if (overallSyncStatus === 'failed') {
            return "Database sync failed. Please retry or contact support.";
        } else if (overallSyncStatus === 'completed' || overallSyncStatus === 'partially_completed') {
            // return "Sync complete! File uploads and processing will continue in the background.";
            return "";
        }
        return "";
    };

    // Header content for Step 1 (Consent)
    const getStep1HeaderMessage = () => {
        return (
            <div className="display-flex flex-col gap-4 py-2 mt-2">
                <div>AI research assistant that lives in Zotero. Chat with your entire library, discover new research and much more.</div>
                <div className="display-flex flex-row gap-3 items-start">
                    <Icon icon={LockIcon} className="mt-020 scale-11" />
                    Beaver syncs your Zotero data and uploads attachments for indexing.
                    By continuing, you confirm you're authorized to upload these files and link your Zotero and Beaver account.
                </div>
            </div>
        );
    };

    // Header content for Step 2 (Library Selection & Sync)
    const getStep2HeaderMessage = () => {
        return "Select the libraries you want to sync with Beaver. Only synced libraries will be searched by Beaver. Once you confirm, we'll start syncing your database.";
    };
    
    // ===================== STEP 1: CONSENT =====================
    if (!hasAuthorizedProAccess) {
        return (
            <div 
                id="onboarding-page"
                className="display-flex flex-col flex-1 min-h-0 min-w-0"
            >
                {/* Scrollable content area */}
                <div className="overflow-y-auto scrollbar flex-1 p-4 mr-1 display-flex flex-col">
                    {/* Header */}
                    <OnboardingHeader message={getStep1HeaderMessage()} />

                    {/* Main content */}
                    <div className="display-flex flex-col gap-4 flex-1">
                        {/* Spacer with example prompts */}
                        <div className="flex-1 display-flex flex-col mt-2">
                            <ExamplePrompts />
                        </div>

                        {/* Consent toggles */}
                        <ConsentToggles
                            agreedToTerms={agreedToTerms}
                            handleTermsChange={handleTermsChange}
                            disabled={isSubmittingConsent}
                            consentToShare={consentToShare}
                            handleConsentChange={handleConsentChange}
                            emailNotifications={emailNotifications}
                            handleEmailNotificationsChange={handleEmailNotificationsChange}
                        />
                    </div>
                </div>

                {/* Footer */}
                <OnboardingFooter
                    buttonLabel="Continue"
                    isLoading={isSubmittingConsent}
                    disabled={!agreedToTerms || isSubmittingConsent}
                    onButtonClick={handleConsentSubmit}
                    showTerms={false}
                />
            </div>
        );
    }

    // ===================== STEP 2: LIBRARY SELECTION & SYNC =====================
    return (
        <div 
            id="onboarding-page"
            className="display-flex flex-col flex-1 min-h-0 min-w-0"
        >
            <div className="overflow-y-auto scrollbar flex-1 p-4 mr-1 display-flex flex-col">
                {/* Header section */}
                <OnboardingHeader message={getStep2HeaderMessage()} />

                {/* Library Selection */}
                {!hasSyncStarted ? (
                    <div className="display-flex flex-col gap-4 flex-1">
                        <SelectLibraries
                            selectedLibraryIds={selectedLibraryIds}
                            setSelectedLibraryIds={setSelectedLibraryIds}
                            libraryStatistics={libraryStatistics}
                            setLibraryStatistics={setLibraryStatistics}
                            useZoteroSync={useZoteroSync}
                        />

                        {/* Beta Account */}
                        {!hasSyncStarted && profileWithPlan?.plan.name === 'beta' && (
                            <div className="display-flex flex-row gap-1 items-start">
                                <Icon icon={AlertIcon} className="font-color-secondary scale-11  mt-020" />
                                <div className="font-color-secondary text-sm px-2">
                                    Beta accounts are limited to 125,000 pages total, with PDFs up to 500 pages (50MB) per file. If you have large libraries, start by selecting just one or two smaller ones.
                                </div>
                            </div>
                        )}

                        {/* Sync Toggle */}
                        <div className="flex-1" />
                        {!hasSyncStarted && (
                            <div className="display-flex flex-col gap-4">
                                <div className="h-1 border-top-quinary" />
                                <ZoteroSyncToggle 
                                    checked={useZoteroSync}
                                    onChange={handleSyncToggleChange}
                                    disabled={!isLibrarySynced(1)}
                                />
                            </div>
                        )}
                    </div>
                ) : (
                    // Database Sync Status - shown after sync starts
                    <div className="display-flex flex-col gap-4 flex-1">
                        <div className="text-lg font-semibold">Step 2: Syncing Database</div>

                        {/* Syncing your library */}
                        <DatabaseSyncStatus />

                        {/* Library synced complete */}
                        {!(overallSyncStatus === 'in_progress' || overallSyncStatus === 'failed') && (
                            <div className="font-color-secondary display-flex flex-row gap-3 items-start mt-2">
                                <Icon icon={InformationCircleIcon} className="scale-11 mt-020" />
                                <div className="items-start display-flex flex-col gap-2">
                                    <div>Completed Syncing Zotero Library</div>
                                    <div className="text-base">
                                        You can now start using Beaver. Features will be limited until file uploads and processing complete in the background.
                                    </div>

                                    {/* File Processing Status */}
                                    {/* <div className="display-flex flex-row gap-1 mt-1">
                                        <div>
                                            File Status
                                        </div>
                                        <div className="flex-1" />
                                        <FileStatusIcons textClassName="text-base" iconScale="scale-100" />
                                    </div> */}
                                </div>
                            </div>
                        )}

                        {/* File status display */}
                        {/* <FileStatusDisplay connectionStatus={connectionStatus}/> */}
                    </div>
                )}
            </div>

            {/* Fixed footer area */}
            {!hasSyncStarted ? (
                // Before sync starts: "Start Sync" button
                <OnboardingFooter
                    buttonLabel="Start Sync"
                    isLoading={isStartingSync}
                    disabled={!isLibrarySelectionValid || isStartingSync}
                    onButtonClick={handleStartSync}
                    showTerms={false}
                />
            ) : (
                // After sync starts: Show status message and "Complete" button
                <OnboardingFooter
                    message={getStep2FooterMessage()}
                    buttonLabel="Complete"
                    isLoading={isCompletingOnboarding || overallSyncStatus === 'in_progress'}
                    disabled={overallSyncStatus === 'in_progress' || overallSyncStatus === 'failed'}
                    onButtonClick={handleCompleteOnboarding}
                />
            )}
        </div>
    );
};

export default ProOnboardingPage;
