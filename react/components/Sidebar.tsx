// @ts-ignore no idea
import React, { useRef, useEffect, useState } from 'react';
import InputArea from "./InputArea"
import Header from "./Header"
import { MessagesArea } from "./MessagesArea"
import { threadMessagesAtom } from '../atoms/threads';
import { useSetAtom, useAtomValue } from 'jotai';
import { useZoteroSelection } from '../hooks/useZoteroSelection';
import { ScrollDownButton } from './ScrollDownButton';
import { scrollToBottom } from '../utils/scrollToBottom';
import { previewedSourceAtom } from '../atoms/ui';
import SourcePreview from './SourcePreview';
import WelcomePage from './WelcomePage';
import LoginPage from './LoginPage';
import { updateSourcesFromZoteroSelectionAtom } from '../atoms/input';
import { isAuthenticatedAtom } from '../atoms/auth';

const Sidebar = ({ location }: { location: 'library' | 'reader' }) => {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const threadMessages = useAtomValue(threadMessagesAtom);
    const updateSourcesFromZoteroSelection = useSetAtom(updateSourcesFromZoteroSelectionAtom);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const [userScrolled, setUserScrolled] = useState(false);
    const previewedSource = useAtomValue(previewedSourceAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    
    useZoteroSelection();
    
    useEffect(() => {
        // Focus the input
        inputRef.current?.focus();

        // Update sources based on Zotero selection
        updateSourcesFromZoteroSelection();
    }, []);
    
    const handleScrollToBottom = () => {
        if (messagesContainerRef.current) {
            setUserScrolled(false);
            scrollToBottom(messagesContainerRef, false);
        }
    };

    {/* Login page */}
    if (!isAuthenticated) {
        return (
            <div className="sidebar-container h-full flex flex-col min-w-0">
                <Header />
                <LoginPage />
            </div>
        );
    }

    {/* Main page */}
    return (
        <div className="sidebar-container h-full flex flex-col min-w-0">
            
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
                {userScrolled && !previewedSource && (
                    <div className="relative w-full h-0">
                        <ScrollDownButton onClick={handleScrollToBottom} />
                    </div>
                )}
                {previewedSource && <SourcePreview source={previewedSource} />}
                <InputArea inputRef={inputRef} />
            </div>
        </div>
    );
};

export default Sidebar;