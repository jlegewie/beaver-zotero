import React, { useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { profileWithPlanAtom, dataDeletionScheduledForAtom } from "../../atoms/profile";
import { accountService } from "../../../src/services/accountService";
import { logger } from "../../../src/utils/logger";
import { OnboardingHeader, OnboardingFooter } from "./onboarding";
import { Icon, CancelIcon, TickIcon, LockIcon } from "../icons/icons";

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
        if (!dataDeletionScheduledFor) return 7;
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
                    Your plan has changed to the <b>Free plan</b>. Here's what changed:
                </div>
                <div className="display-flex flex-col gap-2 ml-1">
                    <div className="display-flex flex-row gap-2 items-start">
                        <Icon icon={TickIcon} className="scale-09 font-color-secondary mt-020" />
                        <span>Same AI agent with seamless Zotero integration</span>
                    </div>
                    <div className="display-flex flex-row gap-2 items-start">
                        <Icon icon={TickIcon} className="scale-09 font-color-secondary mt-020" />
                        <span>Chat with your entire library</span>
                    </div>
                    <div className="display-flex flex-row gap-2 items-start">
                        <Icon icon={TickIcon} className="scale-09 font-color-secondary mt-020" />
                        <span>Metadata & semantic search (runs locally)</span>
                    </div>
                </div>
                <div>
                    Not included in Free
                </div>
                <div className="display-flex flex-col gap-2 ml-1">
                    <div className="display-flex flex-row gap-2 items-start">
                        <Icon icon={CancelIcon} className="scale-90 font-color-secondary mt-020" />
                        <span>Full-text PDF search</span>
                    </div>
                    <div className="display-flex flex-row gap-2 items-start">
                        <Icon icon={CancelIcon} className="scale-90 font-color-secondary mt-020" />
                        <span>Server-side processing for improved search and document understanding</span>
                    </div>
                    <div className="display-flex flex-row gap-2 items-start">
                        <Icon icon={CancelIcon} className="scale-90 font-color-secondary mt-020" />
                        <span>Precise sentence-level citations (Free uses page-level citations)</span>
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
                <OnboardingHeader message={getHeaderMessage()} tag="Free"/>

                {/* Main content */}
                <div className="display-flex flex-1"/>
                <div className="display-flex flex-col gap-4 flex-1">
                    {/* Data deletion notice */}
                    <div className="display-flex flex-col gap-3 p-4 rounded-lg bg-senary mt-4">
                        <div className="display-flex flex-row gap-3 items-start">
                            <Icon icon={LockIcon} className="mt-020 scale-11" />
                            <div className="display-flex flex-col gap-2">
                                <div className="font-semibold">Free Plan Privacy Notice</div>
                                <div className="font-color-secondary">
                                    The Free plan does not sync your Zotero library or upload PDFs.
                                    Semantic search uses embeddings generated on our server from titles and abstracts that are only stored on your device.
                                    Your chat history is stored server-side and may include selected file and library content.
                                    It can be exported or deleted anytime.
                                    {/* Your Zotero data and files are never synced or stored on our servers.
                                    File processing and search is handled locally on your device.
                                    Metadata is processed temporarily server-side (not stored) to support local search.
                                    Your chat history is stored on our servers. It can be exported or deleted anytime. */}
                                </div>
                                <div className="font-color-secondary">
                                    Your previously synced data will be deleted from our servers 
                                    within <strong>{daysUntilDeletion} days</strong>.
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Upgrade reminder */}
                    {/* <div className="display-flex flex-col gap-3 p-4 rounded-lg border-quinary">
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
                    </div> */}

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


