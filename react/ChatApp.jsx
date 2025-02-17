import React, { useState, useRef, useEffect } from 'react';
import UserMessageDisplay from "./components/UserMessageDisplay.tsx"
import { Icon, Cancel01Icon, Clock02Icon, PlusSignIcon } from './components/icons';
import { toggleChat } from '../src/ui/chat';

const ChatApp = () => {
    const [isCommandPressed, setIsCommandPressed] = useState(false);
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
            <UserMessageDisplay
                inputRef={inputRef}
                isCommandPressed={isCommandPressed}
                handleKeyDown={handleKeyDown}
                handleKeyUp={handleKeyUp}
            />
        </div>
    );
};

export default ChatApp;