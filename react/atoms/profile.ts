import { atom } from "jotai";
import { selectAtom } from 'jotai/utils';
import { SafeProfileWithPlan, PlanFeatures, ProfileBalance, ProcessingMode } from "../types/profile";
import { getZoteroUserIdentifier } from "../../src/utils/zoteroUtils";
import { ZoteroLibrary } from "../types/zotero";

// Profile and plan state
export const isProfileInvalidAtom = atom<boolean>(false);
export const isProfileLoadedAtom = atom<boolean>(false);
export const profileWithPlanAtom = atom<SafeProfileWithPlan | null>(null);

// Data migration state
export const isMigratingDataAtom = atom<boolean>(false);
export const requiredDataVersionAtom = atom<number>(0);

// Device authorization state
// A device is authorized if the user has completed authorization (pro or free) AND the device is in the list
const { localUserKey } = getZoteroUserIdentifier();
export const isDeviceAuthorizedAtom = selectAtom(
    profileWithPlanAtom,
    (profile: SafeProfileWithPlan | null) => {
        const hasAnyAuthorization = profile?.has_authorized_access || profile?.has_authorized_free_access;
        return hasAnyAuthorization && profile?.zotero_local_ids?.includes(localUserKey) || false;
    }
);

// Sync libraries
export const syncLibrariesAtom = atom<ZoteroLibrary[]>((get) => {
    const profile = get(profileWithPlanAtom);
    return profile?.libraries || [];
});

export const syncLibraryIdsAtom = selectAtom(
    profileWithPlanAtom,
    (profile: SafeProfileWithPlan | null) => profile?.libraries?.map((library) => library.library_id) || [],
    (a: number[], b: number[]) => a.length === b.length && a.every((value, index) => value === b[index]) // only notify if value actually changed
);

// Plan data
export const planIdAtom = atom<string>((get) => {
    const profile = get(profileWithPlanAtom);
    return profile?.plan.id || '';
});

export const planNameAtom = atom<string>((get) => {
    const profile = get(profileWithPlanAtom);
    return profile?.plan.name || 'Unknown';
});

export const planDisplayNameAtom = atom<string>((get) => {
    const profile = get(profileWithPlanAtom);
    return profile?.plan.display_name || 'Unknown';
});

export const processingModeAtom = atom<ProcessingMode>((get) => {
    const profile = get(profileWithPlanAtom);
    if (get(planFeaturesAtom).databaseSync && profile?.indexing_complete === true) {
        return ProcessingMode.BACKEND;
    } else {
        return ProcessingMode.FRONTEND;
    }
});

// Plan features
export const planFeaturesAtom = atom<PlanFeatures>((get) => {
    const profile = get(profileWithPlanAtom);
    return {
        databaseSync: profile?.plan.sync_database || false,
        uploadFiles: profile?.plan.upload_files || false,
        maxUserAttachments: profile?.plan.max_user_attachments || 2,
        uploadFileSizeLimit: profile?.plan.max_file_size_mb || 10,
        maxPageCount: profile?.plan.max_page_count || 100,
    } as PlanFeatures;
});

export const profileBalanceAtom = atom<ProfileBalance>((get) => {
    const profile = get(profileWithPlanAtom);

    // Page balance
    const pagesRemaining = profile ? profile.standard_page_balance + profile.purchased_standard_page_balance : 0;

    // Chat credits remaining
    const chatMessagesRemaining = profile ? (profile.plan.monthly_chat_credits - profile.chat_credits_used) : 0;

    return {
        pagesRemaining: pagesRemaining,
        chatMessagesRemaining: chatMessagesRemaining
    } as ProfileBalance;
});

// Onboarding state - separate atoms for pro and free authorization
export const hasAuthorizedProAccessAtom = selectAtom(
    profileWithPlanAtom,
    (profile: SafeProfileWithPlan | null) => profile?.has_authorized_access || false
);

export const hasAuthorizedFreeAccessAtom = selectAtom(
    profileWithPlanAtom,
    (profile: SafeProfileWithPlan | null) => profile?.has_authorized_free_access || false
);

// Combined authorization check - returns true if user has completed EITHER authorization flow
// This preserves backward compatibility with existing code that uses hasAuthorizedAccessAtom
export const hasAuthorizedAccessAtom = atom<boolean>((get) => {
    const profile = get(profileWithPlanAtom);
    if (!profile) return false;
    return profile.has_authorized_access || profile.has_authorized_free_access;
});

export const hasCompletedOnboardingAtom = atom<boolean>((get) => {
    const profile = get(profileWithPlanAtom);
    const planFeatures = get(planFeaturesAtom);
    return (
        profile?.has_completed_onboarding ||
        // Free accounts don't need to complete onboarding
        (planFeatures && !planFeatures.databaseSync) ||
        false
    );
});

export const syncWithZoteroAtom = atom<boolean>((get) => {
    const profile = get(profileWithPlanAtom);
    return profile?.use_zotero_sync || false;
});
