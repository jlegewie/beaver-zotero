import React, { useState, useCallback, useMemo } from "react";
import { useAtom, useAtomValue } from 'jotai';
import { logoutAtom, userAtom } from '../../atoms/auth';
import { getPref, setPref } from '../../../src/utils/prefs';
import { UserIcon, LogoutIcon, RepeatIcon, SettingsIcon, Icon, SearchIcon, LockIcon, KeyIcon, ZapIcon, ToolsIcon, DollarCircleIcon } from '../icons/icons';
import Button from "@beaver/agent-ui/primitives/Button";
import { useSetAtom } from 'jotai';
import { profileWithPlanAtom, creditPlanAtom, hasCreditPlanAtom } from "../../atoms/profile";
import { activePreferencePageTabAtom, PreferencePageTab } from "../../atoms/ui";
import { logger } from "@beaver/agent-core/platform/logger";
import { isDiffPreviewSupported } from "../../utils/noteEditorDiffPreview";
import { 
    embeddingIndexStateAtom, 
    forceReindexAtom, 
    isEmbeddingIndexingAtom 
} from "../../atoms/embeddingIndex";
import { accountService } from "@beaver/agent-core/transport/clients/accountService";
import {SettingsGroup, SettingsRow, SectionLabel} from "./components/SettingsElements";
import ActionsPreferenceSection from "./ActionsPreferenceSection";
import BillingSection, { formatPlanName } from "./BillingSection";
import ApiKeysSection from "./ApiKeysSection";
import AdvancedSection from "./AdvancedSection";
import PermissionsSection from "./PermissionsSection";
import EmbeddingIndexProgress from "../pages/onboarding/EmbeddingIndexProgress";
import ExcludedLibrariesList from "./ExcludedLibrariesList";


const PreferencePage: React.FC = () => {
    const [user] = useAtom(userAtom);
    const logout = useSetAtom(logoutAtom);

    // --- User profile ---
    const [profileWithPlan, setProfileWithPlan] = useAtom(profileWithPlanAtom);

    // --- State for Preferences ---
    const [citationFormat, setCitationFormat] = useState(() => getPref('citationFormat') === 'numeric');
    const [useTemporaryCitationAnnotations, setUseTemporaryCitationAnnotations] = useState(() => getPref('useTemporaryCitationAnnotations') === true);
    const [keyboardShortcut, setKeyboardShortcut] = useState(() => {
        const shortcut = getPref('keyboardShortcut');
        return /^[a-z]$/i.test(shortcut) ? shortcut.toUpperCase() : 'J';
    });
    const [addSelectedOnNewThread, setAddSelectedOnNewThread] = useState(() => getPref('addSelectedItemsOnNewThread'));
    const [addSelectedOnOpen, setAddSelectedOnOpen] = useState(() => getPref('addSelectedItemsOnOpen'));
    const [addProvenanceNote, setAddProvenanceNote] = useState(() => getPref('addBeaverProvenanceNote'));
    const [focusResponseForScreenReaders, setFocusResponseForScreenReaders] = useState(() => getPref('focusResponseForScreenReaders'));
    const [showDiffPreview, setShowDiffPreview] = useState(() => getPref('showDiffPreviewInNoteEditor') !== false);
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
    
    // --- Embedding Index ---
    const embeddingIndexState = useAtomValue(embeddingIndexStateAtom);
    const isEmbeddingIndexing = useAtomValue(isEmbeddingIndexingAtom);
    const forceReindex = useSetAtom(forceReindexAtom);

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
            text: 'Check & Repair'
        };
    };

    const rebuildIndexButtonProps = getRebuildIndexButtonProps();
    const sidebarShortcutLabel = `${Zotero.isMac ? '⌘' : 'Ctrl'}+${keyboardShortcut}`;
    const windowShortcutLabel = `${Zotero.isMac ? '⌘⇧' : 'Ctrl+Shift'}+${keyboardShortcut}`;
    type VisiblePreferencePageTab = Exclude<PreferencePageTab, 'account'>;
    const tabs = useMemo<{ id: VisiblePreferencePageTab; label: string; icon: React.ComponentType<React.SVGProps<SVGSVGElement>> | React.ReactElement }[]>(() => [
        { id: 'general', label: 'General', icon: SettingsIcon },
        { id: 'sync', label: 'Search', icon: SearchIcon },
        { id: 'permissions', label: 'Permissions', icon: LockIcon },
        { id: 'billing', label: 'Plan & Usage', icon: DollarCircleIcon },
        { id: 'models', label: 'API Keys', icon: KeyIcon },
        { id: 'actions', label: 'Actions', icon: ZapIcon },
        { id: 'advanced', label: 'Advanced', icon: ToolsIcon },
    ], []);
    const effectiveActiveTab: VisiblePreferencePageTab = activeTab === 'account' ? 'general' : activeTab;

    const handleTabKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        const navigationKeys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
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
                : event.key === 'ArrowLeft'
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

    return (
        <div
            id="beaver-preferences"
            className="flex-1 min-h-0 overflow-y-auto scrollbar min-w-0"
        >
          <div className="display-flex flex-col gap-2 p-4">
            <div className="display-flex flex-row items-center gap-3 px-1">
                <Icon icon={SettingsIcon} className="scale-16 mt-020" aria-hidden="true" focusable="false" />
                <h1 id="beaver-preferences-title" className="text-2xl font-semibold  font-color-primary" style={{ marginBlock: "0rem" }}>
                    Settings
                </h1>
                {/* <Button variant="outline" rightIcon={CancelIcon} onClick={() => togglePreferencePage((prev) => !prev)} className="mt-1">Close</Button> */}
            </div>


            <div
                role="tablist"
                aria-label="Settings sections"
                className="display-flex flex-row items-center mb-3 mt-2"
                style={{ borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--fill-quarternary)', width: 'fit-content' }}
                onKeyDown={handleTabKeyDown}
            >
                {tabs.map((tab, index) => (
                    <button
                        key={tab.id}
                        type="button"
                        onClick={() => setActiveTab(tab.id)}
                        id={`beaver-preferences-tab-${tab.id}`}
                        role="tab"
                        aria-selected={tab.id === effectiveActiveTab}
                        aria-controls="beaver-preferences-panel"
                        tabIndex={tab.id === effectiveActiveTab ? 0 : -1}
                        className="text-base"
                        style={{
                            borderLeft: index > 0 ? '1px solid var(--fill-quarternary)' : 'none',
                            borderTop: 'none',
                            borderBottom: 'none',
                            borderRight: 'none',
                            borderRadius: 0,
                            background: tab.id === effectiveActiveTab ? 'var(--fill-quinary)' : 'transparent',
                            color: tab.id === effectiveActiveTab ? 'var(--fill-primary)' : 'var(--fill-secondary)',
                            padding: '6px 12px',
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

            <div
                role="tabpanel"
                id="beaver-preferences-panel"
                aria-labelledby={`beaver-preferences-tab-${effectiveActiveTab}`}
            >
            {/* ===== GENERAL TAB ===== */}
            {effectiveActiveTab === 'general' && (
                <>
                    {user ? (
                        <>
                            <SettingsGroup>
                                <SettingsRow
                                    title="Manage Account"
                                    description={<>Signed in as {user.email} ({hasCreditPlan ? `${formatPlanName(creditPlan.plan ?? undefined)} plan` : 'No active plan'})</>}
                                    control={
                                        <Button
                                            variant="outline"
                                            icon={UserIcon}
                                            onClick={() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/login')}
                                            style={{ padding: '4px 6px' }}
                                        >
                                            Open
                                        </Button>
                                    }
                                />
                                <SettingsRow
                                    title="Sign Out"
                                    description="End your current session"
                                    hasBorder
                                    control={
                                        <Button variant="outline" icon={LogoutIcon} onClick={logout} style={{ padding: '4px 6px' }}>
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
                                    title="Add Provenance Note to Imported Items"
                                    description="Add a child note with a conversation link to Beaver conversation"
                                    onClick={handleAddProvenanceNoteToggle}
                                    hasBorder
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
            {effectiveActiveTab === 'sync' && (
                <>
                    <SectionLabel>Libraries</SectionLabel>
                    <ExcludedLibrariesList />

                    <SectionLabel>Search Index</SectionLabel>
                    <SettingsGroup>
                        <SettingsRow
                            title="Search Index"
                            description={
                                <>
                                    Check that the local search index matches your Zotero libraries.
                                    This usually happens automatically, but you can run a manual check if search results look out of date.
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
                                    rightIcon={!isEmbeddingIndexing ? rebuildIndexButtonProps.icon : undefined}
                                    iconClassName={rebuildIndexButtonProps.iconClassName}
                                    onClick={handleRebuildSearchIndex}
                                    disabled={rebuildIndexButtonProps.disabled}
                                    loading={isEmbeddingIndexing}
                                    style={{ padding: '4px 6px' }}
                                >
                                    {rebuildIndexButtonProps.text}
                                </Button>
                            }
                        />
                        {isEmbeddingIndexing && embeddingIndexState.phase === 'initial' && embeddingIndexState.totalItems > 0 && (
                            <EmbeddingIndexProgress />
                        )}
                    </SettingsGroup>
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

            {/* ===== MODELS & API KEYS TAB ===== */}
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

            {/* Spacer at the bottom */}
            {/* <div style={{ height: "20px" }} /> */}
          </div>
        </div>
    );
};

export default PreferencePage;
