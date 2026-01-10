import { atom } from "jotai";
import { selectAtom } from 'jotai/utils';
import { SafeProfileWithPlan, PlanFeatures, ProfileBalance, ProcessingMode } from "../types/profile";
import { getZoteroUserIdentifier } from "../../src/utils/zoteroUtils";
import { ZoteroLibrary } from "../types/zotero";
import { fileStatusAtom } from "./files";

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
 * Parses a version string into its components
 * Handles formats like: "0.9.6", "0.10", "1.0.0", "0.9.7-beta.1", "0.10.0-beta.3"
 */
function parseVersion(version: string): { parts: number[]; preRelease: string | null; preReleaseNum: number | null } {
    // Split into main version and pre-release (e.g., "0.9.7-beta.1" -> ["0.9.7", "beta.1"])
    const [main, ...preParts] = version.split('-');
    const preRelease = preParts.length > 0 ? preParts.join('-') : null;
    
    // Parse main version parts (e.g., "0.10.0" -> [0, 10, 0])
    const parts = main.split('.').map(Number);
    
    // Parse pre-release number if present (e.g., "beta.1" -> 1)
    let preReleaseNum: number | null = null;
    if (preRelease) {
        const match = preRelease.match(/\.(\d+)$/);
        if (match) {
            preReleaseNum = parseInt(match[1], 10);
        }
    }
    
    return { parts, preRelease, preReleaseNum };
}

/**
 * Compares two semantic version strings
 * Properly handles:
 * - Different version lengths (0.10 vs 0.10.0)
 * - Multi-digit parts (0.10.0 > 0.9.7)
 * - Pre-release versions (0.9.7-beta.1 < 0.9.7)
 * - Pre-release ordering (0.9.7-beta.2 > 0.9.7-beta.1)
 * @returns -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
function compareVersions(v1: string, v2: string): number {
    const parsed1 = parseVersion(v1);
    const parsed2 = parseVersion(v2);
    
    // Compare main version parts
    const maxLength = Math.max(parsed1.parts.length, parsed2.parts.length);
    for (let i = 0; i < maxLength; i++) {
        const num1 = parsed1.parts[i] || 0;
        const num2 = parsed2.parts[i] || 0;
        if (num1 < num2) return -1;
        if (num1 > num2) return 1;
    }
    
    // Main versions are equal, compare pre-release status
    // A version without pre-release is greater than one with pre-release
    // e.g., 0.9.7 > 0.9.7-beta.1
    if (parsed1.preRelease && !parsed2.preRelease) return -1;
    if (!parsed1.preRelease && parsed2.preRelease) return 1;
    
    // Both have pre-release, compare pre-release numbers
    // e.g., 0.9.7-beta.2 > 0.9.7-beta.1
    if (parsed1.preRelease && parsed2.preRelease) {
        const num1 = parsed1.preReleaseNum || 0;
        const num2 = parsed2.preReleaseNum || 0;
        if (num1 < num2) return -1;
        if (num1 > num2) return 1;
    }
    
    return 0;
}

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

export const syncWithZoteroAtom = atom<boolean>((get) => {
    const profile = get(profileWithPlanAtom);
    return profile?.use_zotero_sync || false;
});

/**
 * Indexing progress atom - returns the current indexing progress (0-100)
 * from files_status realtime subscription, or from profile as fallback.
 */
export const indexingProgressAtom = atom<number>((get) => {
    const fileStatus = get(fileStatusAtom);
    return fileStatus?.indexing_progress ?? 0;
});
