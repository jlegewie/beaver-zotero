import { useAtomValue, useSetAtom } from 'jotai';
import { calculateFileStatusSummary } from '../atoms/files';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { planNameAtom } from '../atoms/profile';
import { getPref, setPref } from '../../src/utils/prefs';
import { useEffect } from 'react';
import { logger } from '../../src/utils/logger';
import { store } from '../store';
import { userIdAtom } from '../atoms/auth';
import { fetchFileStatus } from './useFileStatus';

export const useIndexingCompleteMessage = () => {
    const addPopupMessage = useSetAtom(addPopupMessageAtom);
    const userId = useAtomValue(userIdAtom);

    useEffect(() => {
        const showMessage = getPref("showIndexingCompleteMessage");
        if (!showMessage || !userId) return;

        // Fetch file status directly instead of relying on realtime subscription
        fetchFileStatus(userId).then((fileStatus) => {
            const fileStatusSummary = calculateFileStatusSummary(fileStatus);
            if (fileStatusSummary.progress >= 100 && fileStatusSummary.fileStatusAvailable) {
                logger("useIndexingCompleteMessage: Indexing complete message triggered");
                const planName = store.get(planNameAtom);

                // Reset the preference immediately to prevent duplicate messages
                setPref("showIndexingCompleteMessage", false);

                // Add the indexing complete message
                const message = `We completed indexing your files. You can now use all of Beaver's features to search, chat with, and explore your research library.`;

                addPopupMessage({
                    title: "Your library is ready!",
                    text: message,
                    type: "indexing_complete",
                    expire: false,
                    fileStatusSummary: fileStatusSummary,
                    planName: planName
                });
            }
        });
    }, [userId]);
};