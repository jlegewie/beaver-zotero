import { atom } from 'jotai';
import { accountService } from '@beaver/agent-core/transport/clients/accountService';
import { allLibrariesExcludedAtom, profileWithPlanAtom, isDeviceAuthorizedAtom } from './profile';
import { hasOpenFeatureTasks } from '../utils/featureCredits';
import { logger } from '@beaver/agent-core/platform/logger';
import { setPref } from '../../src/utils/prefs';

/**
 * Session-only preview of the "Where should we start?" first-run page (Dev
 * Tools), shown whether or not the account has finished first run. Starting
 * or skipping clears it.
 */
export const firstRunPreviewAtom = atom(false);

/**
 * Session-only set of run ids whose NextStepsPanel the user has dismissed.
 */
export const firstRunNextStepsDismissedAtom = atom<Set<string>>(new Set<string>());

/** A Free user, device authorized, who never completed first run on this account. */
const isFirstRunPendingAtom = atom((get) => {
    const profile = get(profileWithPlanAtom);
    return (
        !!profile?.has_authorized_free_access &&
        get(isDeviceAuthorizedAtom) &&
        !profile?.first_run_completed_at
    );
});

/**
 * First run for an account that can earn feature credits: the home screen
 * with the task list. It ends on the user's first choice there (see
 * `completeCreditsFirstRunAtom`). Every other account gets the first-run page.
 */
export const isCreditsFirstRunAtom = atom((get) =>
    get(isFirstRunPendingAtom)
    && !get(allLibrariesExcludedAtom)
    && hasOpenFeatureTasks(get(profileWithPlanAtom)?.feature_credits),
);

/**
 * Single source of truth for "should the first-run page be the visible page":
 * "Where should we start?", for accounts in first run that cannot earn
 * feature credits, or as a Dev Tools preview.
 */
export const isFirstRunVisibleAtom = atom((get) => {
    if (get(firstRunPreviewAtom)) return true;
    return get(isFirstRunPendingAtom) && !get(isCreditsFirstRunAtom);
});

/** Completion in flight in this window, so a second choice cannot overwrite the first. */
let completing: Promise<void> | null = null;

/**
 * Idempotent stamp of `first_run_completed_at` on the user's profile. The
 * server keeps the first `completionKind` it receives.
 */
export const markFirstRunCompleteAtom = atom(
    null,
    async (get, _set, completionKind?: string) => {
        const profile = get(profileWithPlanAtom);
        if (!profile || profile.first_run_completed_at || completing) return;
        completing = (async () => {
            await accountService.completeFirstRun(completionKind);
            await Zotero.Beaver.account!.invalidateProfile();
        })();
        try {
            await completing;
        } finally {
            completing = null;
        }
    },
);

/**
 * End a feature-credits first run with the user's first choice: a task key
 * (they picked a task), `chat` (they sent a message of their own) or
 * `dismiss` (they closed the task list). Recorded as `feature_credits_<choice>`.
 * Someone who has seen the task list never gets the one-line prompt that leads
 * existing users to it. Does nothing outside that first run. Never throws: a
 * failed request leaves first run open, and the next choice records it.
 */
export const completeCreditsFirstRunAtom = atom(
    null,
    async (get, set, choice: string) => {
        if (!get(isCreditsFirstRunAtom)) return;
        try {
            setPref('featureCreditsTeaserDone', true);
            await set(markFirstRunCompleteAtom, `feature_credits_${choice}`);
        } catch (error) {
            logger(`completeCreditsFirstRun: failed to record ${choice}: ${error}`, 1);
        }
    },
);
