// @ts-ignore no idea
import React, { useRef, useEffect, useState } from 'react';
import InputArea from "./InputArea"
import Header from "./Header"
import { MessagesArea } from "./MessagesArea"
import { threadMessagesAtom } from '../atoms/messages';
import { useSetAtom, useAtomValue } from 'jotai';
import { useZoteroSelection } from '../hooks/useZoteroSelection';
import { ScrollDownButton } from './ScrollDownButton';
import { scrollToBottom } from '../utils/scrollToBottom';
import { previewedSourceAtom } from '../atoms/ui';
import SourcePreview from './SourcePreview';
import { updateSourcesFromZoteroSelectionAtom } from '../atoms/sources';

const Sidebar = ({ location }: { location: 'library' | 'reader' }) => {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const threadMessages = useAtomValue(threadMessagesAtom);
    const updateSourcesFromZoteroSelection = useSetAtom(updateSourcesFromZoteroSelectionAtom);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const [userScrolled, setUserScrolled] = useState(false);
    const previewedSource = useAtomValue(previewedSourceAtom);
    
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

    return (
        <div className="sidebar-container h-full flex flex-col gap-3 min-w-0">
            
            {/* Header */}
            <Header />

            {/* Messages area (scrollable) */}
            <MessagesArea 
                messages={threadMessages} 
                userScrolled={userScrolled} 
                setUserScrolled={setUserScrolled}
                ref={messagesContainerRef}
            />

            {/* Prompt area (footer) with floating elements */}
            <div id="beaver-prompt" className="flex-none px-3 pb-3 relative">
                {userScrolled && <ScrollDownButton onClick={handleScrollToBottom} />}
                {previewedSource && <SourcePreview source={previewedSource} />}
                <InputArea inputRef={inputRef} />
            </div>
        </div>
    );
};

export default Sidebar;