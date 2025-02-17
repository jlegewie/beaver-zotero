import React, { useState, useRef, useEffect } from 'react';
import ChatInput from "./components/ChatInput.tsx"
import { Icon, Cancel01Icon, Clock02Icon, PlusSignIcon } from './components/icons';
import { toggleChat } from '../src/ui/chat';

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
        <div className="chat-container px-3 py-2">
            {/* Header */}
            <div className="flex flex-row items-center mb-2">
                <div className="flex-1">
                    <button
                        className="icon-button scale-12"
                        onClick={() => toggleChat(window, false)}
                    >
                        <Icon icon={Cancel01Icon} />
                    </button>
                </div>
                <div className="flex gap-4">
                    <button className="icon-button scale-12">
                        <Icon icon={Clock02Icon} />
                    </button>
                    <button className="icon-button scale-12">
                        <Icon icon={PlusSignIcon} />
                    </button>
                </div>
            </div>
            
            {/* Chat Input */}
            {/* <div className="flex gap-3 mb-2">
                <button className="beaver-button">
                    <Icon icon={Cancel01Icon} />
                </button>
            </div> */}
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