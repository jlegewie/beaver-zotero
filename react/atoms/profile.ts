import { atom } from "jotai";
import { ProfileWithPlan, PlanFeatures, ProfileBalance } from "../types/profile";
import { accountService } from "../../src/services/accountService";
import { getPref } from "../../src/utils/prefs";

// Onboarding state
export const userAuthorizationAtom = atom<boolean>(getPref('userAuthorization'));
export const isInitialSyncCompleteAtom = atom<boolean>(getPref('isInitialSyncComplete'));
export const isInitialUploadCompleteAtom = atom<boolean>(getPref('isInitialUploadComplete'));
export const isOnboardingCompleteAtom = atom(getPref("isOnboardingComplete"));

// Profile and plan state
export const isProfileLoadedAtom = atom<boolean>(false);
export const profileWithPlanAtom = atom<ProfileWithPlan | null>(null);

export const planNameAtom = atom<string>((get) => {
    const profile = get(profileWithPlanAtom);
    return profile?.plan.display_name || 'Unknown';
});

export const fetchProfileWithPlanAtom = atom(
    null,
    async (get, set) => {
        try {
            const profileFetched = await accountService.getProfileWithPlan();
            set(profileWithPlanAtom, profileFetched);
            set(isProfileLoadedAtom, true);
        } catch (error: any) {
            Zotero.debug('Error fetching profile:', error, 3);
        }
    }
);

export const planFeaturesAtom = atom<PlanFeatures>((get) => {
    const profile = get(profileWithPlanAtom);
    return {
        databaseSync: profile?.plan.sync_database || false,
        uploadFiles: profile?.plan.upload_files || false,
        basicProcessing: profile?.plan.basic_document_processing || false,
        advancedProcessing: profile?.plan.advanced_document_processing || false,
        fileProcessing: profile?.plan.basic_document_processing || profile?.plan.advanced_document_processing || false,
        ragSearch: profile?.plan.rag_search || false,
        agentModels: profile?.plan.agent_models || false,
        byok: profile?.plan.allows_byok || false,
        maxUserAttachments: profile?.plan.max_chat_attachments_per_message || 2,
    } as PlanFeatures;
});

export const planSupportedAtom = atom<boolean>((get) => {
    const planFeatures = get(planFeaturesAtom);
    return planFeatures.databaseSync && planFeatures.uploadFiles && planFeatures.fileProcessing;
});

export const profileBalanceAtom = atom<ProfileBalance>((get) => {
    const profile = get(profileWithPlanAtom);
    return {
        basicPagesRemaining: profile?.basic_page_balance || 0,
        advancedPagesRemaining: profile?.advanced_page_balance || 0,
        chatMessagesRemaining: profile?.plan.monthly_chat_messages && profile?.app_key_chats_count
            ? profile.plan.monthly_chat_messages - profile.app_key_chats_count
            : 0
    } as ProfileBalance;
});
