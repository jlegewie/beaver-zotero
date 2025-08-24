import React from "react";
import { setPref } from "../../src/utils/prefs";
import { logger } from "../../src/utils/logger";
import { SafeProfileWithPlan } from "../types/profile";
import { addPopupMessageAtom } from "./popupMessageUtils";
import { store } from "../store";
import { fileStatusSummaryAtom, calculateFileStatusSummary } from "../atoms/files";
import { fetchFileStatus } from "../hooks/useFileStatus";
import { Icon, PuzzleIcon } from "../components/icons/icons";

export const planTransitionMessage = async (profile: SafeProfileWithPlan) => {

    // Don't show messages if onboarding is not complete
    if (!profile.has_completed_onboarding) {
        return;
    }

    // Status of file processing (if not available, fetch it)
    let fileStatusSummary = store.get(fileStatusSummaryAtom);
    if (!fileStatusSummary.fileStatusAvailable) {
        logger(`planTransitionMessage: File status summary not available, fetching...`);
        const fileStatus = await fetchFileStatus(profile.user_id);
        fileStatusSummary = calculateFileStatusSummary(fileStatus, profile.plan.processing_tier);
    }
    const {totalFiles, progress} = fileStatusSummary;

    // Message: Plan change and processing status
    const title = `Welcome to the ${profile.plan.display_name} plan!`;
    if (totalFiles > 0 && progress < 100) {
        setPref("showIndexingCompleteMessage", true);
        const text = "We're processing your files for the new plan. Full text search will be available once this is complete. You can view the processing status under 'File Status'.";
        store.set(addPopupMessageAtom, { 
            title, 
            text, 
            type: "info",
            icon: React.createElement(Icon, { 
                icon: PuzzleIcon, 
                className: "scale-12 mt-020 font-color-secondary" 
            }),
            showProgress: true,
            expire: false,
            showGoToFileStatusButton: true
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
            text: "There are no files to process for full-text search. You can add files to your library to start indexing.",
            type: "info",
            icon: React.createElement(Icon, { 
                icon: PuzzleIcon, 
                className: "scale-12 mt-020 font-color-secondary" 
            }),
            showProgress: false,
            expire: false
        });
    }
}