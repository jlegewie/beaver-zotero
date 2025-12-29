import React, { useState, useEffect } from "react";
import { useAtom, useAtomValue } from "jotai";
import { profileWithPlanAtom } from "../../atoms/profile";
import { userAtom } from "../../atoms/auth";
import { embeddingIndexStateAtom, isEmbeddingIndexingAtom } from "../../atoms/embeddingIndex";
import { accountService } from "../../../src/services/accountService";
import { logger } from "../../../src/utils/logger";
import { setPref } from "../../../src/utils/prefs";
import { getZoteroUserIdentifier } from "../../../src/utils/zoteroUtils";
import { serializeZoteroLibrary } from "../../../src/utils/zoteroSerializers";
import { OnboardingHeader, OnboardingFooter, EmbeddingIndexProgress, ExamplePrompts } from "./onboarding";
import ConsentToggle from "../preferences/ConsentToggle";
import { ZapIcon } from "../icons/icons";

/**
 * Free onboarding flow - single screen experience
 * 
 * Features:
 * - Welcome message and description
 * - Speed note (indexing takes less than a minute)
 * - Upgrade card with Pro benefits
 * - Telemetry consent toggle
 * - Local embedding indexing (no file upload)
 */
const FreeOnboardingPage: React.FC = () => {
    // Profile state
    const [profileWithPlan, setProfileWithPlan] = useAtom(profileWithPlanAtom);
    const user = useAtomValue(userAtom);

    // Embedding index state
    const embeddingState = useAtomValue(embeddingIndexStateAtom);
    const isIndexing = useAtomValue(isEmbeddingIndexingAtom);

    // Local state
    const [consentToShare, setConsentToShare] = useState<boolean>(false);
    const [isAuthorizing, setIsAuthorizing] = useState(false);
    const [hasStarted, setHasStarted] = useState(false);

    // Check if indexing is complete
    const isIndexingComplete = embeddingState.status === 'idle' && embeddingState.phase === 'incremental';

    // Auto-complete onboarding when indexing finishes
    useEffect(() => {
        if (hasStarted && isIndexingComplete && profileWithPlan?.has_authorized_access) {
            handleCompleteOnboarding();
        }
    }, [hasStarted, isIndexingComplete, profileWithPlan?.has_authorized_access]);

    const handleConsentChange = (checked: boolean) => {
        setConsentToShare(checked);
    };

    /**
     * Handle the "Get Started" button click
     * Authorizes access and the embedding indexing will be triggered by the useEmbeddingIndex hook
     */
    const handleGetStarted = async () => {
        if (isAuthorizing || !profileWithPlan) return;

        setIsAuthorizing(true);
        setHasStarted(true);

        try {
            // Get all libraries (free users sync all libraries metadata-only)
            const allLibraries = Zotero.Libraries.getAll();
            const libraries = allLibraries
                .map(library => serializeZoteroLibrary(library))
                .filter(library => library !== null);

            logger(`FreeOnboardingPage: Authorizing access with ${libraries.length} libraries`, 2);

            // Authorize access - no file sync for free plan
            await accountService.authorizeAccess(
                false, // requireOnboarding = false (fast indexing, will auto-complete)
                libraries,
                false, // useZoteroSync = false (no database sync for free)
                consentToShare
            );

            // Update local profile state
            const { userID, localUserKey } = getZoteroUserIdentifier();
            setProfileWithPlan({
                ...profileWithPlan,
                libraries: libraries,
                has_authorized_access: true,
                consented_at: new Date(),
                zotero_user_id: userID || profileWithPlan.zotero_user_id,
                zotero_local_ids: [localUserKey],
            });

            // Update user ID and email in prefs
            setPref("userId", user?.id ?? "");
            setPref("userEmail", user?.email ?? "");

        } catch (error) {
            logger(`FreeOnboardingPage: Error during authorization: ${error}`);
            setHasStarted(false);
        } finally {
            setIsAuthorizing(false);
        }
    };

    /**
     * Complete onboarding after indexing finishes
     */
    const handleCompleteOnboarding = async () => {
        if (!profileWithPlan) return;

        try {
            logger("FreeOnboardingPage: Completing onboarding", 2);
            await accountService.completeOnboarding('completed');

            // Update local profile state
            setProfileWithPlan({
                ...profileWithPlan,
                has_completed_onboarding: true
            });

        } catch (error) {
            logger(`FreeOnboardingPage: Error completing onboarding: ${error}`);
        }
    };

    const getHeaderMessage = () => {
        return "Your AI research assistant that lives in Zotero. Chat with your entire library, discover new research and much more.";
    };

    // Determine button state
    const isLoading = isAuthorizing || (hasStarted && isIndexing);
    const buttonLabel = hasStarted ? "Indexing..." : "Get Started";

    return (
        <div 
            id="onboarding-page"
            className="display-flex flex-col flex-1 min-h-0 min-w-0"
        >
            {/* Scrollable content area */}
            <div className="overflow-y-auto scrollbar flex-1 p-4 mr-1 display-flex flex-col">
                {/* Header */}
                <OnboardingHeader message={getHeaderMessage()} />

                {/* Main content */}
                <div className="display-flex flex-col gap-4 flex-1">

                    {/* Speed note - shown before starting */}
                    {/* {!hasStarted && (
                        <div className="display-flex flex-row gap-2 items-center p-3 rounded-md bg-quinary">
                            <ZapIcon size={16} className="font-color-secondary" />
                            <span className="font-color-secondary">Indexing takes less than a minute</span>
                        </div>
                    )} */}

                    {/* Indexing progress - shown after starting */}
                    {hasStarted && (
                        <EmbeddingIndexProgress />
                    )}

                    {/* Upgrade card */}
                    {/* <UpgradeCard /> */}

                    {/* Spacer with example prompts */}
                    <div className="flex-1 display-flex flex-col mt-2">
                        <ExamplePrompts />
                    </div>

                    {/* Consent toggle */}
                    <div className="display-flex flex-col gap-4">
                        <div className="h-1 border-top-quinary" />
                        <ConsentToggle
                            checked={consentToShare}
                            onChange={handleConsentChange}
                        />
                    </div>
                </div>
            </div>

            {/* Footer */}
            <OnboardingFooter
                buttonLabel={buttonLabel}
                isLoading={isLoading}
                disabled={hasStarted}
                onButtonClick={handleGetStarted}
                showTerms={true}
            />
        </div>
    );
};

export default FreeOnboardingPage;

