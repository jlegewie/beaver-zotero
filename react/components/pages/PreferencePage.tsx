import React, { useState, useCallback } from "react";
import { useAtom, useAtomValue } from 'jotai';
import { logoutAtom, userAtom } from '../../atoms/auth';
import { getPref, setPref } from '../../../src/utils/prefs';
import { UserIcon, LogoutIcon, SyncIcon, TickIcon, DatabaseIcon, Spinner } from '../icons/icons';
import Button from "../ui/Button";
import { useSetAtom } from 'jotai';
import { profileWithPlanAtom, syncLibraryIdsAtom, syncWithZoteroAtom } from "../../atoms/profile";
import { logger } from "../../../src/utils/logger";
import { getCustomPromptsFromPreferences, CustomPrompt } from "../../types/settings";
import { performConsistencyCheck } from "../../../src/utils/syncConsistency";
import ApiKeyInput from "../preferences/ApiKeyInput";
import CustomPromptSettings from "../preferences/CustomPromptSettings";
import ZoteroSyncToggle from "../preferences/SyncToggle";
import { isLibrarySynced } from "../../../src/utils/zoteroUtils";
import { accountService } from "../../../src/services/accountService";

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
    const syncLibraryIds = useAtomValue(syncLibraryIdsAtom);

    // --- Sync Toggle State ---
    const syncWithZotero = useAtomValue(syncWithZoteroAtom);
    const setProfileWithPlan = useSetAtom(profileWithPlanAtom);
    const [localSyncToggle, setLocalSyncToggle] = useState(syncWithZotero);

    // Update local state when atom changes
    React.useEffect(() => {
        setLocalSyncToggle(syncWithZotero);
    }, [syncWithZotero]);

    // --- Sync and Verify Status States ---
    const [syncStatus, setSyncStatus] = useState<'idle' | 'running' | 'completed'>('idle');
    const [verifyStatus, setVerifyStatus] = useState<'idle' | 'running' | 'completed'>('idle');

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

    // --- Sync Handler ---
    const handleSync = useCallback(async () => {
        if (syncStatus === 'running') return;
        
        setSyncStatus('running');
        logger('handleSync: Starting full sync');
        
        try {
            // Import the sync function
            const { syncZoteroDatabase, syncingItemFilter } = await import('../../../src/utils/sync');
            
            // Run full sync for all sync libraries
            await syncZoteroDatabase(syncLibraryIds, syncingItemFilter);
            
            logger('Full sync completed successfully');
            setSyncStatus('completed');
            
            // Reset to idle after 2 seconds
            setTimeout(() => {
                setSyncStatus('idle');
            }, 2000);
            
        } catch (error: any) {
            logger(`Full sync failed: ${error.message}`, 1);
            Zotero.logError(error);
            setSyncStatus('idle');
        }
    }, [syncLibraryIds, syncStatus]);

    // --- Verify Sync Handler ---
    const handleVerifySync = useCallback(async () => {
        if (verifyStatus === 'running') return;
        
        setVerifyStatus('running');
        logger('handleVerifySync: Starting sync verification');
        
        try {
            // Run consistency check for all sync libraries
            const promises = syncLibraryIds.map(libraryID => 
                performConsistencyCheck(libraryID)
            );
            
            await Promise.all(promises);
            
            logger('Sync verification completed successfully');
            setVerifyStatus('completed');
            
            // Reset to idle after 2 seconds
            setTimeout(() => {
                setVerifyStatus('idle');
            }, 2000);
            
        } catch (error: any) {
            logger(`Sync verification failed: ${error.message}`, 1);
            Zotero.logError(error);
            setVerifyStatus('idle');
        }
    }, [syncLibraryIds, verifyStatus]);

    // --- Remove Prompt Handler ---
    const handleRemovePrompt = useCallback((indexToRemove: number) => {
        setCustomPrompts((currentPrompts) => {
            const newPrompts = currentPrompts.filter((_, filterIndex) => filterIndex !== indexToRemove);
            saveCustomPromptsToPrefs(newPrompts);
            return newPrompts;
        });
    }, [saveCustomPromptsToPrefs]);

    // --- Sync Toggle Change Handler ---
    const handleSyncToggleChange = useCallback(async (checked: boolean) => {
        const action = checked ? 'enable' : 'disable';
        const message = checked 
            ? 'Are you sure you want to enable syncing with Zotero? This will build on Zotero sync for multi-device support and improved sync.'
            : 'Are you sure you want to disable syncing with Zotero? You will only be able to use Beaver on this device.';
        
        if (confirm(message)) {
            try {
                logger(`User confirmed to ${action} Zotero sync. New value: ${checked}`);
                await accountService.updateZoteroSyncPreference(checked);

                setProfileWithPlan((prev) => {
                    if (!prev) return null;
                    return { ...prev, use_zotero_sync: checked };
                });
                setLocalSyncToggle(checked);
                logger('Successfully updated Zotero sync preference.');
            } catch (error) {
                logger(`Failed to update Zotero sync preference: ${error}`, 1);
                Zotero.logError(error as Error);
                // Revert the toggle on error
                setLocalSyncToggle(!checked);
            }
        }
    }, [setProfileWithPlan]);

    // Helper function to get sync button props
    const getSyncButtonProps = () => {
        switch (syncStatus) {
            case 'running':
                return {
                    icon: SyncIcon,
                    iconClassName: 'animate-spin',
                    disabled: true,
                    text: 'Syncing...'
                };
            case 'completed':
                return {
                    icon: TickIcon,
                    iconClassName: '',
                    disabled: true,
                    text: 'Synced'
                };
            default:
                return {
                    icon: SyncIcon,
                    iconClassName: '',
                    disabled: false,
                    text: 'Sync'
                };
        }
    };

    // Helper function to get verify button props
    const getVerifyButtonProps = () => {
        switch (verifyStatus) {
            case 'running':
                return {
                    icon: Spinner,
                    iconClassName: 'animate-spin',
                    disabled: true,
                    text: 'Verifying...'
                };
            case 'completed':
                return {
                    icon: TickIcon,
                    iconClassName: '',
                    disabled: true,
                    text: 'Verified'
                };
            default:
                return {
                    icon: DatabaseIcon,
                    iconClassName: '',
                    disabled: false,
                    text: 'Verify Data'
                };
        }
    };

    const syncButtonProps = getSyncButtonProps();
    const verifyButtonProps = getVerifyButtonProps();

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
                        <div className="font-color-secondary">Signed in as:</div>
                        <div className="font-semibold font-color-primary">{user.email}</div>
                    </div>
                    <div className="display-flex flex-row items-center gap-2">
                        <div className="font-color-secondary">Plan:</div>
                        <div className="font-semibold font-color-primary">{profileWithPlan?.plan.display_name || 'Unknown'}</div>
                    </div>
                    <div className="display-flex flex-row items-center gap-3 mt-2">
                        <Button
                            variant="outline"
                            disabled={true}
                            icon={UserIcon}
                            onClick= {() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/login')}
                        >
                            Manage Account
                        </Button>
                        <Button variant="outline" icon={LogoutIcon} onClick={logout}>Logout</Button>
                    </div>
                </div>
            ) : (
                <div className="card p-3">
                     <span className="font-color-secondary">You are not signed in.</span>
                </div>
            )}

            {/* --- Library Syncing Section --- */}
            <SectionHeader>Beaver Syncing</SectionHeader>

            {/* <div className="text-sm font-color-secondary mb-3">
                Beaver syncs your library, uploads your PDFs, and indexes your files for search.
            </div> */}

            <div className="display-flex flex-col gap-3">
                <div className="display-flex flex-row items-center gap-3">
                    <div className="font-color-secondary">Sync Status:</div>
                    <div className="font-color-secondary">Last synced on XXXX</div>
                </div>
                <div className="display-flex flex-row items-center gap-4">
                    <Button 
                        variant="outline" 
                        icon={syncButtonProps.icon}
                        iconClassName={syncButtonProps.iconClassName}
                        onClick={handleSync}
                        disabled={syncButtonProps.disabled}
                    >
                        {syncButtonProps.text}
                    </Button>
                    <Button 
                        variant="outline" 
                        icon={verifyButtonProps.icon}
                        iconClassName={verifyButtonProps.iconClassName}
                        onClick={handleVerifySync}
                        disabled={verifyButtonProps.disabled}
                    >
                        {verifyButtonProps.text}
                    </Button>
                </div>

                {/* Sync with Zotero Toggle */}
                <div className="mt-2">
                    <ZoteroSyncToggle 
                        checked={localSyncToggle}
                        onChange={handleSyncToggleChange}
                        disabled={!isLibrarySynced(1) && !syncWithZotero}
                        error={!isLibrarySynced(1) && syncWithZotero}
                    />
                </div>
            </div>
            
            {/* <LibrarySelection /> */}

            {/* --- API Keys Section --- */}
            <SectionHeader>API Keys</SectionHeader>
            <div className="text-sm font-color-secondary mb-3">
                Add your own API key to use models from Google, Anthropic, and OpenAI.
                When you use your own API key, your provider's terms and data-use rules apply.
                Your keys are only stored locally and never on our server.
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