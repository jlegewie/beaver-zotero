import React, { useRef, useEffect } from 'react';
import InputArea from "./input/InputArea"
import Header from "./Header"
import { MessagesArea } from "./messages/MessagesArea"
import { currentThreadIdAtom, threadMessagesAtom } from '../atoms/threads';
import { useAtomValue, useSetAtom } from 'jotai';
import { ScrollDownButton } from './ui/buttons/ScrollDownButton';
import { scrollToBottom } from '../utils/scrollToBottom';
import { isPreferencePageVisibleAtom, userScrolledAtom, isSkippedFilesDialogVisibleAtom } from '../atoms/ui';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import OnboardingPage from './pages/OnboardingPage';
import PreferencePage from './pages/PreferencePage';
import DeviceAuthorizationPage from './pages/DeviceAuthorizationPage';
import { isAuthenticatedAtom } from '../atoms/auth';
import PreviewContainer from './previews/PreviewContainer';
import DragDropWrapper from './input/DragDropWrapper';
import PopupMessageContainer from './ui/popup/PopupMessageContainer';
import ErrorReportDialog from './ErrorReportDialog';
import { hasAuthorizedAccessAtom, hasCompletedOnboardingAtom, isDeviceAuthorizedAtom, isProfileLoadedAtom } from '../atoms/profile';
import { store } from '../store';
import SkippedFilesDialog from './status/SkippedFilesDialog';

const Sidebar = ({ location }: { location: 'library' | 'reader' }) => {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const loginEmailRef = useRef<HTMLInputElement>(null);
    const threadId = useAtomValue(currentThreadIdAtom);
    const threadMessages = useAtomValue(threadMessagesAtom);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const setIsSkippedFilesDialogVisible = useSetAtom(isSkippedFilesDialogVisibleAtom);
    const isPreferencePageVisible = useAtomValue(isPreferencePageVisibleAtom);
    const hasCompletedOnboarding = useAtomValue(hasCompletedOnboardingAtom);
    const hasAuthorizedAccess = useAtomValue(hasAuthorizedAccessAtom);
    const isDeviceAuthorized = useAtomValue(isDeviceAuthorizedAtom);
    const isProfileLoaded = useAtomValue(isProfileLoadedAtom);

    useEffect(() => {
        if (messagesContainerRef.current) {
            scrollToBottom(messagesContainerRef, false);
        }
    }, [threadId]);

    useEffect(() => {
        setIsSkippedFilesDialogVisible(false);
    }, []);
    
    const handleScrollToBottom = () => {
        if (messagesContainerRef.current) {
            store.set(userScrolledAtom, false);
            scrollToBottom(messagesContainerRef, false);
        }
    };

    {/* Login page */}
    if (!isAuthenticated || !isProfileLoaded) {
        return (
            <div className="bg-sidepane h-full display-flex flex-col min-w-0 relative">
                <Header />
                <LoginPage emailInputRef={loginEmailRef} />
                <ErrorReportDialog />
                <SkippedFilesDialog />
            </div>
        );
    }

    {/* Onboarding page */}
    if(!hasAuthorizedAccess || !hasCompletedOnboarding) {
        return (
            <div className="bg-sidepane h-full display-flex flex-col min-w-0 relative">
                <Header />
                <OnboardingPage />
                <ErrorReportDialog />
                <SkippedFilesDialog />
            </div>
        );
    }

    {/* Device authorization page */}
    if (!isDeviceAuthorized) {
        return (
            <div className="bg-sidepane h-full display-flex flex-col min-w-0 relative">
                <Header />
                <DeviceAuthorizationPage />
                <ErrorReportDialog />
                <SkippedFilesDialog />
            </div>
        );
    }

    {/* Preference page */}
    if (isPreferencePageVisible) {
        return (
            <div className="bg-sidepane h-full display-flex flex-col min-w-0 relative">
                <Header settingsPage={true}/>
                <PreferencePage />
                <ErrorReportDialog />
                <SkippedFilesDialog />
            </div>
        );
    }

    {/* Main page */}
    return (
        <div className="bg-sidepane h-full display-flex flex-col min-w-0 relative">
            
            {/* Header */}
            <Header />

            {/* Messages area (scrollable) */}
            {threadMessages.length > 0 ? (
                <MessagesArea 
                    messages={threadMessages} 
                    ref={messagesContainerRef}
                />
            ) : (
                <HomePage />
            )}

            {/* Prompt area (footer) with floating elements */}
            <div id="beaver-prompt" className="flex-none px-3 pb-3 relative">
                <PopupMessageContainer />
                <ScrollDownButton onClick={handleScrollToBottom} />
                <PreviewContainer />
                <DragDropWrapper>
                    <InputArea inputRef={inputRef} />
                </DragDropWrapper>
            </div>

            {/* Error Report Dialog */}
            <ErrorReportDialog />
            <SkippedFilesDialog />
        </div>
    );
};

export default Sidebar;