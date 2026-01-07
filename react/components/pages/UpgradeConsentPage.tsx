import React, { useState } from "react";
import { useAtom } from "jotai";
import { profileWithPlanAtom } from "../../atoms/profile";
import { accountService } from "../../../src/services/accountService";
import { logger } from "../../../src/utils/logger";
import { OnboardingHeader, OnboardingFooter } from "./onboarding";
import { LockIcon, Icon, TickIcon } from "../icons/icons";
import PreferenceToggle from "../preferences/PreferenceToggle";

/**
 * Upgrade consent page for Free → Pro transitions
 * 
 * Shows when a user upgrades from Free to Pro plan.
 * Requires explicit consent for data sync since Pro plan involves:
 * - Syncing Zotero database to backend servers
 * - Uploading PDF files for processing
 * 
 * After consent, user is routed to ProOnboardingPage Step 2 (library selection).
 */
const UpgradeConsentPage: React.FC = () => {
    const [profileWithPlan, setProfileWithPlan] = useAtom(profileWithPlanAtom);
    const [agreedToSync, setAgreedToSync] = useState<boolean>(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleConsentSubmit = async () => {
        if (isSubmitting || !profileWithPlan || !agreedToSync) return;

        setIsSubmitting(true);

        try {
            logger(`UpgradeConsentPage: Completing upgrade consent`, 2);

            // Call the service to complete upgrade consent
            await accountService.completeUpgradeConsent();

            // Update local state
            setProfileWithPlan({
                ...profileWithPlan,
                has_authorized_access: true,
                pending_upgrade_consent: false,
                consented_at: new Date(),
            });

            logger(`UpgradeConsentPage: Upgrade consent completed, routing to library selection`);

        } catch (error) {
            logger(`UpgradeConsentPage: Error during upgrade consent: ${error}`);
        } finally {
            setIsSubmitting(false);
        }
    };

    const planDisplayName = profileWithPlan?.plan?.display_name || "Pro";

    const getHeaderMessage = () => {
        return (
            <div className="display-flex flex-col gap-4 py-2 mt-2">
                <div>
                    You're upgrading from the Free plan. Here's what's new:
                </div>
                <div className="display-flex flex-col gap-2 ml-1">
                    <div className="display-flex flex-row gap-2 items-center">
                        <Icon icon={TickIcon} className="scale-09 font-color-success" />
                        <span>Full-text search across all your PDFs</span>
                    </div>
                    <div className="display-flex flex-row gap-2 items-start">
                        <Icon icon={TickIcon} className="scale-90 font-color-secondary mt-020" />
                        <span>Server-side processing for improved search and document understanding</span>
                    </div>
                    <div className="display-flex flex-row gap-2 items-center">
                        <Icon icon={TickIcon} className="scale-09 font-color-success" />
                        <span>Precise sentence-level citations</span>
                    </div>
                </div>
            </div>
        );
    };

    const buttonLabel = isSubmitting ? "Setting up..." : "Continue";
    const isButtonDisabled = isSubmitting || !agreedToSync;

    return (
        <div 
            id="upgrade-consent-page"
            className="display-flex flex-col flex-1 min-h-0 min-w-0"
        >
            {/* Scrollable content area */}
            <div className="overflow-y-auto scrollbar flex-1 p-4 mr-1 display-flex flex-col">
                {/* Header */}
                <OnboardingHeader message={getHeaderMessage()} tag="Beta" />

                {/* Main content */}
                <div className="display-flex flex-1"/>
                <div className="display-flex flex-col gap-4 flex-1">
                    {/* Data sync notice */}
                    <div className="display-flex flex-col gap-3 p-4 rounded-lg bg-senary mt-4">
                        <div className="display-flex flex-row gap-3 items-start">
                            <Icon icon={LockIcon} className="mt-020 scale-11" />
                            <div className="display-flex flex-col gap-2">
                                <div className="font-semibold">Beta Plan Privacy Notice</div>
                                <div className="font-color-secondary">
                                    Beaver Beta syncs your Zotero library and uploads PDFs/attachments for indexing and search.
                                    By continuing, you confirm you're authorized to upload these files and connect Zotero to your Beaver account.
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Spacer */}
                    <div className="flex-1" />

                    {/* Consent toggle */}
                    <div className="display-flex flex-col gap-4">
                        <div className="h-1 border-top-quinary" />
                        
                        {/* <PreferenceToggle
                            checked={agreedToSync}
                            onChange={setAgreedToSync}
                            disabled={isSubmitting}
                            title="I agree to sync my data with Beaver servers"
                            subtitle="(required)"
                            className="font-medium"
                            description="By continuing, you agree to our <a href='https://www.beaverapp.ai/terms' target='_blank' rel='noopener noreferrer'>Terms of Service</a> and <a href='https://www.beaverapp.ai/privacy-policy' target='_blank' rel='noopener noreferrer'>Privacy Policy</a>"
                        /> */}
                        <PreferenceToggle
                            checked={agreedToSync}
                            onChange={setAgreedToSync}
                            disabled={isSubmitting}
                            title="Terms and Privacy Policy"
                            subtitle="(required)"
                            className="font-medium"
                            description="I agree to the <a href='https://www.beaverapp.ai/terms' target='_blank' rel='noopener noreferrer'>Terms of Service</a> and <a href='https://www.beaverapp.ai/privacy-policy' target='_blank' rel='noopener noreferrer'>Privacy Policy</a>"
                        />
                    </div>
                </div>
            </div>

            {/* Footer */}
            <OnboardingFooter
                buttonLabel={buttonLabel}
                isLoading={isSubmitting}
                disabled={isButtonDisabled}
                onButtonClick={handleConsentSubmit}
                showTerms={false}
            />
        </div>
    );
};

export default UpgradeConsentPage;


