import { useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { runsCountAtom } from '@beaver/agent-core/run-state/atoms';
import { featureCreditsCardDismissedAtom } from '../atoms/featureCredits';
import { newThreadAtom } from '../atoms/threads';
import { eventManager } from '../events/eventManager';
import { getWindowRuntime } from '../runtime/windowRuntime';

/**
 * Shows the feature-credit tasks on the home screen of this window's chat,
 * from outside it (Plan & Usage), and brings the window to the front. The
 * card comes back if it was dismissed. An open conversation is left for a
 * new chat that keeps the draft's text and /commands; does nothing when the
 * user cancels leaving it.
 */
export function useShowFeatureCreditsCard(): () => Promise<void> {
    const runsCount = useAtomValue(runsCountAtom);
    const newThread = useSetAtom(newThreadAtom);
    const setDismissed = useSetAtom(featureCreditsCardDismissedAtom);
    return useCallback(async () => {
        eventManager.dispatch('toggleChat', { forceOpen: true });
        if (runsCount > 0 && (await newThread({ preserveDraft: true })) === undefined) return;
        setDismissed(false);
        getWindowRuntime().hostWindow.focus();
    }, [runsCount, newThread, setDismissed]);
}
