import { atom } from "jotai";
import { selectAtom } from 'jotai/utils';
import { ExcludedLibrary, SafeProfileWithPlan, ProfileBalance, ProcessingMode, CreditPlanStatus, CreditBreakdown, CreditPlan } from "@beaver/agent-core/types/profile";
import { ZoteroLibrary } from "@beaver/agent-core/types/zotero";
import { compareVersions } from "../utils/compareVersions";

export const cloudConsentAtom = atom<'pending' | 'declined' | 'accepted'>('pending');

export const accountGenerationAtom = atom(-1);
export const accountRevisionAtom = atom(-1);

// Profile state
export const isProfileLoadedAtom = atom<boolean>(false);
export const profileProjectionAtom = atom<SafeProfileWithPlan | null>(null);
export const profileWithPlanAtom = atom(get => get(profileProjectionAtom));

// Profile sync status. After a successful initial load this is the only signal of a refresh
// failure — profileWithPlanAtom and isProfileLoadedAtom are not torn down on transient errors.
// Reset to {kind:'ok'} on logout / SIGNED_OUT / account switch (see useAuth.ts).
export type ProfileSyncStatus =
    | { kind: 'ok' }
    | { kind: 'transient'; message: string; attempt: number; offline: boolean }
    | { kind: 'fatal'; message: string; title?: string; helpUrl?: string };

export const profileSyncStatusAtom = atom<ProfileSyncStatus>({ kind: 'ok' });

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
// True once the user has completed authorization (pro or free). Any Zotero
// instance may use the account; threads are scoped per instance instead.
export const isDeviceAuthorizedAtom = selectAtom(
    profileWithPlanAtom,
    (profile: SafeProfileWithPlan | null) =>
        Boolean(profile?.has_authorized_access || profile?.has_authorized_free_access)
);

// --- Library atoms ---

// Local Zotero libraries (populated from Zotero.Libraries.getAll on app init and profile update)
// This is used for Free users who don't store libraries in the backend per privacy policy
export const localZoteroLibrariesAtom = atom<ZoteroLibrary[]>([]);

// Distinguishes a successfully loaded (possibly empty) Zotero library list
// from the atom's initial empty value. Both the local library list and the
// profile exclusions must be known before background jobs can enforce the
// searchable-library boundary.
export const localZoteroLibrariesInitializedAtom = atom<boolean>(false);

export const libraryScopeInitializedAtom = atom<boolean>((get) => {
    return get(isProfileLoadedAtom) && get(localZoteroLibrariesInitializedAtom);
});

/**
 * Positional equality for id lists.
 *
 * Load-bearing for every library atom below. The account service publishes a
 * deep clone of its snapshot on *every* revision — a token refresh included —
 * so `profileWithPlanAtom` and `localZoteroLibrariesAtom` change identity
 * several times a second without their contents changing. Without an equality
 * guard each of those publishes hands every consumer a new array, and an effect
 * with one of these atoms in its dependency list re-runs on each one.
 */
const sameIds = (a: readonly number[], b: readonly number[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);

export const excludedLibrariesAtom = selectAtom(
    profileWithPlanAtom,
    (profile: SafeProfileWithPlan | null) => profile?.excluded_libraries ?? [],
    (a, b) => a.length === b.length
        && a.every((entry, index) => excludedEntryKey(entry) === excludedEntryKey(b[index])),
);

export function libraryExclusionKey(library: Pick<ZoteroLibrary, 'is_group' | 'group_id'>): string {
    return library.is_group && library.group_id != null ? `group:${library.group_id}` : 'user';
}

export function excludedEntryKey(entry: ExcludedLibrary): string {
    // The personal library is globally keyed as "user" because Zotero user
    // libraries have device-local numeric IDs.
    return entry.type === 'group' && entry.group_id != null ? `group:${entry.group_id}` : 'user';
}

export function excludedEntryFromLibrary(library: Pick<ZoteroLibrary, 'is_group' | 'group_id'>): ExcludedLibrary {
    if (library.is_group && library.group_id != null) {
        return { type: 'group', group_id: library.group_id };
    }
    return { type: 'user' };
}

const searchableLibraryIdsSourceAtom = atom<number[]>((get) => {
    if (!get(isProfileLoadedAtom)) return [];
    const excluded = new Set(get(excludedLibrariesAtom).map(excludedEntryKey));
    return get(localZoteroLibrariesAtom)
        .filter(lib => !excluded.has(libraryExclusionKey(lib)))
        .map(lib => lib.library_id);
});

/**
 * Searchable library IDs.
 *
 * Identity-stable across recomputations that produce the same ids — see
 * {@link sameIds}. Effects key off this list (the thread list's loader, the
 * embedding index), so a fresh array on every account publish would restart
 * them continuously.
 */
export const searchableLibraryIdsAtom = selectAtom(
    searchableLibraryIdsSourceAtom,
    (ids) => ids,
    sameIds
);

const excludedLibraryIdsSourceAtom = atom<number[]>((get) => {
    const excluded = new Set(get(excludedLibrariesAtom).map(excludedEntryKey));
    return get(localZoteroLibrariesAtom)
        .filter(lib => excluded.has(libraryExclusionKey(lib)))
        .map(lib => lib.library_id);
});

/**
 * Local library IDs the user explicitly excluded in Beaver Preferences.
 */
export const excludedLibraryIdsAtom = selectAtom(
    excludedLibraryIdsSourceAtom,
    (ids) => ids,
    sameIds
);

/**
 * Whether the library-access snapshot is ready to make allow/deny decisions.
 *
 * `searchableLibraryIdsAtom` intentionally remains fail-closed while the
 * profile is loading, so its initial value is `[]`. Consumers that need to
 * explain an access decision must distinguish that loading state from the
 * genuine "all libraries excluded" state.
 */
export const isLibraryAccessReadyAtom = atom<boolean>((get) => {
    return get(isProfileLoadedAtom)
        && get(profileWithPlanAtom) !== null
        && get(localZoteroLibrariesAtom).length > 0;
});

export const allLibrariesExcludedAtom = atom<boolean>((get) => {
    return get(isLibraryAccessReadyAtom) && get(searchableLibraryIdsAtom).length === 0;
});

/** Backend-computed OCR entitlement */
export const hasOcrAccessAtom = selectAtom(
    profileWithPlanAtom,
    (profile: SafeProfileWithPlan | null) => profile?.has_ocr_access ?? false,
);

/** Backend-computed cloud search-index entitlement. */
export const hasSearchIndexAccessAtom = selectAtom(
    profileWithPlanAtom,
    (profile: SafeProfileWithPlan | null) => profile?.has_search_index_access ?? false,
);

/**
 * Copy-only label for the background-processing welcome popup (plan §3, §8.3).
 * Decoupled from gating: 'pro' / 'search' / null (generic copy).
 */
export const indexingPlanLabelAtom = selectAtom(
    profileWithPlanAtom,
    (profile: SafeProfileWithPlan | null) => profile?.indexing_plan_label ?? null,
);

/** User-facing name of the plan whose cloud features (OCR + full-text search) cloud consent covers. */
export const cloudProductNameAtom = selectAtom(
    indexingPlanLabelAtom,
    (label) => label === 'search' ? 'Beaver Search' : 'Beaver Pro',
);

/** True while the cloud features are enabled for an account without a plan label (beta access). */
export const cloudBetaAtom = selectAtom(indexingPlanLabelAtom, (label) => label === null);

export const processingModeAtom = atom<ProcessingMode>(() => ProcessingMode.FRONTEND);

// Spendable credits, not the raw pool. The backend zeroes the subscription side
// for billing states that grant no access (unpaid, paused, incomplete, past_due
// past its paid-through date) and the purchased side once the pool has expired,
// which the raw allowance/rollover/used fields cannot express on their own.
export const remainingBeaverCreditsAtom = atom<number>((get) => {
    const profile = get(profileWithPlanAtom);
    if (!profile) return 0;
    return (profile.available_subscription_credits ?? 0) + (profile.available_purchased_credits ?? 0);
});

export const profileBalanceAtom = atom<ProfileBalance>((get) => {
    const profile = get(profileWithPlanAtom);

    // Page balance
    const pagesRemaining = profile ? profile.standard_page_balance + profile.purchased_standard_page_balance : 0;

    // Spendable credits come from the backend (see remainingBeaverCreditsAtom).
    // monthlyCredits / rolledOverCredits / monthlyCreditsUsed stay raw: they
    // describe the plan and the current period rather than what can be spent,
    // and callers pair them with subscriptionCreditLimit to render usage.
    const subscriptionChatCreditsRemaining = profile?.available_subscription_credits ?? 0;
    const purchasedChatCreditsRemaining = profile?.available_purchased_credits ?? 0;
    const chatCreditsRemaining = subscriptionChatCreditsRemaining + purchasedChatCreditsRemaining;

    return {
        pagesRemaining,
        subscriptionChatCreditsRemaining,
        purchasedChatCreditsRemaining,
        chatCreditsRemaining,
        subscriptionCreditLimit: profile?.subscription_credit_limit ?? 0,
        rolledOverCredits: profile?.rolled_over_credits || 0,
        monthlyCredits: profile?.credit_plan_monthly_credits || 0,
        monthlyCreditsUsed: profile?.chat_credits_used || 0,
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
        monthlyResetAt: profile?.credit_monthly_reset_at || null,
        cancelAtPeriodEnd: profile?.credit_cancel_at_period_end || false,
        pendingDowngrade: profile?.credit_pending_downgrade || false,
    };
});

export const creditBreakdownAtom = atom<CreditBreakdown>((get) => {
    const profile = get(profileWithPlanAtom);
    if (!profile) return { subscriptionRemaining: 0, rolledOverCredits: 0, purchasedCredits: 0, purchasedExpiresAt: null as string | null, total: 0 };
    const subscriptionRemaining = profile.available_subscription_credits ?? 0;
    const purchasedCredits = profile.available_purchased_credits ?? 0;
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

// Onboarding state
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

// Plan transition atoms
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
 * Signal atom: set to true when the preferences window regains focus
 * (e.g., returning from Stripe checkout). useProfileSync watches this
 * and forces a profile refresh.
 */
export const prefWindowFocusRefreshAtom = atom<boolean>(false);

/**
 * Signal atom: set to true when an error with has_beaver_fallback is displayed.
 * useProfileSync watches this and forces a profile refresh so credit state is up to date.
 */
export const errorCreditCheckAtom = atom<boolean>(false);
