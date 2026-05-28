import React, { useRef, useEffect, type ReactNode } from 'react';
import InputArea from "./input/InputArea"
import Header from "./Header"
import { useEventSubscription } from '../hooks/useEventSubscription';
import { ThreadView } from "./agentRuns";
import { currentThreadScrollPositionAtom, windowScrollPositionAtom } from '../atoms/threads';
import { allRunsAtom } from '../agents/atoms';
import { isFirstRunOrigin } from '../agents/types';
import { useAtomValue, useSetAtom } from 'jotai';
import { ScrollDownButton } from './ui/buttons/ScrollDownButton';
import { scrollToBottom } from '../utils/scrollToBottom';
import { userScrolledAtom, windowUserScrolledAtom, isSkippedFilesDialogVisibleAtom, isThreadListViewAtom } from '../atoms/ui';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import ProfileLoadingPage from './pages/ProfileLoadingPage';
import OnboardingRouter from './pages/OnboardingRouter';
import DeviceAuthorizationPage from './pages/DeviceAuthorizationPage';
import { isAuthenticatedAtom } from '../atoms/auth';
import DragDropWrapper from './input/DragDropWrapper';
import DialogContainer from './dialog/DialogContainer';
import ThreadListView from './ThreadListView';
import CreditInfoBar from './input/CreditInfoBar';
import EmbeddingIndexBar from './input/EmbeddingIndexBar';
import UpgradeConsentPage from './pages/UpgradeConsentPage';
import DowngradeAcknowledgmentPage from './pages/DowngradeAcknowledgmentPage';
import { store } from '../store';
import { isLoadingThreadAtom } from '../atoms/threads';
import { Spinner } from './icons/icons';
import { threadWarningsAtom } from '../atoms/warnings';
import PreviewAndPopupContainer from './PreviewAndPopupContainer';
import {
    hasAuthorizedFreeAccessAtom,
    hasAuthorizedProAccessAtom,
    hasCompletedOnboardingAtom,
    isDeviceAuthorizedAtom,
    isProfileLoadedAtom,
    isMigratingDataAtom,
    syncedLibrariesAtom,
    isDatabaseSyncSupportedAtom,
    pendingUpgradeConsentAtom,
    pendingDowngradeAckAtom,
    updateRequiredAtom
} from '../atoms/profile';
import UpdateRequiredPage from './pages/UpdateRequiredPage';
import FirstRunPage from './pages/FirstRunPage';
import { isFirstRunVisibleAtom } from '../atoms/firstRun';
import ScreenReaderRunAnnouncer from './agentRuns/ScreenReaderRunAnnouncer';

interface SidebarProps {
    location: 'library' | 'reader';
    isWindow?: boolean;
}

interface SidebarShellProps {
    children: ReactNode;
    className?: string;
    id?: string;
    isWindow: boolean;
}

/**
 * Provides a named Beaver landmark for screen reader navigation.
 */
const FOCUSABLE_SELECTOR = [
    'a[href]',
    'area[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Returns visible, sequentially focusable elements inside Beaver.
 */
const getFocusableElements = (root: HTMLElement): HTMLElement[] => {
    const win = root.ownerDocument.defaultView;
    if (!win) return [];

    const elements: HTMLElement[] = [];
    root.querySelectorAll(FOCUSABLE_SELECTOR).forEach((node) => {
        if (!(node instanceof win.HTMLElement)) return;
        if (node.tabIndex < 0) return;
        if ('disabled' in node && Boolean(node.disabled)) return;
        if (node.closest('[hidden],[aria-hidden="true"],[inert]')) return;

        const style = win.getComputedStyle(node);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return;
        if (node.getClientRects().length === 0) return;

        elements.push(node);
    });

    return elements;
};

const SidebarShell = ({
    children,
    className = "bg-sidepane h-full w-full display-flex flex-col min-w-0 relative",
    id,
    isWindow,
}: SidebarShellProps) => {
    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) {
            return;
        }

        const root = event.currentTarget;
        const activeElement = root.ownerDocument.activeElement;
        const win = root.ownerDocument.defaultView;
        if (!win || !(activeElement instanceof win.HTMLElement) || !root.contains(activeElement)) {
            return;
        }

        const focusableElements = getFocusableElements(root);
        const activeIndex = focusableElements.indexOf(activeElement);
        if (activeIndex === -1) {
            return;
        }

        const nextIndex = activeIndex + (event.shiftKey ? -1 : 1);
        if (nextIndex < 0 || nextIndex >= focusableElements.length) {
            return;
        }

        event.preventDefault();
        focusableElements[nextIndex].focus();
    };

    return (
        <div
            id={id}
            className={className}
            role={isWindow ? "main" : "region"}
            aria-label="Beaver"
            onKeyDown={handleKeyDown}
        >
            {children}
        </div>
    );
};

const Sidebar = ({ location, isWindow = false }: SidebarProps) => {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const loginEmailRef = useRef<HTMLInputElement>(null);
    const runs = useAtomValue(allRunsAtom);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const setIsSkippedFilesDialogVisible = useSetAtom(isSkippedFilesDialogVisibleAtom);
    const hasCompletedOnboarding = useAtomValue(hasCompletedOnboardingAtom);
    const hasAuthorizedFreeAccess = useAtomValue(hasAuthorizedFreeAccessAtom);
    const hasAuthorizedProAccess = useAtomValue(hasAuthorizedProAccessAtom);
    const syncedLibraries = useAtomValue(syncedLibrariesAtom);
    const isDatabaseSyncSupported = useAtomValue(isDatabaseSyncSupportedAtom);
    const isDeviceAuthorized = useAtomValue(isDeviceAuthorizedAtom);
    const isProfileLoaded = useAtomValue(isProfileLoadedAtom);
    const isLoadingThread = useAtomValue(isLoadingThreadAtom);
    const isMigratingData = useAtomValue(isMigratingDataAtom);
    const isThreadListView = useAtomValue(isThreadListViewAtom);
    const setIsThreadListView = useSetAtom(isThreadListViewAtom);

    const pendingUpgradeConsent = useAtomValue(pendingUpgradeConsentAtom);
    const pendingDowngradeAck = useAtomValue(pendingDowngradeAckAtom);
    const updateRequired = useAtomValue(updateRequiredAtom);
    const allWarnings = useAtomValue(threadWarningsAtom);
    const creditInfoWarning = allWarnings.findLast((w) => w.type === 'credit_info');
    const isFirstRunVisible = useAtomValue(isFirstRunVisibleAtom);

    useEffect(() => {
        setIsSkippedFilesDialogVisible(false);
    }, []);

    // Focus textarea when focusInput event is dispatched (e.g. reader "Ask..." button)
    useEventSubscription('focusInput', () => {
        setTimeout(() => inputRef.current?.focus(), 50);
    });

    // Select the correct atoms based on whether we're in the separate window
    const scrolledAtom = isWindow ? windowUserScrolledAtom : userScrolledAtom;
    const scrollPositionAtom = isWindow ? windowScrollPositionAtom : currentThreadScrollPositionAtom;

    // Determine if we're in the run view (has runs) or home view (no runs)
    const isThreadView = runs.length > 0;

    const handleScrollToBottom = () => {
        if (messagesContainerRef.current) {
            store.set(scrolledAtom, false);
            // Clear stored scroll position to let natural scroll-to-bottom take over
            store.set(scrollPositionAtom, null);
            scrollToBottom(messagesContainerRef, false);
        }
    };

    if (isLoadingThread || isMigratingData) {
        return (
            <SidebarShell
                id="thread-loading"
                className="display-flex flex-col flex-1 w-full"
                isWindow={isWindow}
            >
                <Header isWindow={isWindow} />
                <div className="display-flex flex-1 items-center justify-center">
                    <div className="display-flex flex-col items-center gap-3">
                        <Spinner size={22}/>
                        <span className="font-color-tertiary">
                            {isMigratingData ? "Upgrading your data..." : "Loading..."}
                        </span>
                    </div>
                </div>
            </SidebarShell>
        );
    }

    {/* Login page — only when there is no session at all. */}
    if (!isAuthenticated) {
        return (
            <SidebarShell isWindow={isWindow}>
                <Header isWindow={isWindow} />
                <LoginPage emailInputRef={loginEmailRef} />
                <DialogContainer />
            </SidebarShell>
        );
    }

    {/* Profile loading / connecting / offline / fatal-error page.
        Authenticated but profile not yet loaded — renders before LoginPage was the bug
        cause when a transient network failure cleared isProfileLoaded. */}
    if (!isProfileLoaded) {
        return (
            <SidebarShell isWindow={isWindow}>
                <Header isWindow={isWindow} />
                <ProfileLoadingPage />
                <DialogContainer />
            </SidebarShell>
        );
    }

    {/* Update required page - blocks access until user updates */}
    if (updateRequired) {
        return (
            <SidebarShell isWindow={isWindow}>
                <Header isWindow={isWindow} />
                <UpdateRequiredPage />
                <DialogContainer />
            </SidebarShell>
        );
    }

    {/* Plan transition: Downgrade acknowledgment page (Pro → Free) */}
    if (pendingDowngradeAck) {
        return (
            <SidebarShell isWindow={isWindow}>
                <Header isWindow={isWindow} />
                <DowngradeAcknowledgmentPage />
                <DialogContainer />
            </SidebarShell>
        );
    }

    {/* Plan transition: Upgrade consent page (Free → Pro) */}
    if (pendingUpgradeConsent) {
        return (
            <SidebarShell isWindow={isWindow}>
                <Header isWindow={isWindow} />
                <UpgradeConsentPage />
                <DialogContainer />
            </SidebarShell>
        );
    }

    {/* Onboarding page */}
    {/* Free users: need has_authorized_free_access only (no full onboarding required) */}
    {/* Pro users: need has_authorized_access AND has_completed_onboarding AND at least one library */}
    const isFreeUser = !isDatabaseSyncSupported;
    const needsOnboarding = isFreeUser 
        ? !hasAuthorizedFreeAccess 
        : (!hasAuthorizedProAccess || !hasCompletedOnboarding || syncedLibraries.length === 0);
    
    if (needsOnboarding) {
        return (
            <SidebarShell isWindow={isWindow}>
                <Header isWindow={isWindow} />
                <OnboardingRouter />
                <DialogContainer />
            </SidebarShell>
        );
    }

    {/* Device authorization page */}
    if (!isDeviceAuthorized) {
        return (
            <SidebarShell isWindow={isWindow}>
                <Header isWindow={isWindow} />
                <DeviceAuthorizationPage />
                <DialogContainer />
            </SidebarShell>
        );
    }

    {/* First-run suggestions page (see isFirstRunVisibleAtom in firstRun.ts):
        - explicit "Try another starting point" return (session atom), or
        - Free user, device authorized, never completed first-run on this account. */}
    if (isFirstRunVisible) {
        return (
            <SidebarShell isWindow={isWindow}>
                <ScreenReaderRunAnnouncer inputRef={inputRef} />
                <Header isWindow={isWindow} />
                <FirstRunPage isWindow={isWindow} inputRef={inputRef} />
                <DialogContainer />
            </SidebarShell>
        );
    }

    const handleCloseThreadList = () => {
        setIsThreadListView(false);
    };

    // First-run thread → swap input placeholder once a run with a first-run
    // origin lives in this thread (either the original card run, or a
    // follow-up triggered from NextStepsPanel). `runs` is the union of
    // completed (threadRunsAtom) + active runs, and `user_prompt.origin` is
    // set at submit time so we don't depend on the thread id arriving from
    // the WS callback.
    const isFirstRunThread = runs.some(
        (r) => isFirstRunOrigin(r.user_prompt?.origin),
    );
    const inputPlaceholder = isFirstRunThread ? 'Ask a follow-up question' : undefined;

    {/* Main page */}
    return (
        <SidebarShell isWindow={isWindow}>
            <ScreenReaderRunAnnouncer inputRef={inputRef} />

            {/* Header */}
            <Header isWindow={isWindow} />

            {/* Content area - relative container for overlay positioning */}
            <div className="flex-1 min-h-0 display-flex flex-col relative overflow-hidden">
                {/* Thread view with agent runs */}
                {isThreadView ? (
                    <ThreadView ref={messagesContainerRef} isWindow={isWindow} />
                ) : (
                    <HomePage isWindow={isWindow} inputRef={inputRef} />
                )}

                {/* Prompt area (footer) - only in thread view */}
                {isThreadView && (
                    <div id="beaver-prompt" className="flex-none px-3 pb-3 relative">
                        <PreviewAndPopupContainer />
                        <ScrollDownButton onClick={handleScrollToBottom} isWindow={isWindow} />
                        <DragDropWrapper>
                            <InputArea inputRef={inputRef} placeholder={inputPlaceholder} />
                        </DragDropWrapper>
                    </div>
                )}

                {/* Thread list overlay */}
                {isThreadListView && (
                    <div className="thread-overlay-container">
                        <div className="thread-overlay-backdrop" onClick={handleCloseThreadList} />
                        <div className="thread-overlay-panel">
                            <ThreadListView isWindow={isWindow} />
                        </div>
                    </div>
                )}
            </div>

            {/* Embedding index status bar - visible while indexing */}
            <EmbeddingIndexBar />

            {/* Credit info bar - always visible at bottom */}
            {creditInfoWarning && (
                <div className="flex-none px-2 pb-1 -mt-3">
                    <CreditInfoBar warning={creditInfoWarning} />
                </div>
            )}

            {/* Dialog Container */}
            <DialogContainer />
        </SidebarShell>
    );
};

export default Sidebar;
