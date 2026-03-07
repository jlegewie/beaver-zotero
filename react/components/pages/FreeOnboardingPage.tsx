import React, { useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { profileWithPlanAtom } from "../../atoms/profile";
import { userAtom } from "../../atoms/auth";
import { accountService } from "../../../src/services/accountService";
import { logger } from "../../../src/utils/logger";
import { setPref } from "../../../src/utils/prefs";
import { getZoteroUserIdentifier } from "../../../src/utils/zoteroUtils";
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
     * Note: Libraries are NOT sent to backend per privacy policy - Free users don't sync data.
     */
    const handleGetStarted = async () => {
        if (isAuthorizing || !profileWithPlan) return;

        setIsAuthorizing(true);

        try {
            logger(`FreeOnboardingPage: Authorizing free access (libraries not synced per privacy policy)`, 2);

            // Authorize free access
            await accountService.authorizeFreeAccess(
                consentToShare,
                emailNotifications
            );

            // Update local profile state
            // Note: Free users set has_authorized_free_access, NOT has_authorized_access
            // Also, free users do NOT set has_completed_onboarding (they skip full onboarding)
            const { userID, localUserKey } = getZoteroUserIdentifier();
            setProfileWithPlan({
                ...profileWithPlan,
                libraries: [],
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
            <div className="display-flex flex-col gap-2 py-2 mt-3">
                <div className="text-lg font-semibold">Your AI research assistant in Zotero</div>
                <div>Search across your library, read papers faster, compare findings, and discover relevant new research.</div>
            </div>
        );
    };

    // Determine button state
    const buttonLabel = isAuthorizing ? "Setting up..." : "Open Beaver";
    const isButtonDisabled = isAuthorizing || !agreedToTerms;

    return (
        <div 
            id="onboarding-page"
            className="display-flex flex-col flex-1 min-h-0 min-w-0"
        >
            {/* Scrollable content area */}
            <div className="overflow-y-auto scrollbar flex-1 p-4 mr-1 display-flex flex-col">
                {/* Header */}
                <OnboardingHeader message={getHeaderMessage()}/>

                {/* Main content */}
                <div className="display-flex flex-col gap-4 flex-1">

                    {/* Spacer with example prompts */}
                    <div className="flex-1 display-flex flex-col mt-2">
                        <ExamplePrompts />
                    </div>

                    <div className="display-flex flex-row gap-3 items-start bg-quinary p-2 rounded-lg">
                        <Icon icon={LockIcon} className="mt-020 scale-11" />
                        {/* Privacy: We never store your library data. Metadata is processed temporarily server-side for local search only.
                        Chat history is saved to your account and is fully deletable. */}
                        <span>
                            Privacy: We do not permanently store your Zotero library or PDF files.
                            Some metadata and chat content are processed on our servers to power Beaver features.
                            <a
                                className="text-link cursor-pointer ml-1"
                                href={process.env.WEBAPP_BASE_URL + '/docs/privacy'}
                                onClick={() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/docs/privacy')}
                                target='_blank'
                                rel='noopener noreferrer'
                            >
                                Learn more
                            </a>
                        </span>
                        {/* Limited metadata may be processed temporarily to power search.
                        Chat history is saved to your account and can be deleted at any time. */}
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

