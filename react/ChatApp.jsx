import React, { useState, useRef, useEffect } from 'react';
import UserMessageDisplay from "./components/UserMessageDisplay.tsx"
import Header from "./components/Header.tsx"
import { userAttachmentsAtom } from './atoms/messages';
import { useSetAtom } from 'jotai';

const ChatApp = () => {
    const inputRef = useRef(null);
    const setUserAttachments = useSetAtom(userAttachmentsAtom);
    
    // Subscribe to events from Zotero
    useEffect(() => {
        // Get the event bus from the window
        const eventBus = window.__beaverEventBus;
        if (!eventBus) return;

        const handleFocus = () => {
            // Add selected items to context
            const items = Zotero.getActiveZoteroPane().getSelectedItems();
            // Add attachments to current user message
            setUserAttachments(items.map((item) => ({
                type: 'zotero_item',
                item: item
            })));
            // Focus on text field
            inputRef.current?.focus();
        };

        // "itemSelected" event to update our log
        const handleItemSelected = (e) => {
            const { detail } = e;
        };

        eventBus.addEventListener('focusChatInput', handleFocus);
        eventBus.addEventListener('itemSelected', handleItemSelected);

        // Clean up the event listeners when the component unmounts.
        return () => {
            eventBus.removeEventListener('focusChatInput', handleFocus);
            eventBus.removeEventListener('itemSelected', handleItemSelected);
        };
    }, []);
    
    return (
        <div className="chat-container px-3 py-2">
            {/* Header */}
            <Header />
            
            {/* Chat Input */}
            <UserMessageDisplay
                inputRef={inputRef}
                editing={false}
            />
        </div>
    );
};

export default ChatApp;