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
import DialogContainer from './dialog/DialogContainer';
import { hasAuthorizedAccessAtom, hasCompletedOnboardingAtom, isDeviceAuthorizedAtom, isProfileLoadedAtom } from '../atoms/profile';
import { store } from '../store';
import { isLoadingThreadAtom } from '../atoms/threads';
import { Spinner } from './icons/icons';

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
    const isLoadingThread = useAtomValue(isLoadingThreadAtom);

    useEffect(() => {
        if (isLoadingThread) return;
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

    if (isLoadingThread) {
        return (
            <div id="thread-loading" className="display-flex flex-col flex-1 w-full">
                <Header />
                <div className="display-flex flex-1 items-center justify-center">
                    <div className="display-flex flex-col items-center gap-3">
                        <Spinner size={22}/>
                        <span className="font-color-tertiary">Loading...</span>
                    </div>
                </div>
            </div>
        );
    }

    {/* Login page */}
    if (!isAuthenticated || !isProfileLoaded) {
        return (
            <div className="bg-sidepane h-full display-flex flex-col min-w-0 relative">
                <Header />
                <LoginPage emailInputRef={loginEmailRef} />
                <DialogContainer />
            </div>
        );
    }

    {/* Onboarding page */}
    if(!hasAuthorizedAccess || !hasCompletedOnboarding) {
        return (
            <div className="bg-sidepane h-full display-flex flex-col min-w-0 relative">
                <Header />
                <OnboardingPage />
                <DialogContainer />
            </div>
        );
    }

    {/* Device authorization page */}
    if (!isDeviceAuthorized) {
        return (
            <div className="bg-sidepane h-full display-flex flex-col min-w-0 relative">
                <Header />
                <DeviceAuthorizationPage />
                <DialogContainer />
            </div>
        );
    }

    {/* Preference page */}
    if (isPreferencePageVisible) {
        return (
            <div className="bg-sidepane h-full display-flex flex-col min-w-0 relative">
                <Header settingsPage={true}/>
                <PreferencePage />
                <DialogContainer />
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

            {/* Dialog Container */}
            <DialogContainer />
        </div>
    );
};

export default Sidebar;