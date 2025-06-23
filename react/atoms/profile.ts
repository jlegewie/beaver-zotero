import { atom } from "jotai";
import { ProfileWithPlan, PlanFeatures, ProfileBalance } from "../types/profile";

// Onboarding state
export const hasAuthorizedAccessAtom = atom<boolean>((get) => {
    const profile = get(profileWithPlanAtom);
    return profile?.has_authorized_access || false;
});

export const hasCompletedOnboardingAtom = atom<boolean>((get) => {
    const profile = get(profileWithPlanAtom);
    return profile?.has_completed_onboarding || false;
});

export const hasCompletedInitialSyncAtom = atom<boolean>(false);

// Profile and plan state
export const isProfileInvalidAtom = atom<boolean>(false);
export const isProfileLoadedAtom = atom<boolean>(false);
export const profileWithPlanAtom = atom<ProfileWithPlan | null>(null);

export const planIdAtom = atom<string>((get) => {
    const profile = get(profileWithPlanAtom);
    return profile?.plan.id || '';
});

export const planNameAtom = atom<string>((get) => {
    const profile = get(profileWithPlanAtom);
    return profile?.plan.display_name || 'Unknown';
});

export const planFeaturesAtom = atom<PlanFeatures>((get) => {
    const profile = get(profileWithPlanAtom);
    return {
        databaseSync: profile?.plan.sync_database || false,
        uploadFiles: profile?.plan.upload_files || false,
        processingTier: profile?.plan.processing_tier || 'basic',
        maxUserAttachments: profile?.plan.max_user_attachments || 2,
    } as PlanFeatures;
});

export const profileBalanceAtom = atom<ProfileBalance>((get) => {
    const profile = get(profileWithPlanAtom);
    return {
        basicPagesRemaining: profile?.basic_page_balance || 0,
        standardPagesRemaining: profile?.standard_page_balance || 0,
        advancedPagesRemaining: profile?.advanced_page_balance || 0,
        chatMessagesRemaining: profile?.plan.monthly_chat_credits && profile?.chat_credits_used
            ? profile.plan.monthly_chat_credits - profile.chat_credits_used
            : 0
    } as ProfileBalance;
});
