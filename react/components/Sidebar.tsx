// @ts-ignore no idea
import React, { useRef, useEffect, useState } from 'react';
import InputArea from "./InputArea"
import Header from "./Header"
import { MessagesArea } from "./MessagesArea"
import { messagesAtom } from '../atoms/messages';
import { useSetAtom, useAtomValue } from 'jotai';
import { useZoteroSelection } from '../hooks/useZoteroSelection';
import { ScrollDownButton } from './ScrollDownButton';
import { scrollToBottom } from '../utils/scrollToBottom';
import { previewedResourceAtom } from '../atoms/ui';
import ResourcePreview from './ResourcePreview';
import { updateResourcesFromZoteroSelectionAtom } from '../atoms/resources';

const Sidebar = ({ location }: { location: 'library' | 'reader' }) => {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const messages = useAtomValue(messagesAtom);
    const updateResourcesFromZoteroSelection = useSetAtom(updateResourcesFromZoteroSelectionAtom);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const [userScrolled, setUserScrolled] = useState(false);
    const previewedResource = useAtomValue(previewedResourceAtom);
    
    useZoteroSelection();
    
    useEffect(() => {
        // Focus the input
        inputRef.current?.focus();

        // Update resources based on Zotero selection
        updateResourcesFromZoteroSelection();
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
                messages={messages} 
                userScrolled={userScrolled} 
                setUserScrolled={setUserScrolled}
                ref={messagesContainerRef}
            />

            {/* Prompt area (footer) with floating elements */}
            <div id="beaver-prompt" className="flex-none px-3 pb-3 relative">
                {userScrolled && <ScrollDownButton onClick={handleScrollToBottom} />}
                {previewedResource && <ResourcePreview resource={previewedResource} />}
                <InputArea inputRef={inputRef} />
            </div>
        </div>
    );
};

export default Sidebar;