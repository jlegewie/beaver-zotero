import React, { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    hasOcrAccessAtom,
    hasSearchIndexAccessAtom,
    indexingPlanLabelAtom,
} from '../atoms/profile';
import { addFloatingPopupMessageAtom } from '../atoms/floatingPopup';
import { getPref } from '../../src/utils/prefs';
import BackgroundProcessingWelcomeContent from '../components/ui/popup/BackgroundProcessingWelcomeContent';

const POPUP_ID = 'background-processing-welcome';

export function useBackgroundProcessingWelcome(): void {
    const hasOcr = useAtomValue(hasOcrAccessAtom);
    const hasSearch = useAtomValue(hasSearchIndexAccessAtom);
    const label = useAtomValue(indexingPlanLabelAtom);
    const addPopup = useSetAtom(addFloatingPopupMessageAtom);
    const shown = useRef(false);

    useEffect(() => {
        if (shown.current || (!hasOcr && !hasSearch)) return;
        if (getPref('backgroundProcessingEnabled') === true) return;
        if (getPref('backgroundProcessingWelcomeAck') === true) return;
        shown.current = true;
        const reminder = getPref('backgroundProcessingWelcomeDeferred') === true;
        const title = reminder
            ? 'Keep document search up to date'
            : label === 'pro'
                ? 'Welcome to Beaver Pro'
                : label === 'search'
                    ? 'Welcome to Beaver Search'
                    : 'Background processing is now available';
        addPopup({
            id: POPUP_ID,
            type: 'info',
            expire: false,
            cancelable: false,
            customContent: (
                <BackgroundProcessingWelcomeContent
                    messageId={POPUP_ID}
                    title={title}
                    reminder={reminder}
                />
            ),
        });
    }, [addPopup, hasOcr, hasSearch, label]);
}

