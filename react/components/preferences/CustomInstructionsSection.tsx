import React, { useState } from "react";
import { SectionLabel } from "./components/SettingsElements";
import { getPref, setPref } from "../../../src/utils/prefs";
import { logger } from "../../../src/utils/logger";


const CustomInstructionsSection: React.FC = () => {

    // --- Atoms ---
    const [customInstructions, setCustomInstructions] = useState(() => getPref('customInstructions'));

    // --- Save Preferences ---
    const handlePrefSave = (key: "googleGenerativeAiApiKey" | "openAiApiKey" | "anthropicApiKey" | "customInstructions", value: string) => {
        if (value !== getPref(key)) {
            setPref(key, value);
            logger(`Saved pref ${key}`);
        }
    };

    // --- Custom Instructions Change Handler ---
    const handleCustomInstructionsChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newValue = event.target.value;
        setCustomInstructions(newValue);
        handlePrefSave('customInstructions', newValue);
    };


    return (
        <>
            <SectionLabel>Custom Instructions</SectionLabel>
            <div className="custom-prompt-card" style={{ cursor: 'default' }}>
                <div className="font-color-secondary text-text mb-2">
                    Custom instructions are added to all chats and help steer responses. (Max ~250 words)
                </div>
                <textarea
                    value={customInstructions}
                    onChange={handleCustomInstructionsChange}
                    placeholder="Enter custom instructions here..."
                    rows={5}
                    className="chat-input custom-prompt-edit-textarea text-base"
                    style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical' }}
                    maxLength={1500}
                />
            </div>
        </>
    );
};

export default CustomInstructionsSection;
