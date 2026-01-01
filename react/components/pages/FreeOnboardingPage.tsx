import React, { useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { profileWithPlanAtom } from "../../atoms/profile";
import { userAtom } from "../../atoms/auth";
import { accountService } from "../../../src/services/accountService";
import { logger } from "../../../src/utils/logger";
import { setPref } from "../../../src/utils/prefs";
import { getZoteroUserIdentifier } from "../../../src/utils/zoteroUtils";
import { serializeZoteroLibrary } from "../../../src/utils/zoteroSerializers";
import { OnboardingHeader, OnboardingFooter, ExamplePrompts } from "./onboarding";
import { LockIcon, Icon } from "../icons/icons";
import ConsentToggles from "./onboarding/ConsentToggles";

/**
 * Free onboarding flow - single screen experience
 * 
 * Features:
 * - Welcome message and privacy notice
 * - Example prompts to show what users can do
 * - Terms agreement and consent toggles
 * - Authorizes free access (embedding indexing happens automatically after)
 */
const FreeOnboardingPage: React.FC = () => {
    // Profile state
    const [profileWithPlan, setProfileWithPlan] = useAtom(profileWithPlanAtom);
    const user = useAtomValue(userAtom);

    // Local state
    const [agreedToTerms, setAgreedToTerms] = useState<boolean>(false);
    const [consentToShare, setConsentToShare] = useState<boolean>(
        profileWithPlan?.consent_to_share || false
    );
    const [emailNotifications, setEmailNotifications] = useState<boolean>(
        profileWithPlan?.email_notifications || false
    );
    const [isAuthorizing, setIsAuthorizing] = useState(false);

    const handleConsentChange = (checked: boolean) => {
        setConsentToShare(checked);
    };

    const handleEmailNotificationsChange = (checked: boolean) => {
        setEmailNotifications(checked);
    };

    const handleTermsChange = (checked: boolean) => {
        setAgreedToTerms(checked);
    };

    /**
     * Handle the "Get Started" button click
     * Authorizes free access and completes onboarding.
     * Note: Embedding indexing will be triggered automatically by the useEmbeddingIndex hook.
     */
    const handleGetStarted = async () => {
        if (isAuthorizing || !profileWithPlan) return;

        setIsAuthorizing(true);

        try {
            // Get all libraries (free users sync all libraries metadata-only)
            const allLibraries = Zotero.Libraries.getAll();
            const libraries = allLibraries
                .map(library => serializeZoteroLibrary(library))
                .filter(library => library !== null);

            logger(`FreeOnboardingPage: Authorizing free access with ${libraries.length} libraries`, 2);

            // Authorize free access (uses new /authorize-free endpoint)
            await accountService.authorizeFreeAccess(
                libraries,
                consentToShare,
                emailNotifications
            );

            // Update local profile state
            // Note: Free users set has_authorized_free_access, NOT has_authorized_access
            // Also, free users do NOT set has_completed_onboarding (they skip full onboarding)
            const { userID, localUserKey } = getZoteroUserIdentifier();
            setProfileWithPlan({
                ...profileWithPlan,
                libraries: libraries,
                has_authorized_free_access: true,
                free_consented_at: new Date(),
                consent_to_share: consentToShare,
                email_notifications: emailNotifications,
                zotero_user_id: userID || profileWithPlan.zotero_user_id,
                zotero_local_ids: [localUserKey],
                // Note: has_completed_onboarding is NOT set for free users
            });

            // Update user ID and email in prefs
            setPref("userId", user?.id ?? "");
            setPref("userEmail", user?.email ?? "");

        } catch (error) {
            logger(`FreeOnboardingPage: Error during free authorization: ${error}`);
        } finally {
            setIsAuthorizing(false);
        }
    };

    const getHeaderMessage = () => {
        return (
            <div className="display-flex flex-col gap-4 py-2 mt-2">
                <div>AI research assistant that lives in Zotero. Chat with your entire library, discover new research and much more.</div>
                <div className="display-flex flex-row gap-3 items-start">
                    <Icon icon={LockIcon} className="mt-020 scale-11" />
                    {/* <span className="font-color-secondary">Privacy Notice:</span> */}
                    {/* Your Zotero library stays local. Chats stored securely and deletable anytime. */}
                    {/* Privacy-first: Your library data remains local and is never stored on our servers. Metadata is processed temporarily for indexing only.
                    Chat history is saved securely to your account and is fully deletable at any time. */}
                    Privacy-first: We never store your library data. Metadata is processed temporarily server-side for local indexing only.
                    Chat history is saved to your account and is fully deletable.
                </div>
            </div>
        );
    };

    // Determine button state
    const buttonLabel = isAuthorizing ? "Setting up..." : "Get Started";
    const isButtonDisabled = isAuthorizing || !agreedToTerms;

    return (
        <div 
            id="onboarding-page"
            className="display-flex flex-col flex-1 min-h-0 min-w-0"
        >
            {/* Scrollable content area */}
            <div className="overflow-y-auto scrollbar flex-1 p-4 mr-1 display-flex flex-col">
                {/* Header */}
                <OnboardingHeader message={getHeaderMessage()} tag="Free"/>

                {/* Main content */}
                <div className="display-flex flex-col gap-4 flex-1">

                    {/* Spacer with example prompts */}
                    <div className="flex-1 display-flex flex-col mt-2">
                        <ExamplePrompts />
                    </div>

                    {/* Consent toggle */}
                    <ConsentToggles
                        agreedToTerms={agreedToTerms}
                        handleTermsChange={handleTermsChange}
                        disabled={isAuthorizing}
                        consentToShare={consentToShare}
                        handleConsentChange={handleConsentChange}
                        emailNotifications={emailNotifications}
                        handleEmailNotificationsChange={handleEmailNotificationsChange}
                    />
                </div>
            </div>

            {/* Footer */}
            <OnboardingFooter
                buttonLabel={buttonLabel}
                isLoading={isAuthorizing}
                disabled={isButtonDisabled}
                onButtonClick={handleGetStarted}
                showTerms={false}
            />
        </div>
    );
};

export default FreeOnboardingPage;

