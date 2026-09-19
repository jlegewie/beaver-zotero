import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { store } from '../store';
import { isBeaverUIVisibleAtom, isPreferencePageVisibleAtom } from '../atoms/ui';
import { prefWindowFocusRefreshAtom, syncDeniedForPlanAtom, errorCreditCheckAtom } from '../atoms/profile';
import { tryGetWindowRuntime } from '../runtime/windowRuntime';

export const triggerProfileRefresh = () => Zotero.Beaver.account?.refresh(true);

/**
 * Report whether this renderer shows Beaver, so the instance account can refresh
 * the profile often while Beaver is in use and rarely while it is hidden.
 */
export function useReportBeaverUIVisibility() {
    const visible = useAtomValue(isBeaverUIVisibleAtom);
    useEffect(() => {
        const key = tryGetWindowRuntime()?.id;
        const account = Zotero.Beaver.account;
        if (!key || !account) return;
        account.setUIVisible(key, visible);
        return () => account.setUIVisible(key, false);
    }, [visible]);
}

/** Window visibility and explicit UI signals request the instance's single pipeline. */
export function useProfileSync() {
    useReportBeaverUIVisibility();

    const preferences = useAtomValue(isPreferencePageVisibleAtom);
    useEffect(() => {
        if (preferences) void triggerProfileRefresh();
    }, [preferences]);

    // One-shot signals: clearing a flag re-runs this effect with every flag false,
    // so each signal requests exactly one refresh.
    const focus = useAtomValue(prefWindowFocusRefreshAtom);
    const denied = useAtomValue(syncDeniedForPlanAtom);
    const credit = useAtomValue(errorCreditCheckAtom);
    useEffect(() => {
        if (!focus && !denied && !credit) return;
        if (focus) store.set(prefWindowFocusRefreshAtom, false);
        if (denied) store.set(syncDeniedForPlanAtom, false);
        if (credit) store.set(errorCreditCheckAtom, false);
        void triggerProfileRefresh();
    }, [focus, denied, credit]);

    return { refreshProfile: (force = false) => Zotero.Beaver.account?.refresh(force) };
}
