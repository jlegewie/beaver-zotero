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
        <div className="flex-1 flex flex-col px-3 pt-2 pb-3">
            {/* Header */}
            <Header />

            {messages.length === 0 && (
                <UserMessageDisplay
                    inputRef={inputRef}
                    editing={true}
                />
            )}

            {messages.length > 0 && (
                <div className="flex flex-col flex-1 justify-between">
                    {/* Scrollable messages area */}
                    <div className="flex flex-col gap-2 flex-1 overflow-auto">
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
                    </div>

                    {/* Footer-like area for the new user prompt */}
                    <div className="mt-2">
                        <UserMessageDisplay
                            inputRef={inputRef}
                            editing={true}
                        />
                    </div>
                </div>
            )}
        </div>
    );
};

export default ChatApp;