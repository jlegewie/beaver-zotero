import { setPref } from "../../src/utils/prefs";
import { retrySkippedUploads } from '../../src/services/FileUploader';
import { logger } from "../../src/utils/logger";
import { SafeProfileWithPlan } from "../types/profile";
import { addPopupMessageAtom } from "./popupMessageUtils";
import { store } from "../index";
import { fileStatusSummaryAtom, calculateFileStatusSummary } from "../atoms/files";
import { fetchFileStatus } from "../hooks/useFileStatus";

export const planTransitionMessage = async (profile: SafeProfileWithPlan) => {

    // Status of file processing (if not available, fetch it)
    let fileStatusSummary = store.get(fileStatusSummaryAtom);
    if (!fileStatusSummary.fileStatusAvailable) {
        logger(`planTransitionMessage: File status summary not available, fetching...`);
        const fileStatus = await fetchFileStatus(profile.user_id);
        fileStatusSummary = calculateFileStatusSummary(fileStatus, profile.plan.processing_tier);
    }
    const {totalFiles, progress} = fileStatusSummary;

    // Re-attempt file uploads for previously skipped files (if plan allows)
    if (profile.plan.upload_files) {
        logger(`useProfileSync: Re-attempting file uploads for previously skipped files.`);
        await retrySkippedUploads();
    }

    // Message: Plan change and processing status
    const title = `Welcome to the ${profile.plan.display_name} plan!`;
    if (totalFiles > 0 && progress < 100) {
        setPref("showIndexingCompleteMessage", true);
        let text = "We're indexing files up to your new plan's limit. Full search will be available once this is complete.";
        if (profile.plan.name === "pro") {
            text = "We're indexing your files to unlock all Pro features. Full search will be available shortly.";
        }
        store.set(addPopupMessageAtom, { 
            title, 
            text, 
            type: "plan_change",
            showProgress: true,
            expire: false
        });
    }

    // Message: Indexing complete
    if (totalFiles > 0 && progress >= 100) {
        setPref("showIndexingCompleteMessage", false);
        store.set(addPopupMessageAtom, { 
            title, 
            text: "Your files are already fully indexed and ready to search.",
            fileStatusSummary: fileStatusSummary,
            type: "indexing_complete",
            expire: false,
            planName: profile.plan.name
        });
    }

    if (totalFiles === 0) {
        setPref("showIndexingCompleteMessage", false);
        store.set(addPopupMessageAtom, { 
            title, 
            text: "No files to index. You can add files to your library to start indexing.",
            type: "plan_change",
            showProgress: false,
            expire: false
        });
    }
}