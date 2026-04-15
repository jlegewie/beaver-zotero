import React, { useState } from "react";
import { SectionLabel } from "./components/SettingsElements";
import { getPref, setPref } from "../../../src/utils/prefs";
import { logger } from "../../../src/utils/logger";


const CustomInstructionsSection: React.FC = () => {

    // --- Atoms ---
    const [customInstructions, setCustomInstructions] = useState(() => getPref('customInstructions'));
    const [readerExplainPrompt, setReaderExplainPrompt] = useState(() => getPref('readerExplainPrompt'));

    // --- Save Preferences ---
    const handlePrefSave = (key: "customInstructions" | "readerExplainPrompt", value: string) => {
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

    // --- Reader Explain Prompt Change Handler ---
    const handleReaderExplainPromptChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newValue = event.target.value;
        setReaderExplainPrompt(newValue);
        handlePrefSave('readerExplainPrompt', newValue);
    };


    return (
        <>
            <SectionLabel>Custom Instructions</SectionLabel>
            <div className="text-base font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                Custom instructions are added to all chats and help steer responses. (Max ~250 words)
            </div>
            <div className="custom-prompt-card" style={{ cursor: 'default' }}>
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

            <SectionLabel>Reader Explain Prompt</SectionLabel>
            <div className="text-base font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                The prompt sent when you click "Explain" on selected text or annotations in the PDF reader.
            </div>
            <div className="custom-prompt-card" style={{ cursor: 'default' }}>
                <textarea
                    value={readerExplainPrompt}
                    onChange={handleReaderExplainPromptChange}
                    placeholder="Explain the selected passage from this paper in plain language..."
                    rows={4}
                    className="chat-input custom-prompt-edit-textarea text-base"
                    style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical' }}
                    maxLength={1500}
                />
            </div>
        </>
    );
};

export default CustomInstructionsSection;
