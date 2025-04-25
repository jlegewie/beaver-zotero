import { atom } from "jotai";
import { ProfileWithPlan, PlanFeatures } from "../types/profile";
import { accountService } from "../../src/services/accountService";

export const profileWithPlanAtom = atom<ProfileWithPlan | null>(null);

export const fetchProfileWithPlanAtom = atom(
    null,
    async (get, set) => {
        try {
            const profileFetched = await accountService.getProfileWithPlan();
            set(profileWithPlanAtom, profileFetched);
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
        agenticSearch: profile?.plan.agentic_search || false,
        deepResearch: profile?.plan.deep_research || false,
        basicPagesRemaining: profile?.basic_page_balance || 0,
        advancedPagesRemaining: profile?.advanced_page_balance || 0,
        chatMessagesRemaining: (profile?.plan.monthly_chat_messages && profile?.app_key_chats_count)
            ? profile.plan.monthly_chat_messages - profile.app_key_chats_count
            : 0,
        byok: profile?.plan.allows_byok || false,
    };
});