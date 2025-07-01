import React, { useState, useCallback } from "react";
import { useAtom, useAtomValue } from 'jotai';
import { logoutAtom, userAtom } from '../../atoms/auth';
import { getPref, setPref } from '../../../src/utils/prefs';
import { UserIcon, LogoutIcon } from '../icons/icons';
import Button from "../ui/Button";
import { useSetAtom } from 'jotai';
import { profileWithPlanAtom } from "../../atoms/profile";
import { logger } from "../../../src/utils/logger";
import { getCustomPromptsFromPreferences, CustomPrompt } from "../../types/settings";
import ApiKeyInput from "../preferences/ApiKeyInput";
import CustomPromptSettings from "../preferences/CustomPromptSettings";

const SectionHeader: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <h2 className="text-xl font-semibold mt-6 mb-2 font-color-primary">
        {children}
    </h2>
);

const PreferencePage: React.FC = () => {
    const [user] = useAtom(userAtom);
    const logout = useSetAtom(logoutAtom);

    // --- State for Preferences ---
    const [geminiKey, setGeminiKey] = useState(() => getPref('googleGenerativeAiApiKey'));
    const [openaiKey, setOpenaiKey] = useState(() => getPref('openAiApiKey'));
    const [anthropicKey, setAnthropicKey] = useState(() => getPref('anthropicApiKey'));
    const [customInstructions, setCustomInstructions] = useState(() => getPref('customInstructions'));
    const [customPrompts, setCustomPrompts] = useState<CustomPrompt[]>(getCustomPromptsFromPreferences());
    const profileWithPlan = useAtomValue(profileWithPlanAtom);

    // Helper function to save custom prompts array to preferences
    const saveCustomPromptsToPrefs = useCallback((prompts: CustomPrompt[]) => {
        // Remove the index field before saving since it's derived from array position
        const promptsToSave = prompts.map(({ index, ...prompt }) => prompt);
        const promptsJson = JSON.stringify(promptsToSave);
        setPref('customPrompts', promptsJson);
        logger('Saved custom prompts to preferences');
    }, []);

    // --- Save Preferences ---
    const handlePrefSave = (key: "googleGenerativeAiApiKey" | "openAiApiKey" | "anthropicApiKey" | "customInstructions", value: string) => {
        if (value !== getPref(key)) {
            setPref(key, value);
            logger(`Saved pref ${key}`);
        }
    };

    const handleCustomInstructionsChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newValue = event.target.value;
        setCustomInstructions(newValue);
        handlePrefSave('customInstructions', newValue);
    };

    // --- Custom Prompt Change Handler ---
    const handleCustomPromptChange = useCallback((index: number, updatedPrompt: CustomPrompt) => {
        setCustomPrompts((currentPrompts) => {
            const newPrompts = [...currentPrompts];
            newPrompts[index] = updatedPrompt;
            
            // Save to preferences
            saveCustomPromptsToPrefs(newPrompts);
            
            return newPrompts;
        });
    }, [saveCustomPromptsToPrefs]);

    // --- Add Prompt Handler ---
    const handleAddPrompt = useCallback(() => {
        if (customPrompts.length >= 9) return; // Safety check
        
        const newPrompt: CustomPrompt = {
            title: "",
            text: "",
            librarySearch: false,
            requiresAttachment: false
        };
        
        setCustomPrompts((currentPrompts) => {
            const newPrompts = [...currentPrompts, newPrompt];
            saveCustomPromptsToPrefs(newPrompts);
            return newPrompts;
        });
    }, [customPrompts.length, saveCustomPromptsToPrefs]);

    // --- Remove Prompt Handler ---
    const handleRemovePrompt = useCallback((indexToRemove: number) => {
        setCustomPrompts((currentPrompts) => {
            const newPrompts = currentPrompts.filter((_, filterIndex) => filterIndex !== indexToRemove);
            saveCustomPromptsToPrefs(newPrompts);
            return newPrompts;
        });
    }, [saveCustomPromptsToPrefs]);

    return (
        <div
            id="beaver-preferences"
            className="display-flex flex-col flex-1 min-h-0 overflow-y-auto gap-2 scrollbar min-w-0 p-4"
        >
            <div className="display-flex flex-row items-center gap-4 justify-between">
                <h1 className="text-2xl font-semibold  font-color-primary" style={{ marginBlock: "0rem" }}>
                    Settings
                </h1>
                {/* <Button variant="outline" rightIcon={CancelIcon} onClick={() => togglePreferencePage((prev) => !prev)} className="mt-1">Close</Button> */}
            </div>
            {/* --- Account Section --- */}
            <SectionHeader>Account</SectionHeader>
            {user ? (
                <div className="display-flex flex-col gap-3">
                    <div className="display-flex flex-row items-center gap-2">
                        <span className="font-color-secondary">Signed in as:</span>
                        <span className="font-semibold font-color-primary">{user.email}</span>
                    </div>
                    <div className="display-flex flex-row items-center gap-2">
                        <span className="font-color-secondary">Plan:</span>
                        <span className="font-semibold font-color-primary">{profileWithPlan?.plan.display_name || 'Unknown'}</span>
                    </div>
                    <div className="display-flex flex-row items-center gap-3 mt-2">
                        <Button variant="outline" disabled={true} icon={UserIcon} onClick={() => Zotero.getActiveZoteroPane().loadURI('https://beaver.org/account')}>Manage Account</Button> {/* Example: Open web page */}
                        <Button variant="outline" icon={LogoutIcon} onClick={logout}>Logout</Button>
                    </div>
                </div>
            ) : (
                <div className="card p-3">
                     <span className="font-color-secondary">You are not signed in.</span>
                </div>
            )}

            {/* --- API Keys Section --- */}
            <SectionHeader>API Keys</SectionHeader>
            <div className="text-sm font-color-secondary mb-3">
                Add your own API key to use better models like Gemini 2.5 Pro, Claude 3.7 or Open AI 4o. Your keys are only stored locally and never on our server.
                {' '}
                <a
                    href="#"
                    className="font-color-tertiary hover:underline"
                    onClick={(e) => {e.preventDefault(); Zotero.getActiveZoteroPane().loadURI('https://beaver.org/docs/api-keys');}}
                >
                    Read more.
                </a>
            </div>
            <div className="display-flex flex-col gap-3">
                <ApiKeyInput
                    id="gemini-key"
                    label="Google API Key"
                    provider="google"
                    value={geminiKey}
                    onChange={setGeminiKey}
                    savePref={(newValue) => handlePrefSave('googleGenerativeAiApiKey', newValue)}
                    placeholder="Enter your Google AI Studio API Key"
                    linkUrl="https://aistudio.google.com/app/apikey"
                />
                <ApiKeyInput
                    id="openai-key"
                    label="OpenAI API Key"
                    provider="openai"
                    value={openaiKey}
                    onChange={setOpenaiKey}
                    savePref={(newValue) => handlePrefSave('openAiApiKey', newValue)}
                    placeholder="Enter your OpenAI API Key"
                    linkUrl="https://platform.openai.com/api-keys"
                />
                <ApiKeyInput
                    id="anthropic-key"
                    label="Anthropic API Key"
                    provider="anthropic"
                    value={anthropicKey}
                    onChange={setAnthropicKey}
                    savePref={(newValue) => handlePrefSave('anthropicApiKey', newValue)}
                    placeholder="Enter your Anthropic API Key"
                    linkUrl="https://console.anthropic.com/settings/keys"
                />
            </div>

            {/* --- Custom Instructions Section --- */}
            <SectionHeader>Custom Instructions</SectionHeader>
            <div className="text-sm font-color-secondary mb-2">
                Custom instructions are added to all chats and help steer responses based on your preferences. (Max ~250 words)
            </div>
            <textarea
                value={customInstructions}
                onChange={handleCustomInstructionsChange}
                placeholder="Enter custom instructions here..."
                rows={5}
                className="p-2 border rounded-sm border-quinary bg-senary focus:border-tertiary outline-none resize-y text-sm"
                maxLength={1500}
            />
            {/* TODO: Add word/char counter */}

            {/* --- Custom Prompts Section --- */}
            <SectionHeader>Custom Prompts</SectionHeader>
            <div className="text-sm font-color-secondary mb-2">
                Configure up to 9 custom prompts with keyboard shortcuts (⌘1-⌘9). Enable library search or set conditions based on attachments.
            </div>
            <div className="display-flex flex-col gap-5">
                {customPrompts.map((prompt: CustomPrompt, index: number) => (
                    <CustomPromptSettings
                        key={index}
                        index={index}
                        prompt={prompt}
                        onChange={handleCustomPromptChange}
                        onRemove={handleRemovePrompt}
                    />
                ))}
                
                {/* Add Prompt Button */}
                <div className="display-flex flex-row items-center justify-start">
                    <Button
                        variant="outline"
                        onClick={handleAddPrompt}
                        disabled={customPrompts.length >= 9}
                        className="text-sm"
                    >
                        Add Prompt
                    </Button>
                </div>
            </div>

            {/* Spacer at the bottom */}
            <div style={{ height: "20px" }} />
        </div>
    );
};

export default PreferencePage;