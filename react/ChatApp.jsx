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
    }, [setUserAttachments]);
    
    return (
        <div className="h-full flex flex-col gap-3">
            {/* Header */}
            <div id="beaver-header" className="flex flex-row items-center px-3 pt-2">
                <Header />
            </div>

            {/* Messages area (scrollable) */}
            <div id="beaver-messages" className="flex flex-col flex-1 min-h-0 overflow-y-auto gap-4 scrollbar">
                {messages.map((message, index) => (
                    <div key={index} className="px-3">
                        {message.role === 'user' && (
                            <UserMessageDisplay
                                key={index}
                                inputRef={inputRef}
                                editing={false}
                                message={message}
                            />
                        )}
                    </div>
                ))}
            </div>

            {/* Prompt area (footer) */}
            <div id="beaver-prompt" className="flex-none px-3 pb-3">
                <UserMessageDisplay
                    inputRef={inputRef}
                    editing={true}
                />
            </div>

        </div>
    );
};

export default ChatApp;