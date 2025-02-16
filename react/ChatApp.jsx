import React, { useState, useRef, useEffect } from 'react';
import { Button } from "./components/button.tsx"
import { ContextItem } from "./components/contextItem.tsx"
import { getInTextCitations, getBibliographies } from "../src/utils/citations.ts"

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
            handleDeepSearch();
        } else {
            console.log('Message sent:', message);
            setMessage('');
            setSendCount(prev => prev + 1);
        }
    };
    
    const handleDeepSearch = () => {
        console.log('Deep search triggered');
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
            <div className="chat-box">
                <form onSubmit={handleSubmit} className="flex flex-col">
                    {/* Chat Input */}
                    <div className="mb-2 -ml-1">
                        <input
                            ref={inputRef}
                            type="text"
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            placeholder="How can I help you today?"
                            className="chat-input"
                            onKeyDown={handleKeyDown}
                            onKeyUp={handleKeyUp}
                        />
                    </div>
                    {/* Context Items */}
                    {/* TODO: revise context-items-container */}
                    <div className="context-items-container">
                        {contextItems.map((item, index) => (
                            <ContextItem
                                key={index}
                                icon={item.getItemTypeIconName()}
                                tooltip={getBibliographies([item])[0]}
                                variant="dark"
                                onRemove={() => alert('test')}
                            >
                                {getInTextCitations([item])[0]}
                            </ContextItem>
                        ))}
                    </div>
                    {/* Button Row */}
                    <div className="flex flex-row items-center pt-2">
                        <div className="flex-1" />
                            <div className="flex gap-2">
                                <button
                                    type={isCommandPressed ? "button" : undefined}
                                    className={`beaver-button ${isCommandPressed ? '' : 'faded'} mr-1`}
                                    onClick={handleDeepSearch}
                                >
                                    Library Search ⌘ ⏎
                                </button>
                                <button
                                    type={isCommandPressed ? undefined : "button"}
                                    className={`beaver-button ${isCommandPressed ? 'faded' : ''}`}
                                    onClick={() => alert('test')}
                                >
                                    Send ⏎
                                </button>
                            </div>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default ChatApp;