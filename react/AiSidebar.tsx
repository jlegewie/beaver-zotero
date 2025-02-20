import React, { useRef, useEffect } from 'react';
import UserMessageDisplay from "./components/UserMessageDisplay"
import InputArea from "./components/InputArea"
import AssistantMessageDisplay from "./components/AssistantMessageDisplay"
import Header from "./components/Header"
import { messagesAtom } from './atoms/messages';
import { selectedItemsAtom } from './atoms/attachments';
import { useSetAtom, useAtomValue } from 'jotai';
import { useZoteroSelection } from './hooks/useZoteroSelection';

const AiSidebar = () => {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const setSelectedItemsAtom = useSetAtom(selectedItemsAtom);
    const messages = useAtomValue(messagesAtom);
    useZoteroSelection();
    
    useEffect(() => {
        // Focus the input
        inputRef.current?.focus();

        // Set user attachments from selected Zotero items
        const loadSelectedItems = async () => {
            const items = Zotero.getActiveZoteroPane().getSelectedItems();
            setSelectedItemsAtom(items);
        };
        loadSelectedItems();
    }, []); // Run once on mount
    
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
                                message={message}
                            />
                        )}
                        {message.role === 'assistant' && (
                            <AssistantMessageDisplay
                                message={message}
                            />
                        )}
                    </div>
                ))}
            </div>

            {/* Prompt area (footer) */}
            <div id="beaver-prompt" className="flex-none px-3 pb-3">
                <InputArea inputRef={inputRef}/>
            </div>

        </div>
    );
};

export default AiSidebar;