import { useAtomValue, useSetAtom } from 'jotai';
import { fileStatusStatsAtom } from '../atoms/files';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { planNameAtom } from '../atoms/profile';
import { getPref, setPref } from '../../src/utils/prefs';
import { useEffect } from 'react';
import { logger } from '../../src/utils/logger';
import { store } from '../index';

export const useIndexingCompleteMessage = () => {
    const fileStats = useAtomValue(fileStatusStatsAtom);
    const addPopupMessage = useSetAtom(addPopupMessageAtom);
    
    useEffect(() => {
        const showMessage = getPref("showIndexingCompleteMessage");
        if (showMessage && fileStats.progress >= 100 && fileStats.fileStatusAvailable) {
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
                fileStats: fileStats,
                planName: planName
            });

        }
    }, [fileStats.progress, fileStats.fileStatusAvailable]);
};