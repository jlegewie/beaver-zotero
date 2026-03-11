import React, { useState, useCallback, useMemo, useEffect } from "react";
import { useAtom, useAtomValue } from 'jotai';
import { logoutAtom, userAtom } from '../../atoms/auth';
import { getPref, setPref } from '../../../src/utils/prefs';
import { UserIcon, LogoutIcon, SyncIcon, TickIcon, DatabaseIcon, Spinner, RepeatIcon, SettingsIcon, Icon, SearchIcon, LockIcon, KeyIcon, ZapIcon, ToolsIcon, CopyIcon, DollarCircleIcon } from '../icons/icons';
import Button from "../ui/Button";
import { useSetAtom } from 'jotai';
import { profileWithPlanAtom, syncedLibraryIdsAtom, syncWithZoteroAtom, profileBalanceAtom, isDatabaseSyncSupportedAtom, isMcpServerSupportedAtom, creditPlanAtom, creditBreakdownAtom, isCreditPlanPastDueAtom, hasCreditPlanAtom } from "../../atoms/profile";
import { activePreferencePageTabAtom, PreferencePageTab, mcpServerEnabledAtom } from "../../atoms/ui";
import { logger } from "../../../src/utils/logger";
import { performConsistencyCheck } from "../../../src/utils/syncConsistency";
import { 
    embeddingIndexStateAtom, 
    forceReindexAtom, 
    isEmbeddingIndexingAtom 
} from "../../atoms/embeddingIndex";
import { isLibrarySynced } from "../../../src/utils/zoteroUtils";
import { accountService } from "../../../src/services/accountService";
import SyncedLibraries from "./SyncedLibraries";
import DeferredToolPreferenceSetting from "./DeferredToolPreferenceSetting";
import { copyToClipboard } from "../../utils/clipboard";
import { ensureMcpBridgeScript } from "../../hooks/useMcpServer";
import { useBilling } from "../../hooks/useBilling";
import {SettingsGroup, SettingsRow, SectionLabel, DocLink} from "./components/SettingsElements";
import ActionsPreferenceSection from "./ActionsPreferenceSection";
import CustomInstructionsSection from "./CustomInstructionsSection";
import ApiKeysSection from "./ApiKeysSection";
import FileStatusDisplay from "../status/FileStatusDisplay";
import { connectionStatusAtom, fileStatusAtom } from "../../atoms/files";
import { fetchFileStatusResult } from "../../hooks/useFileStatus";


const PreferencePage: React.FC = () => {
    const [user] = useAtom(userAtom);
    const logout = useSetAtom(logoutAtom);

    // --- User profile ---
    const [profileWithPlan, setProfileWithPlan] = useAtom(profileWithPlanAtom);

    // --- State for Preferences ---
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
    const isDatabaseSyncSupported = useAtomValue(isDatabaseSyncSupportedAtom);
    const creditPlan = useAtomValue(creditPlanAtom);
    const creditBreakdown = useAtomValue(creditBreakdownAtom);
    const isPastDue = useAtomValue(isCreditPlanPastDueAtom);
    const hasPlan = useAtomValue(hasCreditPlanAtom);
    const { subscribe, buyCredits, manageSubscription, isLoading: isBillingLoading, plans, plansLoading, plansError, fetchPlans } = useBilling();
    const connectionStatus = useAtomValue(connectionStatusAtom);
    const setFileStatus = useSetAtom(fileStatusAtom);
    const [activeTab, setActiveTab] = useAtom(activePreferencePageTabAtom);

    // --- Manual File Status Refresh (when no real-time subscription) ---
    const [manualRefreshTime, setManualRefreshTime] = useState<Date | null>(null);
    const [isManualRefreshing, setIsManualRefreshing] = useState(false);
    const [now, setNow] = useState(Date.now());

    React.useEffect(() => {
        const interval = setInterval(() => setNow(Date.now()), 10000);
        return () => clearInterval(interval);
    }, []);

    const handleManualRefresh = useCallback(async () => {
        if (!user?.id) return;
        setIsManualRefreshing(true);
        logger(`PreferencePage: Manually fetching file status (one-time fetch) for user ${user.id}`, 1);
        try {
            const { fileStatus: status, error } = await fetchFileStatusResult(user.id);
            if (error) {
                logger(`PreferencePage: Manual file status refresh failed: ${error}`, 1);
                setManualRefreshTime(new Date());
                setNow(Date.now());
                return;
            }

            setFileStatus(status);
            setManualRefreshTime(new Date());
            setNow(Date.now());
        } catch (error) {
            logger(`PreferencePage: Failed to manually fetch file status: ${error}`, 1);
            setManualRefreshTime(new Date());
            setNow(Date.now());
        } finally {
            setIsManualRefreshing(false);
        }
    }, [user?.id, setFileStatus]);

    React.useEffect(() => {
        if (activeTab === 'sync' && connectionStatus === 'idle' && !manualRefreshTime && user?.id && !isManualRefreshing) {
            handleManualRefresh();
        }
    }, [activeTab, connectionStatus, manualRefreshTime, user?.id, isManualRefreshing, handleManualRefresh]);
    const [autoApplyAnnotations, setAutoApplyAnnotations] = useState(() => getPref('autoApplyAnnotations'));
    const [autoCreateNotes, setAutoCreateNotes] = useState(() => getPref('autoCreateNotes'));
    const [confirmExtractionCosts, setConfirmExtractionCosts] = useState(() => getPref('confirmExtractionCosts'));
    const [confirmExternalSearchCosts, setConfirmExternalSearchCosts] = useState(() => getPref('confirmExternalSearchCosts'));
    const [pauseLongRunningAgent, setPauseLongRunningAgent] = useState(() => getPref('pauseLongRunningAgent'));
    const [mcpServerEnabled, setMcpServerEnabled] = useAtom(mcpServerEnabledAtom);
    const isMcpServerSupported = useAtomValue(isMcpServerSupportedAtom);
    const [mcpCopied, setMcpCopied] = useState(false);
    const [mcpHttpCopied, setMcpHttpCopied] = useState(false);

    // Update local state when atom changes
    React.useEffect(() => {
        setLocalSyncToggle(syncWithZotero);
        setConsentToShare(profileWithPlan?.consent_to_share || false);
        setEmailNotifications(profileWithPlan?.email_notifications || false);
    }, [syncWithZotero, profileWithPlan?.consent_to_share, profileWithPlan?.email_notifications]);

    // Fetch plans when billing tab is active and user has no plan
    useEffect(() => {
        if (activeTab === 'billing' && !hasPlan) {
            fetchPlans();
        }
    }, [activeTab, hasPlan, fetchPlans]);

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

    const handleAutoApplyAnnotationsToggle = useCallback(() => {
        const newValue = !autoApplyAnnotations;
        setPref('autoApplyAnnotations', newValue);
        setAutoApplyAnnotations(newValue);
    }, [autoApplyAnnotations]);

    const handleAutoCreateNotesToggle = useCallback(() => {
        const newValue = !autoCreateNotes;
        setPref('autoCreateNotes', newValue);
        setAutoCreateNotes(newValue);
    }, [autoCreateNotes]);

    const handleConfirmExtractionCostsToggle = useCallback(() => {
        const newValue = !confirmExtractionCosts;
        setPref('confirmExtractionCosts', newValue);
        setConfirmExtractionCosts(newValue);
    }, [confirmExtractionCosts]);

    const handleConfirmExternalSearchCostsToggle = useCallback(() => {
        const newValue = !confirmExternalSearchCosts;
        setPref('confirmExternalSearchCosts', newValue);
        setConfirmExternalSearchCosts(newValue);
    }, [confirmExternalSearchCosts]);

    const handlePauseLongRunningAgentToggle = useCallback(() => {
        const newValue = !pauseLongRunningAgent;
        setPref('pauseLongRunningAgent', newValue);
        setPauseLongRunningAgent(newValue);
    }, [pauseLongRunningAgent]);

    const handleMcpServerToggle = useCallback(() => {
        if (!isMcpServerSupported) return;
        const newValue = !mcpServerEnabled;
        setPref('mcpServerEnabled', newValue);
        setMcpServerEnabled(newValue);
    }, [mcpServerEnabled, isMcpServerSupported, setMcpServerEnabled]);

    const mcpServerPort = useMemo(() => {
        try {
            return Zotero.Prefs.get('httpServer.port') || 23119;
        } catch {
            return 23119;
        }
    }, []);
    const handleCopyMcpConfig = useCallback(async () => {
        try {
            const scriptPath = await ensureMcpBridgeScript();
            const serverConfig: any = {
                command: "node",
                args: [scriptPath],
            };
            if (mcpServerPort !== 23119) {
                serverConfig.args.push(String(mcpServerPort));
            }
            const config = JSON.stringify({
                mcpServers: {
                    "beaver-zotero": serverConfig,
                }
            }, null, 2);
            await copyToClipboard(config);
            setMcpCopied(true);
            setTimeout(() => setMcpCopied(false), 2000);
        } catch (err: any) {
            logger(`Failed to copy MCP config: ${err?.message}`, 1);
        }
    }, [mcpServerPort]);

    const mcpEndpointUrl = `http://localhost:${mcpServerPort}/beaver/mcp`;

    const handleCopyMcpHttpConfig = useCallback(async () => {
        const config = JSON.stringify({
            mcpServers: {
                "beaver-zotero": {
                    type: "streamable-http",
                    url: mcpEndpointUrl
                }
            }
        }, null, 2);
        await copyToClipboard(config);
        setMcpHttpCopied(true);
        setTimeout(() => setMcpHttpCopied(false), 2000);
    }, [mcpEndpointUrl]);

    // Helper function to get rebuild index button props
    const getRebuildIndexButtonProps = () => {
        if (isEmbeddingIndexing) {
            const progress = embeddingIndexState.progress > 0 ? ` (${embeddingIndexState.progress}%)` : '';
            return {
                icon: RepeatIcon,
                iconClassName: '',
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
    const tabs = useMemo<{ id: PreferencePageTab; label: string; icon: React.ComponentType<React.SVGProps<SVGSVGElement>> | React.ReactElement }[]>(() => [
        { id: 'general', label: 'General', icon: SettingsIcon },
        { id: 'sync', label: isDatabaseSyncSupported ? 'Sync' : 'Search', icon: isDatabaseSyncSupported ? SyncIcon : SearchIcon },
        { id: 'permissions', label: 'Permissions', icon: LockIcon },
        { id: 'billing', label: 'Plan & Usage', icon: DollarCircleIcon },
        { id: 'models', label: 'API Keys', icon: KeyIcon },
        { id: 'actions', label: 'Actions', icon: ZapIcon },
        { id: 'advanced', label: 'Advanced', icon: ToolsIcon },
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


            <div className="display-flex flex-row items-center mb-3 mt-2" style={{ borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--fill-quarternary)', width: 'fit-content' }}>
                {tabs.map((tab, index) => (
                    <button
                        key={tab.id}
                        type="button"
                        onClick={() => setActiveTab(tab.id)}
                        aria-label={`Open ${tab.label} tab`}
                        aria-pressed={tab.id === activeTab}
                        className="text-base"
                        style={{
                            borderLeft: index > 0 ? '1px solid var(--fill-quarternary)' : 'none',
                            borderTop: 'none',
                            borderBottom: 'none',
                            borderRight: 'none',
                            borderRadius: 0,
                            background: tab.id === activeTab ? 'var(--fill-quinary)' : 'transparent',
                            color: tab.id === activeTab ? 'var(--fill-primary)' : 'var(--fill-secondary)',
                            padding: '4px 12px',
                            minHeight: '20px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            lineHeight: 1.2,
                            gap: '4px',
                            whiteSpace: 'nowrap',
                            transition: 'background-color 0.15s ease, color 0.15s ease'
                        }}
                    >
                        <Icon
                            icon={tab.icon as React.ComponentType<React.SVGProps<SVGSVGElement>>}
                            className="scale-95 -ml-05"
                        />
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* ===== GENERAL TAB ===== */}
            {activeTab === 'general' && (
                <>
                    {user ? (
                        <>
                            <SettingsGroup>
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
                                    description="Receive email updates about Beaver"
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
                                <div className="font-color-secondary text-base">
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

                    {isDatabaseSyncSupported && (
                        <>
                            <SectionLabel>File Processing Status</SectionLabel>
                            <FileStatusDisplay 
                                connectionStatus={connectionStatus === 'idle' && manualRefreshTime ? 'connected' : connectionStatus} 
                                isManualRefresh={connectionStatus === 'idle' && !!manualRefreshTime}
                            />
                            
                            {connectionStatus === 'idle' && manualRefreshTime && (
                                <div className="display-flex flex-row items-center font-color-secondary text-sm mt-2 ml-1">
                                    <span>
                                        Last refreshed {
                                            Math.floor((now - manualRefreshTime.getTime()) / 60000) === 0 
                                                ? "just now" 
                                                : `${Math.floor((now - manualRefreshTime.getTime()) / 60000)} minute${Math.floor((now - manualRefreshTime.getTime()) / 60000) !== 1 ? 's' : ''} ago`
                                        }.
                                    </span>
                                    <button 
                                        className="text-link-muted scale-80 -ml-2"
                                        onClick={handleManualRefresh}
                                        disabled={isManualRefreshing}
                                    >
                                        {isManualRefreshing ? 'Refreshing...' : 'Refresh now'}
                                    </button>
                                </div>
                            )}
                        </>
                    )}
                </>
            )}

            {/* ===== PERMISSIONS TAB ===== */}
            {activeTab === 'permissions' && (
                <>
                    <SectionLabel>Library Modifications</SectionLabel>
                    <SettingsGroup>
                        <div className="display-flex flex-col gap-05 flex-1 min-w-0" style={{ padding: '8px 12px' }}>
                            {/* <div className="font-color-primary text-base font-medium">Permissions</div> */}
                            <div className="font-color-secondary text-base">
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

                    <SectionLabel>Checkpoints</SectionLabel>
                    <SettingsGroup>
                        <SettingsRow
                            title="Pause Long-Running Tasks"
                            description={
                                <>
                                    Beaver pauses during long-running tasks to summarize progress and check in. Disabling may use additional credits or increase API costs. <DocLink path="credits">Learn more</DocLink>
                                </>
                            }
                            onClick={handlePauseLongRunningAgentToggle}
                            // tooltip="When enabled, the agent pauses after a set number of steps, reports progress, and asks whether to continue. Disable to let the agent run to completion without interruption."
                            control={
                                <input
                                    type="checkbox"
                                    checked={pauseLongRunningAgent}
                                    onChange={handlePauseLongRunningAgentToggle}
                                    onClick={(e) => e.stopPropagation()}
                                    style={{ cursor: 'pointer', margin: 0 }}
                                />
                            }
                        />
                        <SettingsRow
                            title="Confirm Extraction Costs"
                            description="Ask before using extra credits for batch extraction. Only relevant when using Beaver credits."
                            onClick={handleConfirmExtractionCostsToggle}
                            hasBorder
                            control={
                                <input
                                    type="checkbox"
                                    checked={confirmExtractionCosts}
                                    onChange={handleConfirmExtractionCostsToggle}
                                    onClick={(e) => e.stopPropagation()}
                                    style={{ cursor: 'pointer', margin: 0 }}
                                />
                            }
                        />
                        <SettingsRow
                            title="Confirm External Search Costs"
                            description="Ask before using extra credits for external literature search. Only relevant when using Beaver credits."
                            onClick={handleConfirmExternalSearchCostsToggle}
                            hasBorder
                            control={
                                <input
                                    type="checkbox"
                                    checked={confirmExternalSearchCosts}
                                    onChange={handleConfirmExternalSearchCostsToggle}
                                    onClick={(e) => e.stopPropagation()}
                                    style={{ cursor: 'pointer', margin: 0 }}
                                />
                            }
                        />
                    </SettingsGroup>

                    <SectionLabel>Auto-Apply</SectionLabel>
                    <SettingsGroup>
                        <SettingsRow
                            title="Auto-Apply Annotations"
                            description="Automatically apply annotations to PDFs when created by the agent (only when PDF is open)"
                            onClick={handleAutoApplyAnnotationsToggle}
                            control={
                                <input
                                    type="checkbox"
                                    checked={autoApplyAnnotations}
                                    onChange={handleAutoApplyAnnotationsToggle}
                                    onClick={(e) => e.stopPropagation()}
                                    style={{ cursor: 'pointer', margin: 0 }}
                                />
                            }
                        />
                        <SettingsRow
                            title="Auto-Create Zotero Notes"
                            description="Automatically create Zotero notes when generated by the agent"
                            onClick={handleAutoCreateNotesToggle}
                            hasBorder
                            control={
                                <input
                                    type="checkbox"
                                    checked={autoCreateNotes}
                                    onChange={handleAutoCreateNotesToggle}
                                    onClick={(e) => e.stopPropagation()}
                                    style={{ cursor: 'pointer', margin: 0 }}
                                />
                            }
                        />
                    </SettingsGroup>
                </>
            )}

            {/* ===== PLAN & USAGE TAB ===== */}
            {activeTab === 'billing' && (
                <>
                    <div className="font-color-secondary text-base mb-2 ml-1">
                        Credits power Beaver's AI. Most messages cost 1 credit. Some actions such as external search or batch extraction cost extra. <DocLink path="credits">Learn more &rarr;</DocLink>
                    </div>

                    {/* --- Section 1: Plan Card --- */}
                    <div className="display-flex flex-col rounded-lg overflow-hidden border-popup bg-senary p-5">
                        {isPastDue && (
                            <div
                                className="display-flex flex-row items-center gap-3 mb-3 rounded-md"
                                style={{
                                    background: 'var(--tag-red-quinary)',
                                    border: '1px solid var(--tag-red-quarternary)',
                                    padding: '8px 12px',
                                }}
                            >
                                <span className="font-color-red text-sm font-medium">
                                    Payment failed &mdash; update your payment method to keep your subscription.
                                </span>
                                <div className="flex-1" />
                                <Button variant="outline" onClick={manageSubscription} disabled={isBillingLoading}>
                                    Update Payment
                                </Button>
                            </div>
                        )}

                        <div className="text-xs font-color-secondary font-bold" style={{ letterSpacing: '0.05em' }}>
                            CURRENT PLAN
                        </div>

                        {!hasPlan ? (
                            <>
                                <div className="text-2xl font-color-primary font-bold">
                                    No active plan
                                </div>
                                <div className="text-base font-color-secondary" style={{ marginBottom: '12px' }}>
                                    Subscribe to get monthly credits and Plus Tools (external search, batch extraction, and more).
                                </div>

                                {plansLoading && (
                                    <div className="display-flex flex-row items-center gap-3" style={{ padding: '12px 0' }}>
                                        <Spinner size={16} /> <span className="font-color-secondary text-sm">Loading plans...</span>
                                    </div>
                                )}

                                {plansError && (
                                    <div className="display-flex flex-row items-center gap-3 flex-wrap ml-1 -mt-3" style={{ padding: '12px 0' }}>
                                        <span className="font-color-secondary">{plansError}</span>
                                        <Button variant="ghost-secondary" onClick={fetchPlans}>Retry</Button>
                                    </div>
                                )}

                                {!plansLoading && !plansError && plans.length > 0 && (
                                    <div className="display-flex flex-row gap-3" style={{ marginBottom: '12px' }}>
                                        {plans.map((plan) => {
                                            const price = new Intl.NumberFormat(undefined, { style: 'currency', currency: plan.currency, minimumFractionDigits: 0 }).format(plan.unit_amount / 100);
                                            return (
                                                <div
                                                    key={plan.sku}
                                                    className="display-flex flex-1 flex-col rounded-md border-popup bg-senary p-4"
                                                >
                                                    <div className="display-flex flex-row items-center gap-2" style={{ marginBottom: '4px' }}>
                                                        <span className="text-base font-color-primary font-bold">{plan.name}</span>
                                                        {/* {plan.highlight && (
                                                            <span className="text-xs px-15 py-05 rounded-md bg-quarternary font-color-secondary">
                                                                Recommended
                                                            </span>
                                                        )} */}
                                                    </div>
                                                    <div className="text-xl font-color-primary font-bold">
                                                        {price}<span className="text-sm font-normal font-color-secondary">/{plan.interval || 'mo'}</span>
                                                    </div>
                                                    <div className="text-sm font-color-secondary" style={{ marginBottom: '8px' }}>
                                                        {plan.monthly_credits} credits per month
                                                    </div>
                                                    <div style={{ alignSelf: 'flex-start' }}>
                                                        <Button
                                                            variant={plan.highlight ? 'solid' : 'surface'}
                                                            // variant="solid"
                                                            onClick={() => subscribe(plan.sku)}
                                                            disabled={isBillingLoading}
                                                        >
                                                            Subscribe
                                                        </Button>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}

                                <div className="display-flex flex-col gap-5 -mt-2 ml-1">
                                    <div className="display-flex flex-row gap-2 justify-between">
                                        <div
                                            className="text-sm text-link cursor-pointer"
                                            onClick={() => Zotero.launchURL(`${process.env.WEBAPP_BASE_URL}/pricing`)}
                                        >
                                            Compare plans &rarr;
                                        </div>
                                        {!plansError && 
                                            <div className="font-color-tertiary text-sm">
                                                Unused credits roll over for 1 month
                                            </div>
                                        }
                                    </div>
                                    <div
                                        className="text-sm text-link cursor-pointer"
                                        onClick={buyCredits}
                                    >
                                        Not ready to subscribe? Buy a credit pack instead &rarr;
                                    </div>
                                </div>
                            </>
                        ) : (
                            <div className="display-flex flex-col gap-4">
                                <div className="display-flex flex-row items-center gap-3">
                                    <div className="display-flex flex-col">
                                        <div className="display-flex flex-row items-center gap-3">
                                            <div className="text-2xl font-color-primary font-bold">
                                                {creditPlan.plan ? creditPlan.plan.charAt(0).toUpperCase() + creditPlan.plan.slice(1) : ''}
                                            </div>
                                            {creditPlan.cancelAtPeriodEnd && (
                                                <span
                                                    className="text-xs px-15 py-05 rounded-md"
                                                    style={{ color: 'var(--tag-orange-secondary)', border: '1px solid var(--tag-orange-tertiary)', background: 'var(--tag-orange-quinary)' }}
                                                >
                                                    Cancellation pending
                                                </span>
                                            )}
                                            {creditPlan.status === 'past_due' && (
                                                <span className="text-xs px-15 py-05 rounded-md" style={{ background: 'var(--tag-orange-tertiary)', color: 'var(--tag-orange-quinary)' }}>
                                                    Past due
                                                </span>
                                            )}
                                        </div>
                                        {creditPlan.periodEnd && !creditPlan.cancelAtPeriodEnd && (
                                            <span className="text-sm font-color-secondary">
                                                Renews {new Date(creditPlan.periodEnd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                                {' '}({Math.max(0, Math.ceil((new Date(creditPlan.periodEnd).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))} days)
                                            </span>
                                        )}
                                        {creditPlan.cancelAtPeriodEnd && creditPlan.periodEnd && (
                                            <span className="text-sm font-color-secondary">
                                                Your plan ends {new Date(creditPlan.periodEnd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                                {' '}({Math.max(0, Math.ceil((new Date(creditPlan.periodEnd).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))} days remaining)
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex-1" />
                                    <Button variant="outline" onClick={manageSubscription} disabled={isBillingLoading}>
                                        {creditPlan.cancelAtPeriodEnd ? 'Resubscribe' : 'Manage'}
                                    </Button>
                                </div>

                                {/* Progress bar — single combined pool */}
                                {(() => {
                                    const pool = (creditPlan.monthlyCredits || 0) + (creditBreakdown.rolledOverCredits || 0);
                                    const used = Math.min(profileBalance.monthlyCreditsUsed, pool);
                                    const total = pool || 1;
                                    const remaining = total - used;
                                    const usedPct = Math.round((used / total) * 100);
                                    const barColor = usedPct > 90 ? 'var(--tag-red-primary)' : usedPct > 70 ? 'var(--tag-yellow-primary)' : 'var(--color-accent, var(--fill-primary))';
                                    return (
                                        <div style={{ marginTop: '12px' }}>
                                            <div className="display-flex flex-row items-center gap-3" style={{ marginBottom: '4px' }}>
                                                <span className="text-sm font-color-primary font-medium">Plan Credits</span>
                                                <div className="flex-1" />
                                                <span className="text-sm font-color-primary font-medium">
                                                    {usedPct}% used
                                                </span>
                                            </div>
                                            <div className="display-flex flex-row items-center">
                                                <div
                                                    style={{
                                                        flex: 1,
                                                        height: '7px',
                                                        borderRadius: '4px',
                                                        background: 'var(--fill-quarternary)',
                                                        overflow: 'hidden',
                                                    }}
                                                >
                                                    <div
                                                        style={{
                                                            width: `${Math.min(100, usedPct)}%`,
                                                            height: '100%',
                                                            borderRadius: '4px',
                                                            background: barColor,
                                                            transition: 'width 0.3s ease',
                                                        }}
                                                    />
                                                </div>
                                            </div>
                                            <div className="display-flex flex-col">
                                                <div className="text-sm font-color-secondary" style={{ marginTop: '4px' }}>
                                                    {used} / {total} used
                                                </div>
                                                {creditBreakdown.rolledOverCredits > 0 && (
                                                    <div className="text-sm font-color-tertiary">
                                                        Includes {creditBreakdown.rolledOverCredits} rolled over credits from last period
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })()}

                            </div>
                        )}
                    </div>

                    {/* --- Section 2: Credits --- */}
                    <SectionLabel>Credits</SectionLabel>
                    <SettingsGroup>
                        <SettingsRow
                            title="Extra Credits"
                            description={
                                (creditBreakdown.purchasedCredits || 0) === 0 && !hasPlan ? (
                                    <span className="font-color-secondary">No credits remaining</span>
                                ) : (
                                    <span className="font-color-secondary">
                                        Credits from sign-up bonus and credit packs
                                        {creditBreakdown.purchasedExpiresAt && (creditBreakdown.purchasedCredits || 0) > 0 && (
                                            <>
                                                <br />
                                                Expires: {new Date(creditBreakdown.purchasedExpiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                                            </>
                                        )}
                                    </span>
                                )
                            }
                            control={
                                <div className="display-flex flex-row items-center gap-3">
                                    <Button variant="outline" onClick={buyCredits} disabled={isBillingLoading}>
                                        Buy Credits
                                    </Button>
                                    {(creditBreakdown.purchasedCredits || 0) > 0 && (
                                        <span className="font-color-primary text-sm font-bold">
                                            {(creditBreakdown.purchasedCredits || 0).toLocaleString()}
                                        </span>
                                    )}
                                </div>
                            }
                        />
                        <SettingsRow
                            title="Total Available"
                            description={
                                <span className="font-color-secondary">Plan credits + Extra Credits</span>
                            }
                            hasBorder
                            control={
                                <span className="font-color-primary text-sm font-bold">
                                    {(creditBreakdown.total || 0).toLocaleString()}
                                </span>
                            }
                        />
                    </SettingsGroup>

                    {/* --- Section 4: Cross-links --- */}
                    <div className="display-flex flex-col gap-1" style={{ marginTop: '16px', paddingLeft: '2px' }}>
                        <span
                            className="text-sm font-color-secondary text-link cursor-pointer"
                            onClick={() => Zotero.launchURL(`${process.env.WEBAPP_BASE_URL}/login`)}
                        >
                            Manage account on web &rarr;
                        </span>
                        <span
                            className="text-sm text-link cursor-pointer"
                            onClick={() => setActiveTab('models')}
                        >
                            Use your own API key instead? Configure in API Keys &rarr;
                        </span>
                    </div>
                </>
            )}

            {/* ===== MODELS & API KEYS TAB ===== */}
            {activeTab === 'models' && (
                <ApiKeysSection />
            )}

            {/* ===== ACTIONS TAB ===== */}
            {activeTab === 'actions' && (
                <>
                    <CustomInstructionsSection />

                    <ActionsPreferenceSection />
                </>
            )}

            {/* ===== ADVANCED TAB ===== */}
            {activeTab === 'advanced' && (
                <>
                    <div className="display-flex flex-row items-center gap-2" style={{ marginTop: '20px', marginBottom: '6px', paddingLeft: '2px' }}>
                        <div className="text-lg font-color-primary font-bold">MCP Server</div>
                        <span className="text-xs font-color-secondary px-15 py-05 rounded-md bg-quinary border-quinary">Experimental</span>
                    </div>
                    <SettingsGroup>
                        <div className="display-flex flex-col gap-05 flex-1 min-w-0" style={{ padding: '8px 12px' }}>
                            <div className="font-color-secondary text-base">
                                The MCP server lets AI coding tools like Claude Code, Cursor, and Windsurf search and access your Zotero library.
                                {' '}See our <DocLink path="mcp-server">MCP server guide</DocLink> for setup instructions.
                            </div>
                        </div>
                    </SettingsGroup>
                    <SettingsGroup>
                        <SettingsRow
                            title="Enable MCP Server"
                            description={`Endpoint at localhost:${mcpServerPort}`}
                            onClick={handleMcpServerToggle}
                            disabled={!isMcpServerSupported}
                            tooltip={isMcpServerSupported
                                ? 'Expose your Zotero library to MCP-compatible AI tools'
                                : 'Only available with Beaver Pro'}
                            control={
                                <div className="display-flex flex-row items-center gap-2">
                                    <input
                                        type="checkbox"
                                        checked={mcpServerEnabled}
                                        onChange={handleMcpServerToggle}
                                        onClick={(e) => e.stopPropagation()}
                                        disabled={!isMcpServerSupported}
                                        style={{ cursor: isMcpServerSupported ? 'pointer' : 'not-allowed', margin: 0 }}
                                    />
                                </div>
                            }
                        />
                        <SettingsRow
                            title="Config for HTTP Clients"
                            description={
                                <span className="display-flex flex-col gap-05" style={{ opacity: mcpServerEnabled ? 1 : 0.45 }}>
                                    <span>For clients that support HTTP directly (e.g., Claude Code, Cursor).</span>
                                    {/* <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>{mcpEndpointUrl}</span> */}
                                </span>
                            }
                            hasBorder
                            disabled={!mcpServerEnabled}
                            control={
                                <Button
                                    variant="outline"
                                    icon={mcpHttpCopied ? TickIcon : CopyIcon}
                                    onClick={handleCopyMcpHttpConfig}
                                    disabled={!mcpServerEnabled}
                                >
                                    {mcpHttpCopied ? 'Copied' : 'Copy'}
                                </Button>
                            }
                        />
                        <SettingsRow
                            title="Config for HTTPS-Only Clients"
                            description={
                                <span style={{ opacity: mcpServerEnabled ? 1 : 0.45 }}>
                                    For clients that only connect to HTTPS endpoints (e.g., Claude Desktop). Requires Node.js.
                                </span>
                            }
                            hasBorder
                            disabled={!mcpServerEnabled}
                            control={
                                <Button
                                    variant="outline"
                                    icon={mcpCopied ? TickIcon : CopyIcon}
                                    onClick={handleCopyMcpConfig}
                                    disabled={!mcpServerEnabled}
                                >
                                    {mcpCopied ? 'Copied' : 'Copy'}
                                </Button>
                            }
                        />
                    </SettingsGroup>
                </>
            )}

            {/* Spacer at the bottom */}
            {/* <div style={{ height: "20px" }} /> */}
          </div>
        </div>
    );
};

export default PreferencePage;
