import React, { useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { profileWithPlanAtom, dataDeletionScheduledForAtom } from "../../atoms/profile";
import { accountService } from "../../../src/services/accountService";
import { logger } from "../../../src/utils/logger";
import { OnboardingHeader, OnboardingFooter } from "./onboarding";
import { Icon, InformationCircleIcon, AlertCircleIcon, CancelCircleIcon } from "../icons/icons";

/**
 * Downgrade acknowledgment page for Pro → Free transitions
 * 
 * Shows when a user is downgraded from Pro to Free plan.
 * Informs user about:
 * - Features no longer available
 * - Data deletion timeline (14 days grace period)
 * 
 * No consent required, just acknowledgment.
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

    // Calculate days until deletion
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
            <div className="display-flex flex-col gap-4 py-2 mt-2">
                <div>
                    You're now on the Free plan. Here's what's different:
                </div>
                <div className="display-flex flex-col gap-2 ml-1">
                    <div className="display-flex flex-row gap-2 items-center">
                        <Icon icon={CancelCircleIcon} className="scale-09 font-color-secondary" />
                        <span>Full-text PDF search is no longer available</span>
                    </div>
                    <div className="display-flex flex-row gap-2 items-center">
                        <Icon icon={CancelCircleIcon} className="scale-09 font-color-secondary" />
                        <span>Server-side indexing is disabled</span>
                    </div>
                    <div className="display-flex flex-row gap-2 items-center">
                        <Icon icon={CancelCircleIcon} className="scale-09 font-color-secondary" />
                        <span>Chat with your library continues to work locally</span>
                    </div>
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
                <OnboardingHeader 
                    title="Your Plan Has Changed"
                    message={getHeaderMessage()} 
                    tag="Free"
                />

                {/* Main content */}
                <div className="display-flex flex-col gap-4 flex-1">
                    {/* Data deletion notice */}
                    <div className="display-flex flex-col gap-3 p-4 rounded-lg bg-senary mt-4">
                        <div className="display-flex flex-row gap-3 items-start">
                            <Icon icon={InformationCircleIcon} className="mt-020 scale-11" />
                            <div className="display-flex flex-col gap-2">
                                <div className="font-semibold">Your Synced Data</div>
                                <div className="font-color-secondary">
                                    Your previously synced data will be removed from our servers 
                                    in <strong>{daysUntilDeletion} days</strong>. Upgrade again within this time to 
                                    preserve your data and restore full-text search.
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Upgrade reminder */}
                    <div className="display-flex flex-col gap-3 p-4 rounded-lg border-quinary">
                        <div className="display-flex flex-row gap-3 items-start">
                            <Icon icon={AlertCircleIcon} className="mt-020 scale-11 font-color-warning" />
                            <div className="display-flex flex-col gap-2">
                                <div className="font-semibold">Want to upgrade again?</div>
                                <div className="font-color-secondary">
                                    You can upgrade back to Pro at any time. If you upgrade within {daysUntilDeletion} days, 
                                    your existing indexed data will be preserved.
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Spacer */}
                    <div className="flex-1" />
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


