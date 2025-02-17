import React, { useRef, useEffect } from 'react';
import UserMessageDisplay from "./components/UserMessageDisplay.tsx"
import Header from "./components/Header.tsx"
import { userAttachmentsAtom, messagesAtom } from './atoms/messages';
import { useSetAtom, useAtomValue } from 'jotai';

const ChatApp = () => {
    const inputRef = useRef(null);
    const setUserAttachments = useSetAtom(userAttachmentsAtom);
    const messages = useAtomValue(messagesAtom);
    
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
        <div className="flex-col px-3 py-2">
            {/* Header */}
            <Header />
            
            {/* Chat Input */}
            {messages.length === 0 && (
                <UserMessageDisplay
                    inputRef={inputRef}
                    editing={true}
                />
            )}
            
            {/* Chat Messages */}
            {messages.length > 0 && (
                <div>
                    {messages.map((message, index) => (
                        <div key={index}>
                            {message.role === 'user' && (
                                <UserMessageDisplay
                                    inputRef={inputRef}
                                    editing={false}
                                    message={message}
                                />
                            )}
                        </div>
                    ))}

                    {/* Chat Input */}
                    <UserMessageDisplay
                        inputRef={inputRef}
                        editing={true}
                    />
                </div>
            )}
        </div>
    );
};

export default ChatApp;