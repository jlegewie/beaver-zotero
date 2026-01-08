import React, { useRef, useEffect } from 'react';
import InputArea from "./input/InputArea"
import Header from "./Header"
import { ThreadView } from "./agentRuns";
import { currentThreadScrollPositionAtom, windowScrollPositionAtom } from '../atoms/threads';
import { allRunsAtom } from '../agents/atoms';
import { useAtomValue, useSetAtom } from 'jotai';
import { ScrollDownButton } from './ui/buttons/ScrollDownButton';
import { scrollToBottom } from '../utils/scrollToBottom';
import { isPreferencePageVisibleAtom, userScrolledAtom, windowUserScrolledAtom, isSkippedFilesDialogVisibleAtom } from '../atoms/ui';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import OnboardingRouter from './pages/OnboardingRouter';
import PreferencePage from './pages/PreferencePage';
import DeviceAuthorizationPage from './pages/DeviceAuthorizationPage';
import { isAuthenticatedAtom, authLoadingAtom } from '../atoms/auth';
import DragDropWrapper from './input/DragDropWrapper';
import DialogContainer from './dialog/DialogContainer';
import UpgradeConsentPage from './pages/UpgradeConsentPage';
import DowngradeAcknowledgmentPage from './pages/DowngradeAcknowledgmentPage';
import { store } from '../store';
import { isLoadingThreadAtom } from '../atoms/threads';
import { Spinner } from './icons/icons';
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
    pendingDowngradeAckAtom
} from '../atoms/profile';

interface SidebarProps {
    location: 'library' | 'reader';
    isWindow?: boolean;
}

const Sidebar = ({ location, isWindow = false }: SidebarProps) => {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const loginEmailRef = useRef<HTMLInputElement>(null);
    const runs = useAtomValue(allRunsAtom);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const setIsSkippedFilesDialogVisible = useSetAtom(isSkippedFilesDialogVisibleAtom);
    const isPreferencePageVisible = useAtomValue(isPreferencePageVisibleAtom);
    const hasCompletedOnboarding = useAtomValue(hasCompletedOnboardingAtom);
    const hasAuthorizedFreeAccess = useAtomValue(hasAuthorizedFreeAccessAtom);
    const hasAuthorizedProAccess = useAtomValue(hasAuthorizedProAccessAtom);
    const syncedLibraries = useAtomValue(syncedLibrariesAtom);
    const isDatabaseSyncSupported = useAtomValue(isDatabaseSyncSupportedAtom);
    const isDeviceAuthorized = useAtomValue(isDeviceAuthorizedAtom);
    const isProfileLoaded = useAtomValue(isProfileLoadedAtom);
    const isLoadingThread = useAtomValue(isLoadingThreadAtom);
    const isMigratingData = useAtomValue(isMigratingDataAtom);
    const authLoading = useAtomValue(authLoadingAtom);
    const pendingUpgradeConsent = useAtomValue(pendingUpgradeConsentAtom);
    const pendingDowngradeAck = useAtomValue(pendingDowngradeAckAtom);

    useEffect(() => {
        setIsSkippedFilesDialogVisible(false);
    }, []);
    
    // Select the correct atoms based on whether we're in the separate window
    const scrolledAtom = isWindow ? windowUserScrolledAtom : userScrolledAtom;
    const scrollPositionAtom = isWindow ? windowScrollPositionAtom : currentThreadScrollPositionAtom;

    const handleScrollToBottom = () => {
        if (messagesContainerRef.current) {
            store.set(scrolledAtom, false);
            // Clear stored scroll position to let natural scroll-to-bottom take over
            store.set(scrollPositionAtom, null);
            scrollToBottom(messagesContainerRef, false);
        }
    };

    if (authLoading || isLoadingThread || isMigratingData) {
        return (
            <div id="thread-loading" className="display-flex flex-col flex-1 w-full">
                <Header isWindow={isWindow} />
                <div className="display-flex flex-1 items-center justify-center">
                    <div className="display-flex flex-col items-center gap-3">
                        <Spinner size={22}/>
                        <span className="font-color-tertiary">
                            {isMigratingData ? "Upgrading your data..." : "Loading..."}
                        </span>
                    </div>
                </div>
            </div>
        );
    }

    {/* Login page */}
    if (!isAuthenticated || !isProfileLoaded) {
        return (
            <div className="bg-sidepane h-full w-full display-flex flex-col min-w-0 relative">
                <Header isWindow={isWindow} />
                <LoginPage emailInputRef={loginEmailRef} />
                <DialogContainer />
            </div>
        );
    }

    {/* Plan transition: Downgrade acknowledgment page (Pro → Free) */}
    if (pendingDowngradeAck) {
        return (
            <div className="bg-sidepane h-full w-full display-flex flex-col min-w-0 relative">
                <Header isWindow={isWindow} />
                <DowngradeAcknowledgmentPage />
                <DialogContainer />
            </div>
        );
    }

    {/* Plan transition: Upgrade consent page (Free → Pro) */}
    if (pendingUpgradeConsent) {
        return (
            <div className="bg-sidepane h-full w-full display-flex flex-col min-w-0 relative">
                <Header isWindow={isWindow} />
                <UpgradeConsentPage />
                <DialogContainer />
            </div>
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
            <div className="bg-sidepane h-full w-full display-flex flex-col min-w-0 relative">
                <Header isWindow={isWindow} />
                <OnboardingRouter />
                <DialogContainer />
            </div>
        );
    }

    {/* Device authorization page */}
    if (!isDeviceAuthorized) {
        return (
            <div className="bg-sidepane h-full w-full display-flex flex-col min-w-0 relative">
                <Header isWindow={isWindow} />
                <DeviceAuthorizationPage />
                <DialogContainer />
            </div>
        );
    }

    {/* Preference page */}
    if (isPreferencePageVisible) {
        return (
            <div className="bg-sidepane h-full w-full display-flex flex-col min-w-0 relative">
                <Header settingsPage={true} isWindow={isWindow} />
                <PreferencePage />
                <DialogContainer />
            </div>
        );
    }

    {/* Main page */}
    return (
        <div className="bg-sidepane h-full w-full display-flex flex-col min-w-0 relative">
            
            {/* Header */}
            <Header isWindow={isWindow} />

            {/* Thread view with agent runs */}
            {runs.length > 0 ? (
                <ThreadView ref={messagesContainerRef} isWindow={isWindow} />
            ) : (
                <HomePage isWindow={isWindow} />
            )}

            {/* Prompt area (footer) with floating elements */}
            <div id="beaver-prompt" className="flex-none px-3 pb-3 relative">
                <PreviewAndPopupContainer />
                <ScrollDownButton onClick={handleScrollToBottom} isWindow={isWindow} />
                <DragDropWrapper>
                    <InputArea inputRef={inputRef} />
                </DragDropWrapper>
            </div>

            {/* Dialog Container */}
            <DialogContainer />
        </div>
    );
};

export default Sidebar;
