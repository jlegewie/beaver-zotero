import { atom } from 'jotai';
import { clearUserScopedPrefs } from '../utils/clearUserScopedPrefs';
import { resetUserModelStateAtom } from './models';
import { deletionJobsAtom } from './sync';

/**
 * Reset state on account switch:
 * 1. Clear account-scoped prefs (identity, BYOK keys, sync state, caches).
 *    Local-only user content (custom prompts, actions, instructions, custom
 *    models, deferred tool preferences) is preserved.
 * 2. Reset in-memory atoms whose hydrated state must follow the cleared prefs:
 *    - BYOK key atoms + selectedModelAtom (models.ts) — keys are wiped and
 *      the previous account's model selection may not be valid for the new
 *      plan.
 *    - deletionJobsAtom — useLibraryDeletions hydrates this from the
 *      deletionJobs pref on mount and writes back to the pref on every
 *      change. Clearing only the pref would leave the in-memory map
 *      pointing at the previous account's jobs and re-persist them.
 *
 * Called from SignInForm when the user confirms a switch, before auth
 * fires — by that point the user has explicitly consented to losing the
 * cleared state, so a downstream auth failure does not need a rollback.
 */
export const performAccountSwitchAtom = atom(
    null,
    (_, set) => {
        clearUserScopedPrefs();
        set(resetUserModelStateAtom);
        set(deletionJobsAtom, {});
    }
);
