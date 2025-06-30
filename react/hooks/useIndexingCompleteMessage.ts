import { useAtomValue, useSetAtom } from 'jotai';
import { fileStatusSummaryAtom } from '../atoms/files';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { planNameAtom } from '../atoms/profile';
import { getPref, setPref } from '../../src/utils/prefs';
import { useEffect } from 'react';
import { logger } from '../../src/utils/logger';
import { store } from '../index';

export const useIndexingCompleteMessage = () => {
    const fileStatusSummary = useAtomValue(fileStatusSummaryAtom);
    const addPopupMessage = useSetAtom(addPopupMessageAtom);
    
    useEffect(() => {
        const showMessage = getPref("showIndexingCompleteMessage");
        if (showMessage && fileStatusSummary.progress >= 100 && fileStatusSummary.fileStatusAvailable) {
            logger("useIndexingCompleteMessage: Indexing complete message triggered");
            const planName = store.get(planNameAtom);

            // Reset the preference immediately to prevent duplicate messages
            setPref("showIndexingCompleteMessage", false);

            // Add the indexing complete message
            const message = `We completed indexing your files for the ${planName} plan.`;

            addPopupMessage({
                title: "File Indexing Complete",
                text: message,
                type: "indexing_complete",
                expire: false,
                fileStatusSummary: fileStatusSummary,
                planName: planName
            });

        }
    }, [fileStatusSummary.progress, fileStatusSummary.fileStatusAvailable]);
};