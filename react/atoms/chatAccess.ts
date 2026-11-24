/**
 * Whether the account is in a state where a chat can be started, and if not,
 * why. One definition for every surface that offers a composer: the sidebar
 * swaps the composer for the screen that resolves the state, and the quick
 * prompt tells the user which screen that is and opens Beaver to it.
 */
import { atom } from 'jotai';
import { authLoadingAtom, isAuthenticatedAtom } from './auth';
import {
    hasAuthorizedFreeAccessAtom,
    isMigratingDataAtom,
    isProfileLoadedAtom,
    pendingDowngradeAckAtom,
    remainingBeaverCreditsAtom,
    updateRequiredAtom,
} from './profile';
import { isLoadingThreadAtom } from './threads';
import { isUsingBeaverCreditsAtom } from './models';
import { requestPlusToolsAtom } from './ui';
import { messageTableNamesAtom } from './messageComposition';
import {
    getPlusToolsAccess,
    getTablePlusToolsNotice,
    type PlusToolsAccess,
    type TablePlusToolsNotice,
} from '../utils/plusToolsAccess';

/**
 * What stands between the user and a chat, in the order the sidebar resolves
 * them. `loading` covers a thread being opened and data being migrated;
 * `restoring` the saved sign-in still being restored, before Beaver knows
 * whether the user is signed in; `connecting` an authenticated account whose
 * profile has not arrived.
 */
export type ChatAccessGate =
    | 'loading'
    | 'restoring'
    | 'signed-out'
    | 'connecting'
    | 'update-required'
    | 'downgrade-ack'
    | 'onboarding';

export const chatAccessGateAtom = atom<ChatAccessGate | null>((get) => {
    if (get(isLoadingThreadAtom) || get(isMigratingDataAtom)) return 'loading';
    if (!get(isAuthenticatedAtom)) return get(authLoadingAtom) ? 'restoring' : 'signed-out';
    if (!get(isProfileLoadedAtom)) return 'connecting';
    if (get(updateRequiredAtom)) return 'update-required';
    if (get(pendingDowngradeAckAtom)) return 'downgrade-ack';
    if (!get(hasAuthorizedFreeAccessAtom)) return 'onboarding';
    return null;
});

/** Whether the next message gets Plus Tools, and if not, why (see `getPlusToolsAccess`). */
export const plusToolsAccessAtom = atom<PlusToolsAccess>((get) => getPlusToolsAccess({
    gate: get(chatAccessGateAtom),
    usesBeaverModel: get(isUsingBeaverCreditsAtom),
    plusToolsPref: get(requestPlusToolsAtom),
    credits: get(remainingBeaverCreditsAtom),
}));

/**
 * Dismissed for this window's session: the notice stays away until Beaver
 * reloads, whatever is attached next.
 */
export const tablePlusToolsNoticeDismissedAtom = atom(false);

/**
 * The chat input's notice that Beaver can only read the research tables the
 * message carries (see `getTablePlusToolsNotice`), or null.
 */
export const tablePlusToolsNoticeAtom = atom<TablePlusToolsNotice | null>((get) => {
    if (get(tablePlusToolsNoticeDismissedAtom)) return null;
    return getTablePlusToolsNotice(get(plusToolsAccessAtom), get(messageTableNamesAtom).length);
});
