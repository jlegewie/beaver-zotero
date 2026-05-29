import React, { useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { profileWithPlanAtom, dataDeletionScheduledForAtom } from "../../atoms/profile";
import { accountService } from "../../../src/services/accountService";
import { logger } from "../../../src/utils/logger";
import { OnboardingHeader, OnboardingFooter } from "./onboarding";
import { Icon, CancelIcon, TickIcon, LockIcon } from "../icons/icons";

/**
 * Beta sunset acknowledgment page
 *
 * Shown when a user on the legacy cloud-processing Beta plan is transitioned
 * to the Free plan (beta account type is being discontinued).
 */
const DowngradeAcknowledgmentPage: React.FC = () => {
    const [profileWithPlan, setProfileWithPlan] = useAtom(profileWithPlanAtom);
    const dataDeletionScheduledFor = useAtomValue(dataDeletionScheduledForAtom);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleAcknowledge = async () => {
        if (isSubmitting || !profileWithPlan) return;

        setIsSubmitting(true);

        try {
            logger(`DowngradeAcknowledgmentPage: Acknowledging downgrade`, 2);

            // Call the service to acknowledge downgrade
            await accountService.acknowledgeDowngrade();

            // Update local state
            setProfileWithPlan({
                ...profileWithPlan,
                has_authorized_free_access: true,
                pending_downgrade_ack: false,
                free_consented_at: new Date(),
            });

            logger(`DowngradeAcknowledgmentPage: Downgrade acknowledged`);

        } catch (error) {
            logger(`DowngradeAcknowledgmentPage: Error during acknowledgment: ${error}`);
        } finally {
            setIsSubmitting(false);
        }
    };

    // Calculate days until deletion. Default mirrors the 14-day grace period
    // referenced in the Terms (tier adjustments / inactivity) when no explicit
    // date is provided by the backend.
    const getDaysUntilDeletion = (): number => {
        if (!dataDeletionScheduledFor) return 14;
        const now = new Date();
        const deletionDate = new Date(dataDeletionScheduledFor);
        const diffTime = deletionDate.getTime() - now.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return Math.max(diffDays, 0);
    };

    const daysUntilDeletion = getDaysUntilDeletion();

    const getHeaderMessage = () => {
        return (
            <div className="display-flex flex-col gap-3 py-2 mt-2">
                <div className="text-lg">
                    We're discontinuing the cloud processing Beta so we can focus development on version 0.20 and beyond. Two features that previously required the beta are now included for everyone, on both free and paid plans:
                </div>
                <div className="display-flex flex-col gap-4 ml-1">
                    <div className="display-flex flex-row gap-2 items-start">
                        <Icon icon={TickIcon} className="scale-09 font-color-secondary mt-020" />
                        <span>Sentence-level citations</span>
                    </div>
                    <div className="display-flex flex-row gap-2 items-start">
                        <Icon icon={TickIcon} className="scale-09 font-color-secondary mt-020" />
                        <span>PDF annotations to add highlights and notes to your PDFs</span>
                    </div>
                </div>
                <div className="mt-2 text-lg">
                    Also included
                </div>
                <div className="display-flex flex-col gap-4 ml-1">
                    <div className="display-flex flex-row gap-2 items-start">
                        <Icon icon={TickIcon} className="scale-09 font-color-secondary mt-020" />
                        <span>Chat with your entire library</span>
                    </div>
                    <div className="display-flex flex-row gap-2 items-start">
                        <Icon icon={TickIcon} className="scale-09 font-color-secondary mt-020" />
                        <span>Reading Assistant</span>
                    </div>
                    <div className="display-flex flex-row gap-2 items-start">
                        <Icon icon={TickIcon} className="scale-09 font-color-secondary mt-020" />
                        <span>Discover New Research</span>
                    </div>
                    <div className="display-flex flex-row gap-2 items-start">
                        <Icon icon={TickIcon} className="scale-09 font-color-secondary mt-020" />
                        <span>Organize and Edit your library</span>
                    </div>
                    <div className="display-flex flex-row gap-2 items-start">
                        <Icon icon={TickIcon} className="scale-09 font-color-secondary mt-020" />
                        <span>Read, Write and Edit Your Notes</span>
                    </div>
                    <div className="display-flex flex-row gap-2 items-start">
                        <Icon icon={TickIcon} className="scale-09 font-color-secondary mt-020" />
                        <span>Limited free AI credits OR use your own API key</span>
                    </div>
                    <div className="display-flex flex-row gap-2 items-start">
                        <Icon icon={TickIcon} className="scale-09 font-color-secondary mt-020" />
                        <span>Metadata & semantic search</span>
                    </div>
                    <div className="display-flex flex-row gap-2 items-start">
                        <Icon icon={TickIcon} className="scale-09 font-color-secondary mt-020" />
                        <span>Local file processing</span>
                    </div>
                </div>
                <div className="mt-2 text-lg">
                    No longer included
                </div>
                <div className="display-flex flex-col gap-4 ml-1">
                    <div className="display-flex flex-row gap-2 items-start">
                        <Icon icon={CancelIcon} className="scale-90 font-color-secondary mt-020" />
                        <span>Full-text keyword and semantic search</span>
                    </div>
                </div>
                <div className="font-color-secondary ml-1 mt-1">
                    Full-text search will return as an optional add-on.
                </div>
            </div>
        );
    };

    const buttonLabel = isSubmitting ? "Loading..." : "Continue to Beaver";

    return (
        <div 
            id="downgrade-acknowledgment-page"
            className="display-flex flex-col flex-1 min-h-0 min-w-0"
        >
            {/* Scrollable content area */}
            <div className="overflow-y-auto scrollbar flex-1 p-4 mr-1 display-flex flex-col">
                {/* Header */}
                <OnboardingHeader message={getHeaderMessage()}/>

                {/* Main content */}
                <div className="display-flex flex-1"/>
                <div className="display-flex flex-col gap-4">
                    {/* Data deletion notice */}
                    <div className="display-flex flex-col gap-3 p-4 rounded-lg bg-senary mt-4">
                        <div className="display-flex flex-row gap-3 items-start">
                            <Icon icon={LockIcon} className="mt-020 scale-11" />
                            <div className="display-flex flex-col gap-2">
                                <div className="font-semibold">Privacy Notice</div>
                                <div className="font-color-secondary">
                                    Beaver now processes files locally on your device. Your library and PDFs are no longer synced to our servers.
                                    Chat history is stored server-side and can be exported or deleted anytime.
                                </div>
                                <div className="font-color-secondary">
                                    The copies of your files we processed during the beta will be deleted from our servers
                                    within <strong>{daysUntilDeletion} days</strong>. This does not affect your original files in Zotero.
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Footer */}
            <OnboardingFooter
                buttonLabel={buttonLabel}
                isLoading={isSubmitting}
                disabled={isSubmitting}
                onButtonClick={handleAcknowledge}
                showTerms={false}
            />
        </div>
    );
};

export default DowngradeAcknowledgmentPage;