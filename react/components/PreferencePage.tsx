import React from "react";
// @ts-ignore no idea
import { useState, useCallback, useEffect } from "react";
import { useAtom } from 'jotai';
import { userAtom } from '../atoms/auth';
import { getPref, setPref } from '../../src/utils/prefs';
import { UserIcon, LogoutIcon, LinkIcon, CancelIcon, ArrowRightIcon, Spinner, TickIcon, AlertIcon } from './icons';
import IconButton from "./IconButton";
import Button from "./button";
import { supabase } from "../../src/services/supabaseClient";
import { isPreferencePageVisibleAtom } from '../atoms/ui';
import { useSetAtom } from 'jotai';
import { chatService, ProviderType, ErrorType } from '../../src/services/chatService';

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
export type QuickPrompt = {
    index?: number;
    title: string;
    text: string;
    librarySearch: boolean;
    requiresAttachment: boolean;
};

function getInitialQuickPrompts(): QuickPrompt[] {
    const prompts: QuickPrompt[] = [];
    for (let i = 1; i <= 6; i++) {
        prompts.push({
            // @ts-ignore correct type
            title: getPref(`quickPrompt${i}_title`) ?? '',
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
    const [title, setTitle] = useState(prompt.title);

    const handleTextChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newValue = event.target.value;
        setText(newValue);

        if (newValue !== prompt.text) {
            const updated = { ...prompt, text: newValue };
            onChange(index, updated);
            const idx = index + 1;
            if (idx >= 1 && idx <= 6) {
                const pref = `quickPrompt${idx}_text`;
                // @ts-ignore correct pref key
                setPref(pref, newValue);
            }
        }
    };

    const handleTitleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = event.target.value;
        setTitle(newValue);

        if (newValue !== prompt.title) {
            const updated = { ...prompt, title: newValue };
            onChange(index, updated);
            const idx = index + 1;
            if (idx >= 1 && idx <= 6) {
                const pref = `quickPrompt${idx}_title`;
                // @ts-ignore correct pref key
                setPref(pref, newValue);
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
            <div className="flex flex-row gap-2 items-center">
                <label className="text-sm font-color-secondary">Title</label>
                <input
                    type="text"
                    value={title}
                    onChange={handleTitleChange}
                    placeholder={`Enter title for ⌘${index + 1}...`}
                    className="flex-1 p-1 m-0 border text-sm rounded-sm border-quinary bg-senary focus:border-tertiary outline-none"
                />
            </div>
            <textarea
                value={text}
                onChange={handleTextChange}
                placeholder={`Enter prompt text for ⌘${index + 1}...`}
                rows={2}
                className="flex-1 p-1 border rounded-sm border-quinary bg-senary focus:border-tertiary outline-none resize-y text-sm"
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
    provider: ProviderType;
    linkUrl?: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    className?: string;
    savePref: (value: string) => void;
}

const ApiKeyInput: React.FC<ApiKeyInputProps> = ({
    id,
    label,
    provider,
    linkUrl,
    value,
    onChange,
    placeholder = "Enter your API Key",
    className = "",
    savePref
}) => {
    const [isVerifying, setIsVerifying] = useState(false);
    const [verificationStatus, setVerificationStatus] = useState<'idle' | 'success' | 'error'>('idle');
    const [verificationError, setVerificationError] = useState<ErrorType | null>(null);
    const [currentValue, setCurrentValue] = useState(value);

    useEffect(() => {
        setCurrentValue(value);
        setVerificationStatus('idle');
        setVerificationError(null);
    }, [value]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = e.target.value;
        setCurrentValue(newValue);
        onChange(newValue);
        if (newValue === '') {
            savePref(newValue);
        }
        if (verificationStatus !== 'idle') {
            setVerificationStatus('idle');
            setVerificationError(null);
        }
    };

    const handleVerify = async () => {
        setIsVerifying(true);
        setVerificationStatus('idle');
        setVerificationError(null);

        try {
            const result = await chatService.verifyApiKey(provider, currentValue);
            if (result.valid) {
                setVerificationStatus('success');
                savePref(currentValue);
                console.log(`API Key for ${provider} verified and saved.`);
            } else {
                setVerificationStatus('error');
                setVerificationError(result.error_type || 'UnexpectedError');
                console.error(`API Key verification failed for ${provider}: ${result.error_type}`);
            }
        } catch (error) {
            console.error("Error during API key verification:", error);
            setVerificationStatus('error');
            setVerificationError('UnexpectedError');
        } finally {
            setIsVerifying(false);
        }
    };

    const getButtonContent = () => {
        if (isVerifying) {
            return { text: 'Verify', icon: Spinner };
        }
        switch (verificationStatus) {
            case 'success':
                return { text: 'Verified', icon: TickIcon };
            case 'error':
                // let errorText = 'Verification Failed';
                // if (verificationError === 'AuthenticationError') errorText = 'Invalid Key';
                // else if (verificationError === 'RateLimitError') errorText = 'Rate Limited';
                // else if (verificationError === 'PermissionDeniedError') errorText = 'Permission Denied';
                // else if (verificationError === 'UnexpectedError') errorText = 'Verification Failed';
                return { text: "Failed", icon: AlertIcon };
            case 'idle':
            default:
                return { text: 'Verify', icon: ArrowRightIcon };
        }
    };

    const { text: buttonText, icon: buttonIcon } = getButtonContent();
    const inputBorderColor = verificationStatus === 'error' ? 'border-error' : 'border-quinary';
    // const buttonVariant = verificationStatus === 'error' ? 'danger' : 'outline';
    const buttonVariant = 'outline';

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
                    value={currentValue}
                    onChange={handleChange}
                    placeholder={placeholder}
                    className={`flex-1 p-1 m-0 border text-sm rounded-sm ${inputBorderColor} bg-senary focus:border-tertiary outline-none`}
                    aria-invalid={verificationStatus === 'error'}
                />
                <Button
                    variant={buttonVariant}
                    style={{ padding: "3px 6px" }}
                    rightIcon={buttonIcon}
                    onClick={handleVerify}
                    disabled={isVerifying || !currentValue}
                >
                    {buttonText}
                </Button>
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
    const togglePreferencePage = useSetAtom(isPreferencePageVisibleAtom);

    // --- Save Preferences ---
    const handlePrefSave = (key: "googleGenerativeAiApiKey" | "openAiApiKey" | "anthropicApiKey" | "customInstructions", value: string) => {
        if (value !== getPref(key)) {
            setPref(key, value);
            console.log(`Saved pref ${key}`);
        }
    };

    const handleCustomInstructionsChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newValue = event.target.value;
        setCustomInstructions(newValue);
        handlePrefSave('customInstructions', newValue);
    };

    // --- Quick Prompt Change Handler ---
    const handleQuickPromptChange = useCallback((index: number, updatedPrompt: QuickPrompt) => {
        setQuickPrompts((currentPrompts: any) => {
            const newPrompts = [...currentPrompts];
            newPrompts[index] = updatedPrompt;
            return newPrompts;
        });
        // Note: Individual pref saving is handled within QuickPromptSettings component's onBlur/onChange
    }, []);

    const handleLogout = () => {
        supabase.auth.signOut();
    };

    return (
        <div
            id="beaver-preferences"
            className="flex flex-col flex-1 min-h-0 overflow-y-auto gap-2 scrollbar min-w-0 p-4"
        >
            <div className="flex flex-row items-center gap-4 justify-between">
                <h1 className="text-2xl font-semibold  font-color-primary" style={{ marginBlock: "0rem" }}>
                    Settings
                </h1>
                <Button variant="outline" rightIcon={CancelIcon} onClick={() => togglePreferencePage((prev) => !prev)} className="mt-1">Close</Button>
            </div>
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