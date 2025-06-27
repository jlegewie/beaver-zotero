import { useAtomValue, useSetAtom } from 'jotai';
import { fileStatusStatsAtom } from '../atoms/files';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { profileWithPlanAtom } from '../atoms/profile';
import { getPref, setPref } from '../../src/utils/prefs';
import { useEffect } from 'react';
import { logger } from '../../src/utils/logger';

export const useIndexingCompleteMessage = () => {
    const fileStats = useAtomValue(fileStatusStatsAtom);
    const addPopupMessage = useSetAtom(addPopupMessageAtom);
    const profileWithPlan = useAtomValue(profileWithPlanAtom);
    
    useEffect(() => {
        const showMessage = getPref("showIndexingCompleteMessage");
        if (showMessage && fileStats.progress >= 100 && fileStats.fileStatusAvailable) {
            logger("useIndexingCompleteMessage: Indexing complete message triggered");

            // Reset the preference immediately to prevent duplicate messages
            // setPref("showIndexingCompleteMessage", false);

            const skippedFiles = fileStats?.skippedProcessingCount + fileStats?.uploadSkippedCount;
            const failedFiles = fileStats?.failedProcessingCount + fileStats?.uploadFailedCount;

            // Add the indexing complete message
            const message = `We completed indexing ${fileStats.completedFiles.toLocaleString()} files for your ${profileWithPlan?.plan.name} plan.`;
            // if(failedFiles > 0) {
            //     message += ` ${failedFiles.toLocaleString()} files failed.`;
            // }
            // if(skippedFiles > 0) {
            //     message += ` ${skippedFiles.toLocaleString()} files were skipped.`;
            // }
            // if(profileWithPlan?.plan.name === "free" && fileStats.skippedProcessingCount > 0) {
            //     message += " You can upgrade your plan to process more files.";
            // }
            addPopupMessage({
                title: "File Indexing Complete",
                text: message,
                type: "indexing_complete",
                expire: false,
                fileStats: fileStats,
                planName: profileWithPlan?.plan.name
            });

        }
    }, [fileStats.progress, fileStats.fileStatusAvailable, profileWithPlan?.plan.name]);
};