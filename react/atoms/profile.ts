import { atom } from "jotai";
import { SafeProfileWithPlan, PlanFeatures, ProfileBalance } from "../types/profile";
import { ZoteroLibrary } from "../types/zotero";

// Profile and plan state
export const isProfileInvalidAtom = atom<boolean>(false);
export const isProfileLoadedAtom = atom<boolean>(false);
export const profileWithPlanAtom = atom<SafeProfileWithPlan | null>(null);

// Sync libraries
export const syncLibrariesAtom =  atom<ZoteroLibrary[]>((get) => {
    const profile = get(profileWithPlanAtom);
    return profile?.libraries || [];
});

// Plan data
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

    // Page balance based on processing tier
    let pagesRemaining = 0;
    if (profile && profile.plan.processing_tier === 'basic') {
        pagesRemaining = profile.basic_page_balance + profile.purchased_basic_page_balance;
    } else if (profile && profile.plan.processing_tier === 'standard') {
        pagesRemaining = profile.standard_page_balance + profile.purchased_standard_page_balance;
    } else if (profile && profile.plan.processing_tier === 'advanced') {
        pagesRemaining = profile.advanced_page_balance + profile.purchased_advanced_page_balance;
    }

    // Chat credits remaining
    const chatMessagesRemaining = profile ? (profile.plan.monthly_chat_credits - profile.chat_credits_used) : 0;

    return {
        pagesRemaining: pagesRemaining,
        chatMessagesRemaining: chatMessagesRemaining
    } as ProfileBalance;
});

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
