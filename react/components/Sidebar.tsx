// @ts-ignore no idea
import React, { useRef, useEffect, useState } from 'react';
import InputArea from "./InputArea"
import Header from "./Header"
import { MessagesArea } from "./MessagesArea"
import { currentThreadIdAtom, threadMessagesAtom } from '../atoms/threads';
import { useSetAtom, useAtomValue, useAtom } from 'jotai';
import { ScrollDownButton } from './ScrollDownButton';
import { scrollToBottom } from '../utils/scrollToBottom';
import { activePreviewAtom, isPreferencePageVisibleAtom, userScrolledAtom } from '../atoms/ui';
import WelcomePage from './WelcomePage';
import LoginPage from './LoginPage';
import PreferencePage from './PreferencePage';
import { isAuthenticatedAtom } from '../atoms/auth';
import PreviewContainer from './PreviewContainer';
import DragDropWrapper from './DragDropWrapper';
import PopupMessageContainer from './PopupMessageContainer';

const Sidebar = ({ location }: { location: 'library' | 'reader' }) => {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const loginEmailRef = useRef<HTMLInputElement>(null);
    const threadId = useAtomValue(currentThreadIdAtom);
    const threadMessages = useAtomValue(threadMessagesAtom);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const [userScrolled, setUserScrolled] = useAtom(userScrolledAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const isPreferencePageVisible = useAtomValue(isPreferencePageVisibleAtom);
    const activePreview = useAtomValue(activePreviewAtom);

    useEffect(() => {
        if (messagesContainerRef.current) {
            scrollToBottom(messagesContainerRef, false);
        }
    }, [threadId]);
    
    const handleScrollToBottom = () => {
        if (messagesContainerRef.current) {
            setUserScrolled(false);
            scrollToBottom(messagesContainerRef, false);
        }
    };

    {/* Login page */}
    if (!isAuthenticated) {
        return (
            <div className="bg-sidepane h-full display-flex flex-col min-w-0">
                <Header />
                <LoginPage emailInputRef={loginEmailRef} />
            </div>
        );
    }

    {/* Preference page */}
    if (isPreferencePageVisible) {
        return (
            <div className="bg-sidepane h-full display-flex flex-col min-w-0">
                <Header settingsPage={true}/>
                <PreferencePage />
            </div>
        );
    }

    {/* Main page */}
    return (
        <div className="bg-sidepane h-full display-flex flex-col min-w-0">
            
            {/* Header */}
            <Header />

            {/* Messages area (scrollable) */}
            {threadMessages.length > 0 ? (
                <MessagesArea 
                    messages={threadMessages} 
                    userScrolled={userScrolled} 
                    setUserScrolled={setUserScrolled}
                    ref={messagesContainerRef}
                />
            ) : (
                <WelcomePage />
            )}

            {/* Prompt area (footer) with floating elements */}
            <div id="beaver-prompt" className="flex-none px-3 pb-3 relative">
                <PopupMessageContainer />
                <div className="relative w-full h-0">
                    <div className={`transition-opacity duration-300 ${userScrolled && !activePreview ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
                        <ScrollDownButton onClick={handleScrollToBottom} />
                    </div>
                </div>
                <PreviewContainer />
                <DragDropWrapper>
                    <InputArea inputRef={inputRef} />
                </DragDropWrapper>
            </div>
        </div>
    );
};

export default Sidebar;