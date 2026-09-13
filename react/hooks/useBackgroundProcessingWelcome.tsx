import React, { useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    accountGenerationAtom,
    cloudConsentAtom,
    hasOcrAccessAtom,
    hasSearchIndexAccessAtom,
    indexingPlanLabelAtom,
} from '../atoms/profile';
import { addFloatingPopupMessageAtom } from '../atoms/floatingPopup';
import BackgroundProcessingWelcomeContent from '../components/ui/popup/BackgroundProcessingWelcomeContent';

const POPUP_ID = 'background-processing-welcome';

export function useBackgroundProcessingWelcome(): void {
    const hasOcr = useAtomValue(hasOcrAccessAtom);
    const hasSearch = useAtomValue(hasSearchIndexAccessAtom);
    const label = useAtomValue(indexingPlanLabelAtom);
    const addPopup = useSetAtom(addFloatingPopupMessageAtom);
    const consent = useAtomValue(cloudConsentAtom);
    const generation = useAtomValue(accountGenerationAtom);

    useEffect(() => {
        if ((!hasSearch && !hasOcr) || consent !== 'pending') return;
        if (!Zotero.Beaver.background?.claimNotification('cloud-preparation-consent')) return;
        const reminder = false;
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
            title,
            expire: false,
            cancelable: false,
            customContent: (
                <BackgroundProcessingWelcomeContent
                    messageId={POPUP_ID}
                    reminder={reminder}
                    generation={generation}
                />
            ),
        });
    }, [addPopup, hasOcr, hasSearch, label, consent, generation]);
}
