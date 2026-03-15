import { atom } from "jotai";
import { selectAtom } from 'jotai/utils';
import { SafeProfileWithPlan, PlanFeatures, ProfileBalance, ProcessingMode, CreditPlanStatus, CreditBreakdown, CreditPlan } from "../types/profile";
import { getZoteroUserIdentifier } from "../../src/utils/zoteroUtils";
import { ZoteroLibrary } from "../types/zotero";
import { fileStatusAtom } from "./files";
import { compareVersions } from "../utils/compareVersions";

// Profile and plan state
export const isProfileInvalidAtom = atom<boolean>(false);
export const isProfileLoadedAtom = atom<boolean>(false);
export const profileWithPlanAtom = atom<SafeProfileWithPlan | null>(null);

// Data migration state
export const isMigratingDataAtom = atom<boolean>(false);
export const requiredDataVersionAtom = atom<number>(0);

// Minimum frontend version required by backend
export const minimumFrontendVersionAtom = atom<string | null>(null);

/**
 * Derived atom that checks if the current frontend version is outdated
 * Returns true if an update is required
 */
export const updateRequiredAtom = atom<boolean>((get) => {
    const minimumVersion = get(minimumFrontendVersionAtom);
    if (!minimumVersion) return false;
    
    const currentVersion = Zotero.Beaver?.pluginVersion;
    if (!currentVersion) return false;
    
    return compareVersions(currentVersion, minimumVersion) < 0;
});

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

// --- Library atoms ---

// Local Zotero libraries (populated from Zotero.Libraries.getAll on app init and profile update)
// This is used for Free users who don't store libraries in the backend per privacy policy
export const localZoteroLibrariesAtom = atom<ZoteroLibrary[]>([]);

// Libraries with synced=true (for Pro sync operations)
export const syncedLibrariesAtom = atom<ZoteroLibrary[]>((get) => {
    const profile = get(profileWithPlanAtom);
    // return (profile?.libraries || []).filter(lib => lib.synced);
    return profile?.libraries || [];
});

// Library IDs for synced libraries (for sync operations)
export const syncedLibraryIdsAtom = selectAtom(
    syncedLibrariesAtom,
    (libraries) => libraries.map(lib => lib.library_id),
    (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
);

// Searchable library IDs (for embedding index, search filtering)
// Free: all local libraries, Pro: synced only
export const searchableLibraryIdsAtom = atom<number[]>((get) => {
    const isDatabaseSyncSupported = get(isDatabaseSyncSupportedAtom);
    
    if (isDatabaseSyncSupported) {
        // Pro: only synced libraries are searchable
        return get(syncedLibrariesAtom).map(lib => lib.library_id);
    } else {
        // Free: all local libraries are searchable
        return get(localZoteroLibrariesAtom).map(lib => lib.library_id);
    }
});

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

export const isDatabaseSyncSupportedAtom = atom<boolean>((get) => {
    const planFeatures = get(planFeaturesAtom);
    return planFeatures?.databaseSync || false;
});

export const isBackendIndexingCompleteAtom = atom<boolean>((get) => {
    const profile = get(profileWithPlanAtom);
    const fileStatus = get(fileStatusAtom);
    
    // Only prioritize realtime data if it's actually available
    // If fileStatus is null, it means either:
    // 1. Realtime subscription hasn't connected yet (use profile as fallback)
    // 2. User doesn't have pro access or databaseSync (use profile as source of truth)
    // 3. Connection failed/disconnected (use profile as fallback)
    if (fileStatus !== null) {
        return fileStatus.indexing_complete;
    }
    
    // Fallback to profile data (refreshed every 15 min via useProfileSync)
    return profile?.indexing_complete || false;
});

export const processingModeAtom = atom<ProcessingMode>((get) => {
    const isBackendIndexingComplete = get(isBackendIndexingCompleteAtom);
    if (get(isDatabaseSyncSupportedAtom) && isBackendIndexingComplete) {
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

export const remainingBeaverCreditsAtom = atom<number>((get) => {
    const profile = get(profileWithPlanAtom);
    if (!profile) return 0;
    const subscriptionRemaining = Math.max(0, (profile.credit_plan_monthly_credits || 0) + (profile.rolled_over_credits || 0) - (profile.chat_credits_used || 0));
    const purchasedRemaining = profile.purchased_chat_credits || 0;
    return subscriptionRemaining + purchasedRemaining;
});

export const profileBalanceAtom = atom<ProfileBalance>((get) => {
    const profile = get(profileWithPlanAtom);

    // Page balance
    const pagesRemaining = profile ? profile.standard_page_balance + profile.purchased_standard_page_balance : 0;

    // Chat credits remaining (new formula with rolled-over credits)
    const monthlyCredits = profile?.credit_plan_monthly_credits || 0;
    const rolledOverCredits = profile?.rolled_over_credits || 0;
    const monthlyCreditsUsed = profile?.chat_credits_used || 0;
    const subscriptionChatCreditsRemaining = Math.max(0, monthlyCredits + rolledOverCredits - monthlyCreditsUsed);
    const purchasedChatCreditsRemaining = profile?.purchased_chat_credits || 0;
    const chatCreditsRemaining = subscriptionChatCreditsRemaining + purchasedChatCreditsRemaining;

    return {
        pagesRemaining,
        subscriptionChatCreditsRemaining,
        purchasedChatCreditsRemaining,
        chatCreditsRemaining,
        rolledOverCredits,
        monthlyCredits,
        monthlyCreditsUsed,
    };
});

// --- Credit plan atoms ---

export const creditPlanAtom = atom<CreditPlan>((get) => {
    const profile = get(profileWithPlanAtom);
    return {
        plan: profile?.credit_plan || null,
        status: (profile?.credit_plan_status || 'none') as CreditPlanStatus,
        monthlyCredits: profile?.credit_plan_monthly_credits || 0,
        periodEnd: profile?.credit_period_end || null,
        cancelAtPeriodEnd: profile?.credit_cancel_at_period_end || false,
    };
});

export const creditBreakdownAtom = atom<CreditBreakdown>((get) => {
    const profile = get(profileWithPlanAtom);
    if (!profile) return { subscriptionRemaining: 0, rolledOverCredits: 0, purchasedCredits: 0, purchasedExpiresAt: null as string | null, total: 0 };
    const subscriptionRemaining = Math.max(0, (profile.credit_plan_monthly_credits || 0) + (profile.rolled_over_credits || 0) - (profile.chat_credits_used || 0));
    const purchasedCredits = profile.purchased_chat_credits || 0;
    return {
        subscriptionRemaining,
        rolledOverCredits: profile.rolled_over_credits || 0,
        purchasedCredits,
        purchasedExpiresAt: profile.purchased_credits_expires_at,
        total: subscriptionRemaining + purchasedCredits,
    };
});

export const isCreditPlanPastDueAtom = atom<boolean>((get) => {
    const profile = get(profileWithPlanAtom);
    return profile?.credit_plan_status === 'past_due';
});

export const hasCreditPlanAtom = atom<boolean>((get) => {
    const profile = get(profileWithPlanAtom);
    const status = profile?.credit_plan_status;
    return status === 'active' || status === 'past_due';
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
    const isDatabaseSyncSupported = get(isDatabaseSyncSupportedAtom);
    return (
        profile?.has_completed_onboarding ||
        // Free accounts don't need to complete onboarding
        !isDatabaseSyncSupported ||
        false
    );
});

// Plan transition atoms
export const pendingUpgradeConsentAtom = selectAtom(
    profileWithPlanAtom,
    (profile: SafeProfileWithPlan | null) => profile?.pending_upgrade_consent || false
);

export const pendingDowngradeAckAtom = selectAtom(
    profileWithPlanAtom,
    (profile: SafeProfileWithPlan | null) => profile?.pending_downgrade_ack || false
);

export const dataDeletionScheduledForAtom = selectAtom(
    profileWithPlanAtom,
    (profile: SafeProfileWithPlan | null) => profile?.data_deletion_scheduled_for || null
);

export const isMcpServerSupportedAtom = atom<boolean>((get) => {
    const profile = get(profileWithPlanAtom);
    return profile?.plan.mcp_server || false;
});

export const syncWithZoteroAtom = atom<boolean>((get) => {
    const profile = get(profileWithPlanAtom);
    return profile?.use_zotero_sync || false;
});

/**
 * Signal atom: set to true when the preferences window regains focus
 * (e.g., returning from Stripe checkout). useProfileSync watches this
 * and forces a profile refresh.
 */
export const prefWindowFocusRefreshAtom = atom<boolean>(false);

/**
 * Atom to signal that a sync request was denied due to plan restrictions.
 * When set to true, useProfileSync will force a profile refresh to update
 * the local plan state, which will cause isDatabaseSyncSupportedAtom to
 * update and useZoteroSync to unregister its observer.
 */
export const syncDeniedForPlanAtom = atom<boolean>(false);

/**
 * Signal atom: set to true when an error with has_beaver_fallback is displayed.
 * useProfileSync watches this and forces a profile refresh so credit state is up to date.
 */
export const errorCreditCheckAtom = atom<boolean>(false);

/**
 * Indexing progress atom - returns the current indexing progress (0-100)
 * from files_status realtime subscription, or from profile as fallback.
 */
export const indexingProgressAtom = atom<number>((get) => {
    const fileStatus = get(fileStatusAtom);
    return fileStatus?.indexing_progress ?? 0;
});
