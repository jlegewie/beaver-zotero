import { setPref } from "../../src/utils/prefs";
import { retrySkippedUploads } from '../../src/services/FileUploader';
import { logger } from "../../src/utils/logger";
import { SafeProfileWithPlan } from "../types/profile";
import { addPopupMessageAtom } from "./popupMessageUtils";
import { store } from "../index";

export const planTransitionMessage = async (profile: SafeProfileWithPlan) => {
    setPref("showIndexingCompleteMessage", true);
    
    // Re-attempt file uploads for previously skipped files (if plan allows)
    if (profile.plan.upload_files) {
        logger(`useProfileSync: Re-attempting file uploads for previously skipped files.`);
        await retrySkippedUploads();
    }

    // Message with plan change and processing status
    const title = `Welcome to the ${profile.plan.display_name} plan!`;
    let text = "We're indexing files up to your new plan's limit. Full search will be available once this is complete.";
    if (profile.plan.name === "pro") {
        text = "We're indexing your files to unlock all Pro features. Full search will be available shortly.";
    }
    store.set(addPopupMessageAtom, { 
        title, 
        text, 
        type: "plan_change", 
        expire: false
    });
}