/**
 * Whether the account is in a state where a chat can be started, and if not,
 * why. One definition for every surface that offers a composer: the sidebar
 * swaps the composer for the screen that resolves the state, and the quick
 * prompt tells the user which screen that is and opens Beaver to it.
 */
import { atom } from 'jotai';
import { isAuthenticatedAtom } from './auth';
import {
    hasAuthorizedFreeAccessAtom,
    hasAuthorizedProAccessAtom,
    hasCompletedOnboardingAtom,
    isDatabaseSyncSupportedAtom,
    isMigratingDataAtom,
    isProfileLoadedAtom,
    pendingDowngradeAckAtom,
    pendingUpgradeConsentAtom,
    syncedLibrariesAtom,
    updateRequiredAtom,
} from './profile';
import { isLoadingThreadAtom } from './threads';

/**
 * What stands between the user and a chat, in the order the sidebar resolves
 * them. `loading` covers a thread being opened and data being migrated;
 * `connecting` an authenticated account whose profile has not arrived.
 */
export type ChatAccessGate =
    | 'loading'
    | 'signed-out'
    | 'connecting'
    | 'update-required'
    | 'downgrade-ack'
    | 'upgrade-consent'
    | 'onboarding';

export const chatAccessGateAtom = atom<ChatAccessGate | null>((get) => {
    if (get(isLoadingThreadAtom) || get(isMigratingDataAtom)) return 'loading';
    if (!get(isAuthenticatedAtom)) return 'signed-out';
    if (!get(isProfileLoadedAtom)) return 'connecting';
    if (get(updateRequiredAtom)) return 'update-required';
    if (get(pendingDowngradeAckAtom)) return 'downgrade-ack';
    if (get(pendingUpgradeConsentAtom)) return 'upgrade-consent';
    // Free users need to have authorized free access only; Pro users need
    // authorized access, completed onboarding, and at least one library.
    const needsOnboarding = get(isDatabaseSyncSupportedAtom)
        ? (!get(hasAuthorizedProAccessAtom) || !get(hasCompletedOnboardingAtom) || get(syncedLibrariesAtom).length === 0)
        : !get(hasAuthorizedFreeAccessAtom);
    if (needsOnboarding) return 'onboarding';
    return null;
});
