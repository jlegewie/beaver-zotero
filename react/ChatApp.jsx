import React, { useState, useRef, useEffect } from 'react';
import UserMessageDisplay from "./components/UserMessageDisplay.tsx"
import Header from "./components/Header.tsx"

const ChatApp = () => {
    const inputRef = useRef(null);
    
    // Subscribe to events from Zotero
    useEffect(() => {
        // Get the event bus from the window
        const eventBus = window.__beaverEventBus;
        if (!eventBus) return;

        const handleFocus = () => {
            // Add selected items to context
            // const items = Zotero.getActiveZoteroPane().getSelectedItems();
            // setContextItems(items);
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
            />
        </div>
    );
};

export default ChatApp;