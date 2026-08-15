import { atom } from 'jotai';
import { citationsAtom } from '@beaver/agent-core/citations/atoms';
import { isExternalCitation, getCitationPages } from '@beaver/agent-core/types/citations';
import { activeRunAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { isFirstRunOrigin } from '@beaver/agent-core/agents/types';
import { getPref, setPref } from '../../src/utils/prefs';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { isFirstRunVisibleAtom } from './firstRun';

/**
 * One-time citation tip: shown once the thread holds an external or
 * page-locator citation. A persistent pref ensures it fires at most once.
 *
 * Suppressed without setting the pref while: (1) FirstRunPage is visible, or
 * (2) the active thread is a first-run thread (any run carries a first-run
 * origin — `first_run_card` or `first_run_followup`). Avoids overlapping the
 * citation popup with the NextStepsPanel / BackToSuggestions panels.
 *
 * Zotero-only onboarding UI: set it alongside `processCitationsAtom` wherever
 * citations enter or leave the thread state. Keeping it out of the shared
 * citation atoms is what lets those stay client-agnostic.
 */
export const maybeShowCitationTipAtom = atom(
    null,
    (get, set) => {
        const citations = get(citationsAtom);
        const hasTipWorthyCitation = citations.some(
            (citation) => isExternalCitation(citation) || getCitationPages(citation).length > 0
        );
        if (!hasTipWorthyCitation) return;

        if (get(isFirstRunVisibleAtom)) return;
        const activeRun = get(activeRunAtom);
        const threadRuns = get(threadRunsAtom);
        const isFirstRunThread =
            isFirstRunOrigin(activeRun?.user_prompt?.origin) ||
            threadRuns.some((r) => isFirstRunOrigin(r.user_prompt?.origin));
        if (isFirstRunThread) return;
        if (getPref('onboardingCitationTipShown')) return;
        setPref('onboardingCitationTipShown', true);

        set(addPopupMessageAtom, {
            type: 'citation_tip' as const,
            title: 'Understanding Citations',
            expire: false,
        });
    }
);
