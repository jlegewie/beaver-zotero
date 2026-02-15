import React, { useState, useCallback, useMemo } from "react";
import { useAtom, useAtomValue } from 'jotai';
import { logoutAtom, userAtom } from '../../atoms/auth';
import { getPref, setPref } from '../../../src/utils/prefs';
import { UserIcon, LogoutIcon, SyncIcon, TickIcon, DatabaseIcon, Spinner, RepeatIcon, SettingsIcon, Icon } from '../icons/icons';
import Button from "../ui/Button";
import { useSetAtom } from 'jotai';
import { profileWithPlanAtom, syncedLibraryIdsAtom, syncWithZoteroAtom, profileBalanceAtom, isDatabaseSyncSupportedAtom, processingModeAtom, remainingBeaverCreditsAtom } from "../../atoms/profile";
import { activePreferencePageTabAtom, PreferencePageTab } from "../../atoms/ui";
import { logger } from "../../../src/utils/logger";
import { getCustomPromptsFromPreferences, CustomPrompt } from "../../types/settings";
import { performConsistencyCheck } from "../../../src/utils/syncConsistency";
import { 
    embeddingIndexStateAtom, 
    forceReindexAtom, 
    isEmbeddingIndexingAtom 
} from "../../atoms/embeddingIndex";
import ApiKeyInput from "../preferences/ApiKeyInput";
import CustomPromptCard from "../preferences/CustomPromptCard";
import { isLibrarySynced } from "../../../src/utils/zoteroUtils";
import { accountService } from "../../../src/services/accountService";
import SyncedLibraries from "../preferences/SyncedLibraries";
import { ProcessingMode } from "../../types/profile";
import DeferredToolPreferenceSetting from "../preferences/DeferredToolPreferenceSetting";
import { BeaverUIFactory } from "../../../src/ui/ui";

/** Section label displayed above a settings group */
const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="text-lg font-color-primary font-bold" style={{ marginTop: '20px', marginBottom: '6px', paddingLeft: '2px' }}>
        {children}
    </div>
);

/** Card container for grouping related settings */
const SettingsGroup: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
    <div className={`display-flex flex-col rounded-lg border-quinary overflow-hidden ${className}`}>
        {children}
    </div>
);

interface SettingsRowProps {
    title: string;
    description?: React.ReactNode;
    control?: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    tooltip?: string;
    hasBorder?: boolean;
}

/** Individual setting row with title, description, and optional control */
const SettingsRow: React.FC<SettingsRowProps> = ({
    title, description, control, onClick, disabled, tooltip, hasBorder = false
}) => (
    <div
        className={`display-flex flex-row items-center justify-between gap-4 ${hasBorder ? 'border-top-quinary' : ''} ${onClick && !disabled ? 'cursor-pointer' : ''} ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
        style={{ padding: '8px 12px', minHeight: '38px' }}
        onClick={(e) => {
            if (disabled || !onClick) return;
            const target = e.target as HTMLElement;
            if (target.tagName === 'A' || target.closest('a')) return;
            onClick();
        }}
        title={tooltip}
    >
        <div className="display-flex flex-col gap-05 flex-1 min-w-0">
            <div className="font-color-primary text-base font-medium">{title}</div>
            {description && (
                <div className="font-color-secondary text-base">{description}</div>
            )}
        </div>
        {control && (
            <div className="display-flex flex-row items-center flex-shrink-0">
                {control}
            </div>
        )}
    </div>
);

const DocLink: React.FC<{ path: string; children: React.ReactNode }> = ({ path, children }) => (
    <a
        onClick={() => Zotero.launchURL(`${process.env.WEBAPP_BASE_URL}/docs/${path}`)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-link"
    >
        {children}
    </a>
);

const PreferencePage: React.FC = () => {
    const [user] = useAtom(userAtom);
    const logout = useSetAtom(logoutAtom);

    // --- User profile ---
    const [profileWithPlan, setProfileWithPlan] = useAtom(profileWithPlanAtom);

    // --- State for Preferences ---
    const [geminiKey, setGeminiKey] = useState(() => getPref('googleGenerativeAiApiKey'));
    const [openaiKey, setOpenaiKey] = useState(() => getPref('openAiApiKey'));
    const [anthropicKey, setAnthropicKey] = useState(() => getPref('anthropicApiKey'));
    const [customInstructions, setCustomInstructions] = useState(() => getPref('customInstructions'));
    const [customPrompts, setCustomPrompts] = useState<CustomPrompt[]>(getCustomPromptsFromPreferences());
    const syncedLibraryIds = useAtomValue(syncedLibraryIdsAtom);
    const [citationFormat, setCitationFormat] = useState(() => getPref('citationFormat') === 'numeric');
    const [keyboardShortcut, setKeyboardShortcut] = useState(() => {
        const shortcut = getPref('keyboardShortcut');
        return /^[a-z]$/i.test(shortcut) ? shortcut.toUpperCase() : 'J';
    });
    const [addSelectedOnNewThread, setAddSelectedOnNewThread] = useState(() => getPref('addSelectedItemsOnNewThread'));
    const [addSelectedOnOpen, setAddSelectedOnOpen] = useState(() => getPref('addSelectedItemsOnOpen'));
    const [consentToShare, setConsentToShare] = useState(() => profileWithPlan?.consent_to_share || false);
    const [emailNotifications, setEmailNotifications] = useState(() => profileWithPlan?.email_notifications || false);
    const syncWithZotero = useAtomValue(syncWithZoteroAtom);
    const [localSyncToggle, setLocalSyncToggle] = useState(syncWithZotero);
    const profileBalance = useAtomValue(profileBalanceAtom);
    const remainingBeaverCredits = useAtomValue(remainingBeaverCreditsAtom);
    const isDatabaseSyncSupported = useAtomValue(isDatabaseSyncSupportedAtom);
    const processingMode = useAtomValue(processingModeAtom);
    const [activeTab, setActiveTab] = useAtom(activePreferencePageTabAtom);

    // Update local state when atom changes
    React.useEffect(() => {
        setLocalSyncToggle(syncWithZotero);
        setConsentToShare(profileWithPlan?.consent_to_share || false);
        setEmailNotifications(profileWithPlan?.email_notifications || false);
    }, [syncWithZotero, profileWithPlan?.consent_to_share, profileWithPlan?.email_notifications]);

    // --- Sync and Verify Status States ---
    const [syncStatus, setSyncStatus] = useState<'idle' | 'running' | 'completed'>('idle');
    const [verifyStatus, setVerifyStatus] = useState<'idle' | 'running' | 'completed'>('idle');
    const [lastSyncedText, setLastSyncedText] = useState<string>('Never');
    
    // --- Embedding Index ---
    const embeddingIndexState = useAtomValue(embeddingIndexStateAtom);
    const isEmbeddingIndexing = useAtomValue(isEmbeddingIndexingAtom);
    const forceReindex = useSetAtom(forceReindexAtom);
 
     // --- Load last synced timestamp from local DB ---
     const loadLastSynced = useCallback(async () => {
         try {
             if (!user?.id || !syncedLibraryIds?.length) {
                setLastSyncedText('Unable to retrieve');
                return;
             }
             const latest = await Zotero.Beaver.db.getMostRecentSyncLogForLibraries(user.id, syncedLibraryIds);
             if (!latest) {
                setLastSyncedText('Never');
                return;
             }
 
            // Timestamps are stored like 'YYYY-MM-DD HH:MM:SS' (UTC); add 'Z' for robust parsing
            const stamp = latest.timestamp.endsWith('Z') ? latest.timestamp : `${latest.timestamp}Z`;
            const localDate = new Date(stamp);
            // e.g., "Aug 11, 2025, 2:34 PM"
            const nice = new Intl.DateTimeFormat(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
            }).format(localDate);
            setLastSyncedText(nice);
        } catch (e: any) {
            logger(`Failed to load last sync time: ${e.message}`, 1);
            setLastSyncedText('—');
        }
    }, [user?.id, syncedLibraryIds]);

    React.useEffect(() => {
        loadLastSynced();
    }, [loadLastSynced]);

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

    const handleKeyboardShortcutChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
        const nextShortcut = event.target.value.toLowerCase();
        if (!/^[a-z]$/.test(nextShortcut)) {
            return;
        }
        setKeyboardShortcut(nextShortcut.toUpperCase());

        // if (nextShortcut !== getPref('keyboardShortcut')) {
        //     setPref('keyboardShortcut', nextShortcut);
        //     BeaverUIFactory.registerShortcuts();
        //     logger(`Updated keyboard shortcut to ${nextShortcut.toUpperCase()}`);
        // }
    }, []);

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

    // --- Verify Sync Handler ---
    const handleVerifySync = useCallback(async () => {
        if (verifyStatus === 'running') return;
        
        setVerifyStatus('running');
        logger('handleVerifySync: Starting sync verification');
        
        try {
            // Run consistency check for all sync libraries
            for (const libraryID of syncedLibraryIds) {
                await performConsistencyCheck(libraryID);
            }
            
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
    }, [syncedLibraryIds, verifyStatus]);

    // --- Remove Prompt Handler ---
    const handleRemovePrompt = useCallback((indexToRemove: number) => {
        setCustomPrompts((currentPrompts) => {
            const newPrompts = currentPrompts.filter((_, filterIndex) => filterIndex !== indexToRemove);
            saveCustomPromptsToPrefs(newPrompts);
            return newPrompts;
        });
    }, [saveCustomPromptsToPrefs]);

    const getCustomPromptAvailabilityNote = useCallback((prompt: CustomPrompt): string | undefined => {
        if (!prompt.requiresDatabaseSync) return undefined;
        if (!isDatabaseSyncSupported) {
            return 'Only available with Beaver Pro';
        }
        if (processingMode === ProcessingMode.FRONTEND) {
            return 'Available after indexing is complete';
        }
        return undefined;
    }, [isDatabaseSyncSupported, processingMode]);

    // --- Consent Toggle Change Handler ---
    const handleConsentChange = useCallback(async (checked: boolean) => {
        const action = checked ? 'enable' : 'disable';
        try {
            logger(`User confirmed to ${action} consent to share. New value: ${checked}`);
            await accountService.updatePreference('consent_to_share', checked);

            setProfileWithPlan((prev) => {
                if (!prev) return null;
                return { ...prev, consent_to_share: checked };
            });
            setConsentToShare(checked);
            logger('Successfully updated consent to share preference.');
        } catch (error) {
            logger(`Failed to update consent to share preference: ${error}`, 1);
            Zotero.logError(error as Error);
            // Revert the toggle on error
            setConsentToShare(!checked);
        }
    }, [setProfileWithPlan]);

    // --- Email Notifications Toggle Change Handler ---
    const handleEmailNotificationsChange = useCallback(async (checked: boolean) => {
        const action = checked ? 'enable' : 'disable';
        try {
            logger(`User confirmed to ${action} email notifications. New value: ${checked}`);
            await accountService.updatePreference('email_notifications', checked);

            setProfileWithPlan((prev) => {
                if (!prev) return null;
                return { ...prev, email_notifications: checked };
            });
            setEmailNotifications(checked);
            logger('Successfully updated email notifications preference.');
        } catch (error) {
            logger(`Failed to update email notifications preference: ${error}`, 1);
            Zotero.logError(error as Error);
            // Revert the toggle on error
            setEmailNotifications(!checked);
        }
    }, [setProfileWithPlan]);

    // --- Sync Toggle Change Handler ---
    const handleSyncToggleChange = useCallback(async (checked: boolean) => {
        const action = checked ? 'enable' : 'disable';
        const message = checked 
            ? 'Are you sure you want to enable syncing with Zotero? This will build on Zotero sync for multi-device support and improved sync.'
            : 'Are you sure you want to disable syncing with Zotero? You will only be able to use Beaver on this device and group libraries will not be synced with Beaver anymore.';
        
        const buttonIndex = Zotero.Prompt.confirm({
            window: Zotero.getMainWindow(),
            title: checked ? 'Enable Coordinate with Zotero Sync?' : 'Disable Coordinate with Zotero Sync?',
            text: message,
            button0: Zotero.Prompt.BUTTON_TITLE_YES,
            button1: Zotero.Prompt.BUTTON_TITLE_NO,
            defaultButton: 1,
        });

        if (buttonIndex === 0) { // If "Yes" is clicked
            try {
                logger(`User confirmed to ${action} Zotero sync. New value: ${checked}`);
                await accountService.updatePreference('use_zotero_sync', checked);

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

    // --- Rebuild Search Index Handler ---
    const handleRebuildSearchIndex = useCallback(() => {
        if (isEmbeddingIndexing) return;
        logger('handleRebuildSearchIndex: User-initiated search index rebuild');
        forceReindex();
    }, [isEmbeddingIndexing, forceReindex]);

    // --- Inline toggle handlers for card-based layout ---
    const handleCitationFormatToggle = useCallback(() => {
        const newChecked = !citationFormat;
        setPref("citationFormat", newChecked ? "numeric" : "author-year");
        setCitationFormat(newChecked);
    }, [citationFormat]);

    const handleAddSelectedOnNewThreadToggle = useCallback(() => {
        const newValue = !addSelectedOnNewThread;
        setPref("addSelectedItemsOnNewThread", newValue);
        setAddSelectedOnNewThread(newValue);
    }, [addSelectedOnNewThread]);

    const handleAddSelectedOnOpenToggle = useCallback(() => {
        const newValue = !addSelectedOnOpen;
        setPref("addSelectedItemsOnOpen", newValue);
        setAddSelectedOnOpen(newValue);
    }, [addSelectedOnOpen]);

    const handleConsentToggle = useCallback(() => {
        handleConsentChange(!consentToShare);
    }, [consentToShare, handleConsentChange]);

    const handleEmailToggle = useCallback(() => {
        handleEmailNotificationsChange(!emailNotifications);
    }, [emailNotifications, handleEmailNotificationsChange]);

    // Helper function to get rebuild index button props
    const getRebuildIndexButtonProps = () => {
        if (isEmbeddingIndexing) {
            const progress = embeddingIndexState.progress > 0 ? ` (${embeddingIndexState.progress}%)` : '';
            return {
                icon: Spinner,
                iconClassName: 'animate-spin',
                disabled: true,
                text: `Indexing${progress}`
            };
        }
        if (embeddingIndexState.failedItems > 0) {
            return {
                icon: RepeatIcon,
                iconClassName: '',
                disabled: false,
                text: `Indexing Failed (${embeddingIndexState.failedItems})`
            };
        }
        return {
            icon: RepeatIcon,
            iconClassName: '',
            disabled: false,
            text: 'Sync'
        };
    };

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
    const rebuildIndexButtonProps = getRebuildIndexButtonProps();
    const sidebarShortcutLabel = `${Zotero.isMac ? '⌘' : 'Ctrl'}+${keyboardShortcut}`;
    const windowShortcutLabel = `${Zotero.isMac ? '⌘⇧' : 'Ctrl+Shift'}+${keyboardShortcut}`;
    const tabs = useMemo<{ id: PreferencePageTab; label: string }[]>(() => [
        { id: 'general', label: 'General' },
        { id: 'sync', label: isDatabaseSyncSupported ? 'Sync' : 'Search' },
        { id: 'permissions', label: 'Permissions' },
        { id: 'models', label: 'Models & API Keys' },
        { id: 'prompts', label: 'Prompts' },
    ], [isDatabaseSyncSupported]);

    // Backward compatibility for existing entry points that still request "account".
    React.useEffect(() => {
        if (activeTab === 'account') {
            setActiveTab('general');
        }
    }, [activeTab, setActiveTab]);

    return (
        <div
            id="beaver-preferences"
            className="flex-1 min-h-0 overflow-y-auto scrollbar min-w-0"
        >
          <div className="display-flex flex-col gap-2 p-4">
            <div className="display-flex flex-row items-center gap-3 px-1">
                <Icon icon={SettingsIcon} className="scale-16 mt-020" />
                <h1 className="text-2xl font-semibold  font-color-primary" style={{ marginBlock: "0rem" }}>
                    Settings
                </h1>
                {/* <Button variant="outline" rightIcon={CancelIcon} onClick={() => togglePreferencePage((prev) => !prev)} className="mt-1">Close</Button> */}
            </div>


            <div className="display-flex flex-row flex-wrap gap-1 items-center pb-1 mt-2">
                {tabs.map((tab) => (
                    <button
                        key={tab.id}
                        type="button"
                        onClick={() => setActiveTab(tab.id)}
                        aria-label={`Open ${tab.label} tab`}
                        aria-pressed={tab.id === activeTab}
                        className="text-base"
                        style={{
                            border: '1px solid var(--fill-quarternary)',
                            borderRadius: '4px',
                            background: tab.id === activeTab ? 'var(--fill-quinary)' : 'transparent',
                            color: tab.id === activeTab ? 'var(--fill-primary)' : 'var(--fill-secondary)',
                            padding: '4px 12px',
                            minHeight: '20px',
                            lineHeight: 1.2,
                            whiteSpace: 'nowrap',
                            transition: 'background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease'
                        }}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* ===== GENERAL TAB ===== */}
            {activeTab === 'general' && (
                <>
                    {user ? (
                        <>
                            <SettingsGroup className="mt-2">
                                <SettingsRow
                                    title="Manage Account"
                                    description={<>Signed in as {user.email} ({profileWithPlan?.plan.display_name || 'Unknown'} plan)</>}
                                    control={
                                        <Button
                                            variant="outline"
                                            icon={UserIcon}
                                            onClick={() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/login')}
                                        >
                                            Open
                                        </Button>
                                    }
                                />
                                {isDatabaseSyncSupported && profileBalance.pagesRemaining !== undefined && (
                                    <SettingsRow
                                        title="Page Balance"
                                        description="Remaining pages for full-document search"
                                        hasBorder
                                        control={
                                            <span className="font-color-primary text-sm font-medium">
                                                {profileBalance.pagesRemaining.toLocaleString()}
                                            </span>
                                        }
                                    />
                                )}
                                <SettingsRow
                                    title="Chat Credits"
                                    description="Remaining Beaver chat credits"
                                    hasBorder
                                    control={
                                        <span className="font-color-primary text-sm font-medium">
                                            {remainingBeaverCredits.toLocaleString()}
                                        </span>
                                    }
                                />
                                <SettingsRow
                                    title="Sign Out"
                                    description="End your current session"
                                    hasBorder
                                    control={
                                        <Button variant="outline" icon={LogoutIcon} onClick={logout}>
                                            Logout
                                        </Button>
                                    }
                                />
                            </SettingsGroup>

                            <SectionLabel>Preferences</SectionLabel>
                            <SettingsGroup>
                                <SettingsRow
                                    title="Keyboard Shortcut"
                                    description={<>Sidebar: {sidebarShortcutLabel} &middot; Window: {windowShortcutLabel} &middot; Changes require restart</>}
                                    control={
                                        <select
                                            id="keyboard-shortcut"
                                            value={keyboardShortcut}
                                            onChange={handleKeyboardShortcutChange}
                                            className="py-1 px-2 border preference-input text-sm"
                                            style={{ width: '40px', margin: 0 }}
                                            onClick={(e) => e.stopPropagation()}
                                        >
                                            {'DGHJKMRVX'.split('').map((letter) => (
                                                <option key={letter} value={letter}>{letter}</option>
                                            ))}
                                        </select>
                                    }
                                />
                                <SettingsRow
                                    title={`Citation Format: ${citationFormat ? 'Numeric' : 'Author-Year'}`}
                                    description="Choose between numeric [1] or author-year (Smith, 2023) citations"
                                    onClick={handleCitationFormatToggle}
                                    hasBorder
                                    control={
                                        <input
                                            type="checkbox"
                                            checked={citationFormat}
                                            onChange={handleCitationFormatToggle}
                                            onClick={(e) => e.stopPropagation()}
                                            style={{ cursor: 'pointer', margin: 0 }}
                                        />
                                    }
                                />
                                <SettingsRow
                                    title="Add Selected Items to New Threads"
                                    description="Automatically attach selected items to new thread"
                                    onClick={handleAddSelectedOnNewThreadToggle}
                                    hasBorder
                                    tooltip="When enabled, any items you have selected in Zotero will be automatically added as sources when you start a new conversation thread."
                                    control={
                                        <input
                                            type="checkbox"
                                            checked={addSelectedOnNewThread}
                                            onChange={handleAddSelectedOnNewThreadToggle}
                                            onClick={(e) => e.stopPropagation()}
                                            style={{ cursor: 'pointer', margin: 0 }}
                                        />
                                    }
                                />
                                <SettingsRow
                                    title="Add Selected Items When Opening"
                                    description="Automatically attach selected items when opening Beaver"
                                    onClick={handleAddSelectedOnOpenToggle}
                                    hasBorder
                                    tooltip="When enabled, any items you have selected in Zotero will be automatically added as sources when you open Beaver."
                                    control={
                                        <input
                                            type="checkbox"
                                            checked={addSelectedOnOpen}
                                            onChange={handleAddSelectedOnOpenToggle}
                                            onClick={(e) => e.stopPropagation()}
                                            style={{ cursor: 'pointer', margin: 0 }}
                                        />
                                    }
                                />
                                <SettingsRow
                                    title="Help Improve Beaver"
                                    description="Share anonymized prompts to help improve Beaver"
                                    onClick={handleConsentToggle}
                                    hasBorder
                                    tooltip="When enabled, we use your prompts, queries, and AI responses to improve Beaver's features and performance. We automatically remove personal information and never share your PDFs, documents, or other files."
                                    control={
                                        <input
                                            type="checkbox"
                                            checked={consentToShare}
                                            onChange={handleConsentToggle}
                                            onClick={(e) => e.stopPropagation()}
                                            style={{ cursor: 'pointer', margin: 0 }}
                                        />
                                    }
                                />
                                <SettingsRow
                                    title="Email Notifications"
                                    description="Receive email notifications with updates and announcements"
                                    onClick={handleEmailToggle}
                                    hasBorder
                                    control={
                                        <input
                                            type="checkbox"
                                            checked={emailNotifications}
                                            onChange={handleEmailToggle}
                                            onClick={(e) => e.stopPropagation()}
                                            style={{ cursor: 'pointer', margin: 0 }}
                                        />
                                    }
                                />
                            </SettingsGroup>

                            <div className="display-flex flex-row gap-1 items-start mt-3" style={{ paddingLeft: '2px' }}>
                                <button
                                    type="button"
                                    onClick={() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/terms')}
                                    className="text-link-muted text-sm"
                                >
                                    Terms of Service
                                </button>
                                <div className="font-color-secondary">|</div>
                                <button
                                    type="button"
                                    onClick={() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/privacy-policy')}
                                    className="text-link-muted text-sm"
                                >
                                    Privacy Policy
                                </button>
                            </div>
                        </>
                    ) : (
                        <SettingsGroup className="mt-2">
                            <SettingsRow
                                title="Account"
                                description="You are not signed in."
                            />
                        </SettingsGroup>
                    )}
                </>
            )}

            {/* ===== SYNC TAB ===== */}
            {activeTab === 'sync' && (
                <>
                    {/* <div className="text-base font-color-secondary mt-1 mb-4" style={{ paddingLeft: '2px' }}>
                        {isDatabaseSyncSupported ? (
                            <>
                                Select the libraries you want to sync with Beaver.
                                Beaver can only access  synced libraries.
                                For more details, see documentation on <DocLink path="libraries">libraries</DocLink> and <DocLink path="trouble-file-sync">sync troubleshooting</DocLink>.
                            </>
                        ) : (
                            <>Beaver indexes your library locally for semantic search.</>
                        )}
                    </div> */}
                    {isDatabaseSyncSupported && (
                        <SettingsGroup>
                            <div className="display-flex flex-col gap-05 flex-1 min-w-0" style={{ padding: '8px 12px' }}>
                                {/* <div className="font-color-primary text-base font-medium">Permissions</div> */}
                                <div className="font-color-secondary text-sm">
                                    {isDatabaseSyncSupported ? (
                                        <>
                                            Select the libraries you want to sync with Beaver.
                                            Beaver can only access  synced libraries.
                                            For more details, see documentation on <DocLink path="libraries">libraries</DocLink> and <DocLink path="trouble-file-sync">sync troubleshooting</DocLink>.
                                        </>
                                    ) : (
                                        <>Beaver indexes your library locally for semantic search.</>
                                    )}

                                </div>
                            </div>
                        </SettingsGroup>
                    )}

                    {isDatabaseSyncSupported ? (
                        <span className="mt-4">
                            <SyncedLibraries />
                            <div className="display-flex flex-row items-center gap-4 justify-end mt-1" style={{ marginRight: '1px' }}>
                                <Button
                                    variant="outline"
                                    rightIcon={verifyButtonProps.icon}
                                    iconClassName={verifyButtonProps.iconClassName}
                                    onClick={handleVerifySync}
                                    disabled={verifyButtonProps.disabled}
                                >
                                    {verifyButtonProps.text}
                                </Button>
                            </div>

                            <SectionLabel>Sync Settings</SectionLabel>
                            <SettingsGroup>
                                <SettingsRow
                                    title="Coordinate with Zotero Sync"
                                    description="Builds on Zotero sync for multi-device and group library support"
                                    onClick={() => {
                                        if ((!isLibrarySynced(1) && !syncWithZotero)) return;
                                        handleSyncToggleChange(!localSyncToggle);
                                    }}
                                    disabled={!isLibrarySynced(1) && !syncWithZotero}
                                    tooltip={
                                        !isLibrarySynced(1) && !syncWithZotero
                                            ? 'Enable Zotero sync for your main library to use this feature.'
                                            : 'When enabled, Beaver will build on Zotero sync for multi-device support and improved sync.'
                                    }
                                    control={
                                        <div className="display-flex flex-row items-center gap-2">
                                            {!(!isLibrarySynced(1) && !syncWithZotero) && !(!isLibrarySynced(1) && syncWithZotero) && !localSyncToggle && (
                                                <span className="text-xs font-color-secondary px-15 py-05 rounded-md bg-quinary border-quinary">
                                                    Recommended
                                                </span>
                                            )}
                                            {!isLibrarySynced(1) && syncWithZotero && (
                                                <span
                                                    className="text-xs px-15 py-05 rounded-md"
                                                    style={{ color: 'var(--tag-red-secondary)', border: '1px solid var(--tag-red-tertiary)', background: 'var(--tag-red-quinary)' }}
                                                    title="Unable to sync with Beaver. Please enable Zotero sync in Zotero preferences, sign into your Zotero account or disable the Beaver preference 'Sync with Zotero'."
                                                >
                                                    Error
                                                </span>
                                            )}
                                            <input
                                                type="checkbox"
                                                checked={localSyncToggle}
                                                onChange={() => handleSyncToggleChange(!localSyncToggle)}
                                                onClick={(e) => e.stopPropagation()}
                                                disabled={!isLibrarySynced(1) && !syncWithZotero}
                                                style={{ cursor: 'pointer', margin: 0 }}
                                            />
                                        </div>
                                    }
                                />
                            </SettingsGroup>
                        </span>
                    ) : (
                        <SettingsGroup>
                            <SettingsRow
                                title="Search Index"
                                description={
                                    <>
                                        Syncing the search index ensures that all your library items are indexed and searchable.
                                        {embeddingIndexState.failedItems > 0 && (
                                            <span className="display-flex font-color-yellow mt-1">
                                                {embeddingIndexState.failedItems} items failed to index
                                            </span>
                                        )}
                                        {embeddingIndexState.status === 'error' && embeddingIndexState.error && (
                                            <span className="display-flex font-color-red mt-1">
                                                Error: {embeddingIndexState.error}
                                            </span>
                                        )}
                                    </>
                                }
                                control={
                                    <Button
                                        variant="outline"
                                        rightIcon={rebuildIndexButtonProps.icon}
                                        iconClassName={rebuildIndexButtonProps.iconClassName}
                                        onClick={handleRebuildSearchIndex}
                                        disabled={rebuildIndexButtonProps.disabled}
                                        loading={isEmbeddingIndexing}
                                    >
                                        {rebuildIndexButtonProps.text}
                                    </Button>
                                }
                            />
                        </SettingsGroup>
                    )}
                </>
            )}

            {/* ===== PERMISSIONS TAB ===== */}
            {activeTab === 'permissions' && (
                <>
                    <SettingsGroup>
                        <div className="display-flex flex-col gap-05 flex-1 min-w-0" style={{ padding: '8px 12px' }}>
                            {/* <div className="font-color-primary text-base font-medium">Permissions</div> */}
                            <div className="font-color-secondary text-sm">
                                When Beaver modifies your library, all changes require your approval by default.
                                You can change this behavior here. Be careful, Beaver might make changes you didn't expect.
                            
                                For more details, see documentation on <DocLink path="editing-metadata">editing metadata</DocLink> and <DocLink path="library-management">organizing your library items</DocLink>.

                            </div>
                        </div>
                    </SettingsGroup>
                    <SettingsGroup>
                        <div style={{ padding: '8px 12px' }}>
                            <DeferredToolPreferenceSetting
                                toolName="edit_metadata"
                                label="Metadata Edits"
                                description="Changes to item titles, authors, abstracts, and other metadata"
                            />
                        </div>
                        <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
                            <DeferredToolPreferenceSetting
                                toolName="create_items"
                                label="Item Imports"
                                description="Importing new items from external sources"
                            />
                        </div>
                        <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
                            <DeferredToolPreferenceSetting
                                toolName="create_collection"
                                label="Library Organization"
                                description="Creating collections and organizing items into collections and by tags"
                            />
                        </div>
                    </SettingsGroup>
                </>
            )}

            {/* ===== MODELS & API KEYS TAB ===== */}
            {activeTab === 'models' && (
                <>
                    {/* <div className="text-base font-color-secondary mt-1 mb-2" style={{ paddingLeft: '2px' }}>
                        Connect provider API keys or advanced model providers.
                        See <DocLink path="api-key">API key guide</DocLink> and <DocLink path="custom-models">custom models</DocLink>.
                    </div> */}
                    <SettingsGroup>
                        <div style={{ padding: '8px 12px' }}>
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
                        </div>
                        <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
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
                        </div>
                        <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
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
                    </SettingsGroup>

                    <SectionLabel>Additional Providers</SectionLabel>

                    <div className="text-base font-color-secondary mt-1 mb-2" style={{ paddingLeft: '2px' }}>
                        Additional model providers and custom endpoints are supported via <DocLink path="custom-models">custom models</DocLink>.
                    </div>
                
                </>
            )}

            {/* ===== PROMPTS TAB ===== */}
            {activeTab === 'prompts' && (
                <>
                    <SectionLabel>Custom Instructions</SectionLabel>
                    <div className="custom-prompt-card" style={{ cursor: 'default' }}>
                        <div className="font-color-secondary text-sm mb-2">
                            Custom instructions are added to all chats and help steer responses. (Max ~250 words)
                        </div>
                        <textarea
                            value={customInstructions}
                            onChange={handleCustomInstructionsChange}
                            placeholder="Enter custom instructions here..."
                            rows={5}
                            className="chat-input custom-prompt-edit-textarea text-sm"
                            style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical' }}
                            maxLength={1500}
                        />
                    </div>

                    <div className="display-flex flex-row items-end justify-between">
                        <SectionLabel>Custom Prompts</SectionLabel>
                        <Button
                            variant="outline"
                            onClick={handleAddPrompt}
                            disabled={customPrompts.length >= 9}
                            className="text-sm mb-15"
                        >
                            Add Prompt
                        </Button>
                    </div>
                    <div className="text-sm font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                        Configure up to 9 custom prompts with keyboard shortcuts ({Zotero.isMac ? '⌘^1-⌘^9' : 'Ctrl+Win+1-9'}). Enable library search or set conditions based on attachments.
                    </div>
                    <div className="display-flex flex-col gap-4">
                        {customPrompts.map((prompt: CustomPrompt, index: number) => (
                            <CustomPromptCard
                                key={index}
                                index={index}
                                prompt={prompt}
                                onChange={handleCustomPromptChange}
                                onRemove={handleRemovePrompt}
                                availabilityNote={getCustomPromptAvailabilityNote(prompt)}
                            />
                        ))}
                        {/* <div className="display-flex flex-row items-center justify-start">
                            <Button
                                variant="outline"
                                onClick={handleAddPrompt}
                                disabled={customPrompts.length >= 9}
                                className="text-sm"
                            >
                                Add Prompt
                            </Button>
                        </div> */}
                    </div>
                </>
            )}

            {/* Spacer at the bottom */}
            {/* <div style={{ height: "20px" }} /> */}
          </div>
        </div>
    );
};

export default PreferencePage;
