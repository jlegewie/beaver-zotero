/**
 * Asks for the run-status tip the first time a run is live while the sidebar
 * is open: that is the moment the user could close the sidebar and see the
 * corner card, and the tip offers to. A run that starts with the sidebar
 * already closed needs no tip — the card itself is on screen. Whether now is
 * a good moment is `showFeatureTipAtom`'s call.
 */
import { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { isStreamingAtom } from '@beaver/agent-core/run-state/atoms';
import { isSidebarVisibleAtom } from '../atoms/ui';
import { runStatusPopupEnabledAtom } from '../atoms/runStatusPopup';
import { showFeatureTipAtom } from '../atoms/featureTips';

/** Long enough for the run to have started producing something on screen. */
const TIP_DELAY_MS = 1500;

export function useRunStatusTip(): void {
    const isStreaming = useAtomValue(isStreamingAtom);
    const isSidebarVisible = useAtomValue(isSidebarVisibleAtom);
    const popupEnabled = useAtomValue(runStatusPopupEnabledAtom);
    const showFeatureTip = useSetAtom(showFeatureTipAtom);
    const shownThisSessionRef = useRef(false);

    useEffect(() => {
        if (shownThisSessionRef.current) return;
        if (!isStreaming || !isSidebarVisible || !popupEnabled) return;
        const timer = setTimeout(() => {
            if (showFeatureTip('run-status-popup')) shownThisSessionRef.current = true;
        }, TIP_DELAY_MS);
        return () => clearTimeout(timer);
    }, [isStreaming, isSidebarVisible, popupEnabled, showFeatureTip]);
}
