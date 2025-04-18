// useFeature.ts
import { useAtomValue } from 'jotai';
import { profileWithPlanAtom } from '../atoms/profile';
import { ProfileWithPlan } from '../types/profile';

export type Feature =
    | 'sync'
    | 'upload'
    | 'basicProcessing'
    | 'advancedProcessing'
    | 'fileProcessing'
    | 'ragSearch'
    | 'agenticSearch'
    | 'deepResearch'
    | 'basicPagesRemaining'
    | 'advancedPagesRemaining'
    | 'chatMessagesRemaining'
    | 'byok';

export function computeFeatures(profile: ProfileWithPlan): Record<Feature, boolean | number> {
    const plan = profile.plan;

    return {
        sync: plan.sync_database,
        upload: plan.upload_files,
        basicProcessing: plan.basic_document_processing,
        advancedProcessing: plan.advanced_document_processing && profile.advanced_page_balance > 0,
        fileProcessing: plan.basic_document_processing || plan.advanced_document_processing,
        ragSearch: plan.rag_search,
        agenticSearch: plan.agentic_search,
        deepResearch: plan.deep_research,
        basicPagesRemaining: profile.basic_page_balance,
        advancedPagesRemaining: profile.advanced_page_balance,
        chatMessagesRemaining: Math.max(plan.monthly_chat_messages - (profile.app_key_chats_count + profile.user_key_chats_count), 0),
        byok: plan.allows_byok
    };
}

export function useFeature(feature: Feature) {
    const profile = useAtomValue(profileWithPlanAtom);
    if (!profile) return false;  // still loading → safe default
    return computeFeatures(profile)[feature];
}