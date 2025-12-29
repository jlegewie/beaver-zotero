import React from "react";
import { useAtomValue } from "jotai";
import { planFeaturesAtom } from "../../atoms/profile";
import ProOnboardingPage from "./ProOnboardingPage";
import FreeOnboardingPage from "./FreeOnboardingPage";

/**
 * Router component that determines which onboarding flow to render
 * based on the user's plan features.
 * 
 * Current flows:
 * - Pro/Beta: Full onboarding with library selection, file upload, and sync
 * - Free: Single-screen onboarding with local embedding indexing
 * 
 * Future extensions:
 * - Upgrade from Free to Pro flow
 * - Downgrade from Pro to Free flow
 */
const OnboardingRouter: React.FC = () => {
    const planFeatures = useAtomValue(planFeaturesAtom);

    // Pro/Beta plans have databaseSync enabled - use full onboarding flow
    if (planFeatures.databaseSync) {
        return <ProOnboardingPage />;
    }

    // Free plan - use simplified single-screen flow
    return <FreeOnboardingPage />;
};

export default OnboardingRouter;

