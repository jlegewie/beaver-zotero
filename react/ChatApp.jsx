import React, { useState, useRef, useEffect } from 'react';
import ChatInput from "./components/ChatInput.tsx"

const ChatApp = () => {
    const [message, setMessage] = useState('');
    const [sendCount, setSendCount] = useState(0);
    const [isCommandPressed, setIsCommandPressed] = useState(false);
    const [contextItems, setContextItems] = useState([]);
    const inputRef = useRef(null);
    
    // Subscribe to events from Zotero
    useEffect(() => {
        // Get the event bus from the window
        const eventBus = window.__beaverEventBus;
        if (!eventBus) return;

        const handleFocus = () => {
            // Add selected items to context
            const items = Zotero.getActiveZoteroPane().getSelectedItems();
            setContextItems(items);
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

    const handleSubmit = (e) => {
        e.preventDefault();
        if (isCommandPressed) {
            handleLibrarySearch();
        } else {
            console.log('Message sent:', message);
            setMessage('');
            setSendCount(prev => prev + 1);
        }
    };
    
    const handleLibrarySearch = () => {
        console.log('Library search triggered');
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        setContextItems(items);
    };
    
    const handleEscape = () => {
        setMessage('');
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Meta') {
            setIsCommandPressed(true);
        }
    };

    const handleKeyUp = (e) => {
        if (e.key === 'Meta') {
            setIsCommandPressed(false);
        }
    };
    
    return (
        <div className="chat-container">
            <ChatInput
                message={message}
                setMessage={setMessage}
                inputRef={inputRef}
                isCommandPressed={isCommandPressed}
                contextItems={contextItems}
                handleSubmit={handleSubmit}
                handleKeyDown={handleKeyDown}
                handleKeyUp={handleKeyUp}
                handleLibrarySearch={handleLibrarySearch}
            />
        </div>
    );
};

export default ChatApp;