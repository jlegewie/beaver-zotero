import { atom } from 'jotai';
import { accountService } from '@beaver/agent-core/transport/clients/accountService';
import { profileWithPlanAtom, isDeviceAuthorizedAtom } from './profile';
import type { FirstRunVariant } from '../utils/firstRunSelection';

/**
 * Session-only preview of a first-run page (Dev Tools), shown whether or not
 * the account has finished first run. Starting or skipping clears it.
 */
export const firstRunPreviewAtom = atom<FirstRunVariant | null>(null);

/**
 * Session-only set of run ids whose NextStepsPanel the user has dismissed.
 */
export const firstRunNextStepsDismissedAtom = atom<Set<string>>(new Set<string>());

/**
 * Single source of truth for "should a first-run page be the visible page".
 */
export const isFirstRunVisibleAtom = atom((get) => {
    if (get(firstRunPreviewAtom)) return true;
    const profile = get(profileWithPlanAtom);
    const isDeviceAuthorized = get(isDeviceAuthorizedAtom);
    return (
        !!profile?.has_authorized_free_access &&
        isDeviceAuthorized &&
        !profile?.first_run_completed_at
    );
});

/**
 * Idempotent stamp of `first_run_completed_at` on the user's profile.
 */
export const markFirstRunCompleteAtom = atom(
    null,
    async (get, set, completionKind?: string) => {
        const profile = get(profileWithPlanAtom);
        if (!profile || profile.first_run_completed_at) return;
        await accountService.completeFirstRun(completionKind);
        await Zotero.Beaver.account!.invalidateProfile();
    },
);
