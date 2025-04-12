import React from "react";
// @ts-ignore no idea
import { useState, useCallback } from "react";
import { useAtom } from 'jotai';
import { userAtom } from '../atoms/auth';
import { getPref, setPref } from '../../src/utils/prefs';
import { UserIcon, LogoutIcon, LinkIcon } from './icons';
import IconButton from "./IconButton";
import Button from "./button";
import { supabase } from "../../src/services/supabaseClient";
// Assuming basic checkbox/input elements for now. Replace with custom components if available.

// Helper function for preference keys (adjust type as needed for your prefs)
// type PrefKey = Zotero.PluginPrefsSchema;
// const prefKey = <K extends PrefKey>(key: K) => key;

const SectionHeader: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <h2 className="text-xl font-semibold mt-6 mb-2 font-color-primary">
        {children}
    </h2>
);

// --- Quick Prompt Type and Initial State ---
type QuickPrompt = {
    text: string;
    librarySearch: boolean;
    requiresAttachment: boolean;
};

function getInitialQuickPrompts(): QuickPrompt[] {
    const prompts: QuickPrompt[] = [];
    for (let i = 1; i <= 6; i++) {
        prompts.push({
            // @ts-ignore correct type
            text: getPref(`quickPrompt${i}_text`) ?? '',
            // @ts-ignore correct type
            librarySearch: getPref(`quickPrompt${i}_librarySearch`) ?? false,
            // @ts-ignore correct type
            requiresAttachment: getPref(`quickPrompt${i}_requiresAttachment`) ?? false,
        });
    }
    return prompts;
}

// --- Single Quick Prompt Settings Component ---
interface QuickPromptSettingsProps {
    index: number;
    prompt: QuickPrompt;
    onChange: (index: number, updatedPrompt: QuickPrompt) => void;
}

const QuickPromptSettings: React.FC<QuickPromptSettingsProps> = ({ index, prompt, onChange }) => {
    const [text, setText] = useState(prompt.text);

    const handleTextChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        setText(event.target.value);
    };

    const handleTextBlur = () => {
        if (text !== prompt.text) {
            const updated = { ...prompt, text };
            onChange(index, updated);
            const idx = index + 1;
            if (idx >= 1 && idx <= 6) {
                // const pref = `quickPrompt${idx}_text`;
                const pref = `quickPrompt1_text`;
                setPref(pref, text);
            }
        }
    };

    const handleCheckboxChange = (field: keyof QuickPrompt) => (event: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = event.target.checked;
        const updated = { ...prompt, [field]: newValue };
        onChange(index, updated);
        const idx = index + 1;
        if (idx >= 1 && idx <= 6) {
            const pref = `quickPrompt${idx}_${field}`;
            // @ts-ignore correct type
            setPref(pref, newValue);
        }
    };

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-row gap-3 items-center">
                <label className="font-semibold text-sm font-color-primary">
                    Quick Prompt
                </label>
                <label className="font-semibold text-sm font-color-secondary">⌘{index + 1}</label>
            </div>
            <textarea
                value={text}
                onChange={handleTextChange}
                onBlur={handleTextBlur}
                placeholder={`Enter prompt text for ⌘${index + 1}...`}
                rows={2}
                className="w-full p-1 border rounded-sm border-quinary bg-senary focus:border-tertiary outline-none resize-y text-sm"
            />
            <div className="flex flex-row gap-4 items-center">
                <label className={`flex items-center gap-05 text-sm ${prompt.librarySearch ? 'font-primary' : 'font-color-secondary'} cursor-pointer`}>
                    <input
                        type="checkbox"
                        checked={prompt.librarySearch}
                        onChange={handleCheckboxChange('librarySearch')}
                        className="scale-90" // Adjust scale/style as needed
                    />
                    Library Search
                </label>
                <label className={`flex items-center gap-05 text-sm ${prompt.requiresAttachment ? 'font-primary' : 'font-color-secondary'} cursor-pointer`}>
                    <input
                        type="checkbox"
                        checked={prompt.requiresAttachment}
                        onChange={handleCheckboxChange('requiresAttachment')}
                        className="scale-90"
                    />
                    Requires Attachment
                </label>
            </div>
        </div>
    );
};

interface ApiKeyInputProps {
    id: string;
    label: string;
    linkUrl?: string;  // Optional URL for the link button
    value: string;
    onChange: (value: string) => void;
    onBlur: () => void;
    placeholder?: string;
    className?: string;
}

const ApiKeyInput: React.FC<ApiKeyInputProps> = ({
    id,
    label,
    linkUrl,
    value,
    onChange,
    onBlur,
    placeholder = "Enter your API Key",
    className = ""
}) => {
    return (
        <div className={`flex flex-col items-start gap-1 mt-1 mb-1 ${className}`}>
            <div className="flex flex-row items-start gap-1 flex-1 w-full">
                <label htmlFor={id} className="text-sm font-semibold font-color-primary">{label}</label>
                {linkUrl && (
                    <IconButton
                        variant="ghost-secondary"
                        icon={LinkIcon}
                        onClick={() => Zotero.getActiveZoteroPane().loadURI(linkUrl)}
                        className="scale-11 p-0"
                        ariaLabel="Read more"
                    />
                )}
            </div>
            <div className="flex flex-row items-start gap-2 mt-1 mb-1 flex-1 w-full">
                <input
                    id={id}
                    type="password"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    onBlur={onBlur}
                    placeholder={placeholder}
                    className="flex-1 p-1 m-0 border text-sm rounded-sm border-quinary bg-senary focus:border-tertiary outline-none"
                />
            </div>
        </div>
    );
};

// --- Main Preference Page Component ---
const PreferencePage: React.FC = () => {
    const [user] = useAtom(userAtom);

    // --- State for Preferences ---
    const [geminiKey, setGeminiKey] = useState(() => getPref('googleGenerativeAiApiKey'));
    const [openaiKey, setOpenaiKey] = useState(() => getPref('openAiApiKey'));
    const [anthropicKey, setAnthropicKey] = useState(() => getPref('anthropicApiKey'));
    const [customInstructions, setCustomInstructions] = useState(() => getPref('customInstructions'));
    const [quickPrompts, setQuickPrompts] = useState<QuickPrompt[]>(getInitialQuickPrompts);

    // --- Save Preferences onBlur ---
    // const handlePrefBlur = <K extends PrefKey>(key: K, value: Zotero.PluginPrefsSchemaMap[K]) => {
    const handlePrefBlur = (key: "googleGenerativeAiApiKey" | "openAiApiKey" | "anthropicApiKey" | "customInstructions", value: string) => {
        // Only save if the value actually changed from the stored pref
        if (value !== getPref(key)) {
            setPref(key, value);
            console.log(`Saved pref ${key}`);
        }
    };

    const handleCustomInstructionsChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        // TODO: Add word limit check if needed visually
        setCustomInstructions(event.target.value);
    };

    // --- Quick Prompt Change Handler ---
    const handleQuickPromptChange = useCallback((index: number, updatedPrompt: QuickPrompt) => {
        setQuickPrompts((currentPrompts: any) => {
            const newPrompts = [...currentPrompts];
            newPrompts[index] = updatedPrompt;
            return newPrompts;
        });
        // Note: Individual pref saving is handled within QuickPromptSettings component
    }, []);

    const handleLogout = () => {
        supabase.auth.signOut();
    };

    return (
        <div
            id="beaver-preferences"
            className="flex flex-col flex-1 min-h-0 overflow-y-auto gap-2 scrollbar min-w-0 p-4"
        >
            <h1 className="text-2xl font-semibold  font-color-primary" style={{ marginBlock: "0rem" }}>
                Settings
            </h1>
            {/* --- Account Section --- */}
            <SectionHeader>Account</SectionHeader>
            {user ? (
                <div className="flex flex-col gap-3">
                    <div className="flex flex-row items-center gap-4">
                        <span className="font-color-secondary">Signed in as:</span>
                        <span className="font-semibold font-color-primary">{user.email}</span>
                    </div>
                    <div className="flex flex-row items-center gap-3">
                        <Button variant="outline" icon={UserIcon} onClick={() => Zotero.getActiveZoteroPane().loadURI('https://beaver.org/account')}>Manage Account</Button> {/* Example: Open web page */}
                        <Button variant="outline" icon={LogoutIcon} onClick={handleLogout}>Logout</Button>
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
                Providing your own API keys removes rate limits and allows you to select better models like Gemini 2.5 Pro, Claude 3.7 or Open AI 4o.
                When enabled, Beaver will use your API keys to generate responses and use our own keys as a fallback.
                Your keys are only stored locally and never on our server.
                {' '}
                <a
                    href="#"
                    className="font-color-tertiary hover:underline"
                    onClick={(e) => {e.preventDefault(); Zotero.getActiveZoteroPane().loadURI('https://beaver.org/docs/api-keys');}}
                >
                    Read more.
                </a>
            </div>
            <div className="flex flex-col gap-3">
                <ApiKeyInput
                    id="gemini-key"
                    label="Google API Key"
                    value={geminiKey}
                    onChange={setGeminiKey}
                    onBlur={() => handlePrefBlur('googleGenerativeAiApiKey', geminiKey)}
                    placeholder="Enter your Google AI Studio API Key"
                    linkUrl="https://aistudio.google.com/app/apikey"
                />
                <ApiKeyInput
                    id="openai-key"
                    label="OpenAI API Key"
                    value={openaiKey}
                    onChange={setOpenaiKey}
                    onBlur={() => handlePrefBlur('openAiApiKey', openaiKey)}
                    placeholder="Enter your OpenAI API Key"
                    linkUrl="https://platform.openai.com/api-keys"
                />
                <ApiKeyInput
                    id="anthropic-key"
                    label="Anthropic API Key"
                    value={anthropicKey}
                    onChange={setAnthropicKey}
                    onBlur={() => handlePrefBlur('anthropicApiKey', anthropicKey)}
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
                onBlur={() => handlePrefBlur('customInstructions', customInstructions)}
                placeholder="Enter custom instructions here..."
                rows={5}
                className="p-2 border rounded-sm border-quinary bg-senary focus:border-tertiary outline-none resize-y text-sm"
                maxLength={1500}
            />
            {/* TODO: Add word/char counter */}

            {/* --- Quick Prompts Section --- */}
            <SectionHeader>Quick Prompts</SectionHeader>
            <div className="text-sm font-color-secondary mb-2">
                Configure up to 6 quick prompts with keyboard shortcuts (⌘1-⌘6). Enable library search or set conditions based on attachments.
            </div>
            <div className="flex flex-col gap-5">
                {quickPrompts.map((prompt: QuickPrompt, index: number) => (
                    <QuickPromptSettings
                        key={index}
                        index={index}
                        prompt={prompt}
                        onChange={handleQuickPromptChange}
                    />
                ))}
            </div>

            {/* Spacer at the bottom */}
            <div style={{ height: "20px" }} />
        </div>
    );
};

export default PreferencePage;