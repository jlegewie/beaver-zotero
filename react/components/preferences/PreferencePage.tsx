import { usePreference } from '../../hooks/usePreference';
import React, { useState, useCallback, useMemo } from "react";
import { useAtom, useAtomValue } from 'jotai';
import { logoutAtom, userAtom } from '../../atoms/auth';
import { getPref, setPref } from '../../../src/utils/prefs';
import { UserIcon, LogoutIcon, SettingsIcon, Icon, SearchIcon, LockIcon, KeyIcon, ZapIcon, ToolsIcon, DollarCircleIcon } from '../icons/icons';
import { useSetAtom } from 'jotai';
import { runStatusPopupEnabledAtom } from '../../atoms/runStatusPopup';
import { profileWithPlanAtom, creditPlanAtom, hasCreditPlanAtom } from "../../atoms/profile";
import { activePreferencePageTabAtom, PreferencePageTab } from "../../atoms/ui";
import { logger } from "@beaver/agent-core/platform/logger";
import { isDiffPreviewSupported } from "../../utils/noteEditorDiffPreview";
import { accountService } from "@beaver/agent-core/transport/clients/accountService";
import {SettingsGroup, SettingsRow, SectionLabel, PageHeader} from "./components/SettingsElements";
import ActionsPreferenceSection from "./ActionsPreferenceSection";
import BillingSection, { formatPlanName } from "./BillingSection";
import ApiKeysSection from "./ApiKeysSection";
import AdvancedSection from "./AdvancedSection";
import PermissionsSection from "./PermissionsSection";
import LibraryAccessList from "./LibraryAccessList";
import BackgroundProcessingSection from "./BackgroundProcessingSection";
import { normalizeChatLineSpacing } from '../../utils/chatLineSpacing';


const PreferencePage: React.FC = () => {
    const [user] = useAtom(userAtom);
    const logout = useSetAtom(logoutAtom);

    // --- User profile ---
    const profileWithPlan = useAtomValue(profileWithPlanAtom);

    // --- State for Preferences ---
    const [citationFormat, setCitationFormat] = usePreference(() => getPref('citationFormat') === 'numeric');
    const [useTemporaryCitationAnnotations, setUseTemporaryCitationAnnotations] = usePreference(() => getPref('useTemporaryCitationAnnotations') === true);
    const [keyboardShortcut, setKeyboardShortcut] = usePreference(() => {
        const shortcut = getPref('keyboardShortcut');
        return /^[a-z]$/i.test(shortcut) ? shortcut.toUpperCase() : 'J';
    });
    const [addSelectedOnNewThread, setAddSelectedOnNewThread] = usePreference(() => getPref('addSelectedItemsOnNewThread'));
    const [addSelectedOnOpen, setAddSelectedOnOpen] = usePreference(() => getPref('addSelectedItemsOnOpen'));
    const [runStatusPopupEnabled, setRunStatusPopupEnabled] = useAtom(runStatusPopupEnabledAtom);
    const [addProvenanceNote, setAddProvenanceNote] = usePreference(() => getPref('addBeaverProvenanceNote'));
    const [focusResponseForScreenReaders, setFocusResponseForScreenReaders] = usePreference(() => getPref('focusResponseForScreenReaders'));
    const [chatLineSpacing, setChatLineSpacing] = usePreference(() =>
        normalizeChatLineSpacing(getPref('chatLineSpacing')),
    );
    const [showDiffPreview, setShowDiffPreview] = usePreference(() => getPref('showDiffPreviewInNoteEditor') !== false);
    const diffPreviewSupported = isDiffPreviewSupported();
    const [consentToShare, setConsentToShare] = useState(() => profileWithPlan?.consent_to_share || false);
    const [emailNotifications, setEmailNotifications] = useState(() => profileWithPlan?.email_notifications || false);
    const creditPlan = useAtomValue(creditPlanAtom);
    const hasCreditPlan = useAtomValue(hasCreditPlanAtom);
    const [activeTab, setActiveTab] = useAtom(activePreferencePageTabAtom);

    // Update local state when atom changes
    React.useEffect(() => {
        setConsentToShare(profileWithPlan?.consent_to_share || false);
        setEmailNotifications(profileWithPlan?.email_notifications || false);
    }, [profileWithPlan?.consent_to_share, profileWithPlan?.email_notifications]);
    
    const handleKeyboardShortcutChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
        const nextShortcut = event.target.value.toLowerCase();
        if (!/^[a-z]$/.test(nextShortcut)) {
            return;
        }
        setKeyboardShortcut(nextShortcut.toUpperCase());
        if (nextShortcut !== getPref('keyboardShortcut')) {
            setPref('keyboardShortcut', nextShortcut);
            logger(`Updated keyboard shortcut to ${nextShortcut.toUpperCase()}`);
        }
    }, []);

    // --- Consent Toggle Change Handler ---
    const handleConsentChange = useCallback(async (checked: boolean) => {
        const action = checked ? 'enable' : 'disable';
        try {
            logger(`User confirmed to ${action} consent to share. New value: ${checked}`);
            await Zotero.Beaver.account?.updatePreference('consent_to_share', checked);

            setConsentToShare(checked);
            logger('Successfully updated consent to share preference.');
        } catch (error) {
            logger(`Failed to update consent to share preference: ${error}`, 1);
            Zotero.logError(error as Error);
            // Revert the toggle on error
            setConsentToShare(!checked);
        }
    }, []);

    // --- Email Notifications Toggle Change Handler ---
    const handleEmailNotificationsChange = useCallback(async (checked: boolean) => {
        const action = checked ? 'enable' : 'disable';
        try {
            logger(`User confirmed to ${action} email notifications. New value: ${checked}`);
            await Zotero.Beaver.account?.updatePreference('email_notifications', checked);

            setEmailNotifications(checked);
            logger('Successfully updated email notifications preference.');
        } catch (error) {
            logger(`Failed to update email notifications preference: ${error}`, 1);
            Zotero.logError(error as Error);
            // Revert the toggle on error
            setEmailNotifications(!checked);
        }
    }, []);

    // --- Inline toggle handlers for card-based layout ---
    const handleCitationFormatToggle = useCallback(() => {
        const newChecked = !citationFormat;
        setPref("citationFormat", newChecked ? "numeric" : "author-year");
        setCitationFormat(newChecked);
    }, [citationFormat]);

    const handleTemporaryCitationAnnotationsToggle = useCallback(() => {
        const newValue = !useTemporaryCitationAnnotations;
        setPref("useTemporaryCitationAnnotations", newValue);
        setUseTemporaryCitationAnnotations(newValue);
    }, [useTemporaryCitationAnnotations]);

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

    const handleRunStatusPopupToggle = useCallback(() => {
        setRunStatusPopupEnabled(!runStatusPopupEnabled);
    }, [runStatusPopupEnabled, setRunStatusPopupEnabled]);

    const handleAddProvenanceNoteToggle = useCallback(() => {
        const newValue = !addProvenanceNote;
        setPref("addBeaverProvenanceNote", newValue);
        setAddProvenanceNote(newValue);
    }, [addProvenanceNote]);

    const handleFocusResponseForScreenReadersToggle = useCallback(() => {
        const newValue = !focusResponseForScreenReaders;
        setPref("focusResponseForScreenReaders", newValue);
        setFocusResponseForScreenReaders(newValue);
    }, [focusResponseForScreenReaders]);

    const handleChatLineSpacingChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
        const newValue = normalizeChatLineSpacing(event.target.value);
        setPref('chatLineSpacing', newValue);
        setChatLineSpacing(newValue);
    }, []);

    const handleShowDiffPreviewToggle = useCallback(() => {
        if (!diffPreviewSupported) return;
        const newValue = !showDiffPreview;
        setPref("showDiffPreviewInNoteEditor", newValue);
        setShowDiffPreview(newValue);
    }, [showDiffPreview, diffPreviewSupported]);

    const handleConsentToggle = useCallback(() => {
        handleConsentChange(!consentToShare);
    }, [consentToShare, handleConsentChange]);

    const handleEmailToggle = useCallback(() => {
        handleEmailNotificationsChange(!emailNotifications);
    }, [emailNotifications, handleEmailNotificationsChange]);

    const sidebarShortcutLabel = `${Zotero.isMac ? '⌘' : 'Ctrl'}+${keyboardShortcut}`;
    const windowShortcutLabel = `${Zotero.isMac ? '⌘⇧' : 'Ctrl+Shift'}+${keyboardShortcut}`;
    const quickPromptShortcutLabel = `${Zotero.isMac ? '⌘⌥' : 'Ctrl+Alt'}+${keyboardShortcut}`;
    type VisiblePreferencePageTab = Exclude<PreferencePageTab, 'account'>;
    interface PreferenceTabDefinition {
        id: VisiblePreferencePageTab;
        label: string;
        icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
        /** The page renders its own title row (e.g. to place buttons next to it). */
        ownsHeader?: boolean;
    }
    const tabs = useMemo<PreferenceTabDefinition[]>(() => [
        { id: 'general', label: 'General', icon: SettingsIcon },
        { id: 'sync', label: 'Search & Files', icon: SearchIcon },
        { id: 'permissions', label: 'Permissions', icon: LockIcon },
        { id: 'billing', label: 'Plan & Usage', icon: DollarCircleIcon },
        { id: 'models', label: 'API Keys', icon: KeyIcon },
        { id: 'actions', label: 'Actions', icon: ZapIcon, ownsHeader: true },
        { id: 'advanced', label: 'Advanced', icon: ToolsIcon },
    ], []);
    const effectiveActiveTab: VisiblePreferencePageTab = activeTab === 'account' ? 'general' : activeTab;
    const activeTabDefinition = tabs.find((tab) => tab.id === effectiveActiveTab) ?? tabs[0];

    // The tab list is vertical: Up/Down move between tabs (wrapping), Home/End jump to the ends.
    const handleTabKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        const navigationKeys = ['ArrowUp', 'ArrowDown', 'Home', 'End'];
        if (!navigationKeys.includes(event.key)) {
            return;
        }

        event.preventDefault();
        const currentIndex = tabs.findIndex((tab) => tab.id === effectiveActiveTab);
        const normalizedIndex = currentIndex >= 0 ? currentIndex : 0;
        const nextIndex = event.key === 'Home'
            ? 0
            : event.key === 'End'
                ? tabs.length - 1
                : event.key === 'ArrowUp'
                    ? (normalizedIndex - 1 + tabs.length) % tabs.length
                    : (normalizedIndex + 1) % tabs.length;
        const nextTab = tabs[nextIndex];
        setActiveTab(nextTab.id);
        event.currentTarget.ownerDocument
            .getElementById(`beaver-preferences-tab-${nextTab.id}`)
            ?.focus();
    }, [effectiveActiveTab, setActiveTab, tabs]);

    // Backward compatibility for existing entry points that still request "account".
    React.useEffect(() => {
        if (activeTab === 'account') {
            setActiveTab('general');
        }
    }, [activeTab, setActiveTab]);

    const planLabel = hasCreditPlan ? `${formatPlanName(creditPlan.plan ?? undefined)} plan` : 'No active plan';
    const accountInitial = user?.email?.trim().charAt(0) || '?';

    return (
        <div
            id="beaver-preferences"
            className="flex-1 min-h-0 min-w-0 display-flex flex-row"
        >
            {/* ===== SIDEBAR: section tabs, account ===== */}
            <div className="beaver-prefs-sidebar display-flex flex-col flex-shrink-0 min-h-0 border-right-quinary">
                <div
                    role="tablist"
                    aria-label="Settings sections"
                    aria-orientation="vertical"
                    className="display-flex flex-col gap-05 flex-1 min-h-0 overflow-y-auto scrollbar"
                    style={{ padding: '14px 10px 0' }}
                    onKeyDown={handleTabKeyDown}
                >
                    {tabs.map((tab) => (
                        <button
                            key={tab.id}
                            type="button"
                            onClick={() => setActiveTab(tab.id)}
                            id={`beaver-preferences-tab-${tab.id}`}
                            role="tab"
                            aria-selected={tab.id === effectiveActiveTab}
                            aria-controls="beaver-preferences-panel"
                            tabIndex={tab.id === effectiveActiveTab ? 0 : -1}
                            className="beaver-prefs-nav-item"
                        >
                            <Icon icon={tab.icon} aria-hidden="true" focusable="false" />
                            <span className="truncate">{tab.label}</span>
                        </button>
                    ))}
                </div>

                {/* Sign out sits with the navigation, below the tabs, so the
                    account block underneath stays a single, quiet control. */}
                {user && (
                    <div style={{ padding: '8px 10px' }}>
                        <button
                            type="button"
                            className="beaver-prefs-nav-item"
                            onClick={logout}
                            title="End your current session"
                        >
                            <Icon icon={LogoutIcon} aria-hidden="true" focusable="false" />
                            <span className="truncate">Sign out</span>
                        </button>
                    </div>
                )}

                {/* Account stays visible whichever section is open; clicking it
                    opens the Plan & Usage page. */}
                <div className="display-flex flex-col border-top-quinary" style={{ padding: '10px 10px 10px' }}>
                    {user ? (
                        <button
                            type="button"
                            className="beaver-prefs-account"
                            onClick={() => setActiveTab('billing')}
                            title={`${user.email} — open Plan & Usage`}
                            aria-label={`Account ${user.email}, ${planLabel}. Open Plan & Usage`}
                        >
                            <div className="beaver-prefs-avatar" aria-hidden="true">{accountInitial}</div>
                            <div className="display-flex flex-col min-w-0" aria-hidden="true">
                                <div className="text-base font-color-primary font-medium truncate">
                                    {user.email}
                                </div>
                                <div className="text-sm font-color-secondary truncate">{planLabel}</div>
                            </div>
                        </button>
                    ) : (
                        <div className="display-flex flex-row items-center gap-2 min-w-0" style={{ padding: '6px 8px' }}>
                            <div className="beaver-prefs-avatar" aria-hidden="true">
                                <Icon icon={UserIcon} />
                            </div>
                            <div className="text-base font-color-secondary">Not signed in</div>
                        </div>
                    )}
                    <div className="beaver-prefs-legal display-flex flex-row items-center gap-1">
                        <button
                            type="button"
                            onClick={() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/terms')}
                            className="text-link-muted text-xs"
                        >
                            Terms of Service
                        </button>
                        <span className="font-color-tertiary text-xs" aria-hidden="true">·</span>
                        <button
                            type="button"
                            onClick={() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/privacy-policy')}
                            className="text-link-muted text-xs"
                        >
                            Privacy Policy
                        </button>
                    </div>
                </div>
            </div>

            {/* ===== CONTENT: the selected section ===== */}
            <div className="beaver-prefs-content flex-1 min-h-0 min-w-0 overflow-y-auto scrollbar">
                <div
                    role="tabpanel"
                    id="beaver-preferences-panel"
                    aria-labelledby={`beaver-preferences-tab-${effectiveActiveTab}`}
                    className="beaver-prefs-page display-flex flex-col"
                >
                {!activeTabDefinition.ownsHeader && (
                    <PageHeader title={activeTabDefinition.label} />
                )}

                {/* ===== GENERAL TAB ===== */}
                {effectiveActiveTab === 'general' && (
                    <>
                        <SectionLabel>Sidebar</SectionLabel>
                        <SettingsGroup>
                            <SettingsRow
                                title="Keyboard Shortcut"
                                description={<>Sidebar: {sidebarShortcutLabel} &middot; Window: {windowShortcutLabel} &middot; Quick prompt: {quickPromptShortcutLabel} &middot; Changes require restart</>}
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
                                title="Add Selected Items and Collections to New Threads"
                                description="Automatically attach selected items and collections to new threads"
                                onClick={handleAddSelectedOnNewThreadToggle}
                                hasBorder
                                tooltip="When enabled, selected Zotero items and collections are attached when you start a new conversation, including from the quick prompt."
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
                                title="Run Status Popup"
                                description="Show what Beaver is doing in the corner of the window while the sidebar is closed"
                                onClick={handleRunStatusPopupToggle}
                                hasBorder
                                tooltip="When enabled, a small card in the bottom-right corner of the Zotero window shows the current run's progress, lets you approve pending changes, and reports when a response is ready."
                                control={
                                    <input
                                        type="checkbox"
                                        checked={runStatusPopupEnabled}
                                        onChange={handleRunStatusPopupToggle}
                                        onClick={(e) => e.stopPropagation()}
                                        style={{ cursor: 'pointer', margin: 0 }}
                                    />
                                }
                            />
                        </SettingsGroup>

                        <SectionLabel>Citations</SectionLabel>
                        <SettingsGroup>
                            <SettingsRow
                                title={`Citation Format: ${citationFormat ? 'Numeric' : 'Author-Year'}`}
                                description="Choose between numeric [1] or author-year (Smith, 2023) citations"
                                onClick={handleCitationFormatToggle}
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
                                title="Keep Cited Passages Highlighted"
                                description="When enabled, Beaver marks cited passages with temporary Zotero annotations that disappear on your next click. When disabled, Beaver briefly flashes the passage instead."
                                onClick={handleTemporaryCitationAnnotationsToggle}
                                hasBorder
                                tooltip="When disabled, citations use Zotero's transient PDF position highlight instead."
                                control={
                                    <input
                                        type="checkbox"
                                        checked={useTemporaryCitationAnnotations}
                                        onChange={handleTemporaryCitationAnnotationsToggle}
                                        onClick={(e) => e.stopPropagation()}
                                        style={{ cursor: 'pointer', margin: 0 }}
                                    />
                                }
                            />
                        </SettingsGroup>

                        <SectionLabel>Notes</SectionLabel>
                        <SettingsGroup>
                            <SettingsRow
                                title="Add Provenance Note to Imported Items"
                                description="Add a child note with a conversation link to Beaver conversation"
                                onClick={handleAddProvenanceNoteToggle}
                                control={
                                    <input
                                        type="checkbox"
                                        checked={addProvenanceNote}
                                        onChange={handleAddProvenanceNoteToggle}
                                        onClick={(e) => e.stopPropagation()}
                                        style={{ cursor: 'pointer', margin: 0 }}
                                    />
                                }
                            />
                            <SettingsRow
                                title="Preview Note Edits in Editor"
                                description={diffPreviewSupported
                                    ? "Show proposed note edits inline in the Zotero note editor"
                                    : "Requires Zotero 8 — unavailable on this version"}
                                onClick={diffPreviewSupported ? handleShowDiffPreviewToggle : undefined}
                                hasBorder
                                tooltip="When enabled, edit_note proposals appear as a colored diff directly in the note editor with Apply / Reject controls. When disabled, approvals fall back to the sidebar preview. Turn off if a Zotero update causes the in-editor preview to misbehave."
                                control={
                                    <input
                                        type="checkbox"
                                        checked={showDiffPreview && diffPreviewSupported}
                                        disabled={!diffPreviewSupported}
                                        onChange={handleShowDiffPreviewToggle}
                                        onClick={(e) => e.stopPropagation()}
                                        style={{ cursor: diffPreviewSupported ? 'pointer' : 'not-allowed', margin: 0 }}
                                    />
                                }
                            />
                        </SettingsGroup>

                        <SectionLabel>Accessibility</SectionLabel>
                        <SettingsGroup>
                            <SettingsRow
                                title="Chat Line Spacing"
                                description="Adjust the vertical spacing of chat messages for easier reading"
                                control={
                                    <select
                                        id="chat-line-spacing"
                                        value={chatLineSpacing}
                                        onChange={handleChatLineSpacingChange}
                                        className="py-1 px-2 border preference-input text-sm"
                                        style={{ minWidth: '104px', margin: 0 }}
                                        onClick={(event) => event.stopPropagation()}
                                    >
                                        <option value="compact">Compact</option>
                                        <option value="default">Default</option>
                                        <option value="relaxed">Relaxed</option>
                                    </select>
                                }
                            />
                            <SettingsRow
                                title="Announce Responses for Screen Readers"
                                description="Move focus to screen-reader text when Beaver starts and finishes generating a response"
                                onClick={handleFocusResponseForScreenReadersToggle}
                                hasBorder
                                tooltip="When enabled, focus moves from the chat input to screen-reader-only status text while Beaver generates, then to a screen-reader-only copy of the completed response."
                                control={
                                    <input
                                        type="checkbox"
                                        checked={focusResponseForScreenReaders}
                                        onChange={handleFocusResponseForScreenReadersToggle}
                                        onClick={(e) => e.stopPropagation()}
                                        style={{ cursor: 'pointer', margin: 0 }}
                                    />
                                }
                            />
                        </SettingsGroup>

                        {/* These two preferences live on the account, so they are only
                            offered while signed in. */}
                        {user && (
                            <>
                                <SectionLabel>Privacy</SectionLabel>
                                <SettingsGroup>
                                    <SettingsRow
                                        title="Help Improve Beaver"
                                        description="Share anonymized prompts to help improve Beaver"
                                        onClick={handleConsentToggle}
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
                            </>
                        )}
                    </>
                )}

                {/* ===== SEARCH & FILES TAB ===== */}
                {effectiveActiveTab === 'sync' && (
                    <>
                        <SectionLabel>Libraries</SectionLabel>
                        <LibraryAccessList />

                        <BackgroundProcessingSection />
                    </>
                )}

                {/* ===== PERMISSIONS TAB ===== */}
                {effectiveActiveTab === 'permissions' && (
                    <PermissionsSection />
                )}

                {/* ===== PLAN & USAGE TAB ===== */}
                {effectiveActiveTab === 'billing' && (
                    <BillingSection />
                )}

                {/* ===== API KEYS TAB ===== */}
                {effectiveActiveTab === 'models' && (
                    <ApiKeysSection />
                )}

                {/* ===== ACTIONS TAB ===== */}
                {effectiveActiveTab === 'actions' && (
                    <ActionsPreferenceSection />
                )}

                {/* ===== ADVANCED TAB ===== */}
                {effectiveActiveTab === 'advanced' && (
                    <AdvancedSection />
                )}
                </div>
            </div>
        </div>
    );
};

export default PreferencePage;
