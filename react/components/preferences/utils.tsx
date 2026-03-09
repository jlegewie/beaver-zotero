import { getPref } from "../../../src/utils/prefs";
import { setPref } from "../../../src/utils/prefs";
import { logger } from "../../../src/utils/logger";

// --- Save Preferences ---
export const handlePrefSave = (key: "googleGenerativeAiApiKey" | "openAiApiKey" | "anthropicApiKey" | "customInstructions", value: string) => {
    if (value !== getPref(key)) {
        setPref(key, value);
        logger(`Saved pref ${key}`);
    }
};