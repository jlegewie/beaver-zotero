import React, { useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    accountGenerationAtom,
    cloudBetaAtom,
    cloudConsentAtom,
    cloudProductNameAtom,
    hasOcrAccessAtom,
    hasSearchIndexAccessAtom,
} from '../atoms/profile';
import { addFloatingPopupMessageAtom, removeFloatingPopupMessageAtom } from '../atoms/floatingPopup';
import BackgroundProcessingWelcomeContent from '../components/ui/popup/BackgroundProcessingWelcomeContent';

const POPUP_ID = 'background-processing-welcome';

export function useBackgroundProcessingWelcome(): void {
    const hasOcr = useAtomValue(hasOcrAccessAtom);
    const hasSearch = useAtomValue(hasSearchIndexAccessAtom);
    const productName = useAtomValue(cloudProductNameAtom);
    const beta = useAtomValue(cloudBetaAtom);
    const addPopup = useSetAtom(addFloatingPopupMessageAtom);
    const removePopup = useSetAtom(removeFloatingPopupMessageAtom);
    const consent = useAtomValue(cloudConsentAtom);
    const generation = useAtomValue(accountGenerationAtom);

    useEffect(() => {
        if ((!hasSearch && !hasOcr) || consent !== 'pending') {
            removePopup(POPUP_ID);
            return;
        }
        if (!Zotero.Beaver.background?.claimNotification('cloud-preparation-consent')) return;
        addPopup({
            id: POPUP_ID,
            type: 'cloud_consent',
            title: `Welcome to ${productName}`,
            expire: false,
            cancelable: false,
            customContent: (
                <BackgroundProcessingWelcomeContent
                    messageId={POPUP_ID}
                    productName={productName}
                    beta={beta}
                    generation={generation}
                />
            ),
        });
    }, [addPopup, removePopup, hasOcr, hasSearch, productName, beta, consent, generation]);
}
