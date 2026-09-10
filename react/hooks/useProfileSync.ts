import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { store } from '../store';
import { isPreferencePageVisibleAtom } from '../atoms/ui';
import { prefWindowFocusRefreshAtom, syncDeniedForPlanAtom, errorCreditCheckAtom } from '../atoms/profile';

export const triggerProfileRefresh = () => Zotero.Beaver.account?.refresh(true);

/** Window visibility and explicit UI signals request the instance's single pipeline. */
export function useProfileSync() {
    const preferences = useAtomValue(isPreferencePageVisibleAtom);
    const focus = useAtomValue(prefWindowFocusRefreshAtom);
    const denied = useAtomValue(syncDeniedForPlanAtom);
    const credit = useAtomValue(errorCreditCheckAtom);
    useEffect(() => {
        if (preferences || focus || denied || credit) void triggerProfileRefresh();
        if (focus) store.set(prefWindowFocusRefreshAtom, false);
        if (denied) store.set(syncDeniedForPlanAtom, false);
        if (credit) store.set(errorCreditCheckAtom, false);
    }, [preferences, focus, denied, credit]);
    return { refreshProfile: (force = false) => Zotero.Beaver.account?.refresh(force) };
}
