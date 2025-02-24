// @ts-ignore no idea
import React, { useRef, useEffect, useState } from 'react';
import UserMessageDisplay from "./UserMessageDisplay"
import InputArea from "./InputArea"
import AssistantMessageDisplay from "./AssistantMessageDisplay"
import Header from "./Header"
import { MessagesArea } from "./MessagesArea"
import { messagesAtom } from '../atoms/messages';
import { updateAttachmentsFromSelectedItemsAtom } from '../atoms/attachments';
import { useSetAtom, useAtomValue } from 'jotai';
import { useZoteroSelection } from '../hooks/useZoteroSelection';

const Sidebar = ({ location }: { location: 'library' | 'reader' }) => {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const updateAttachmentsFromSelectedItems = useSetAtom(updateAttachmentsFromSelectedItemsAtom);
    const messages = useAtomValue(messagesAtom);
    const [userScrolled, setUserScrolled] = useState(false);
    
    useZoteroSelection();
    
    useEffect(() => {
        // Focus the input
        inputRef.current?.focus();

        // Set user attachments from selected Zotero items
        const loadSelectedItems = async () => {
            const items = Zotero.getActiveZoteroPane().getSelectedItems();
            updateAttachmentsFromSelectedItems(items);
        };
        loadSelectedItems();
    }, []); // Run once on mount
    
    return (
        <div className="h-full flex flex-col gap-3 min-w-0">
            {/* Header */}
            <div id="beaver-header" className="flex flex-row items-center px-3 pt-2 mb-2">
                <Header />
            </div>

            {/* Messages area (scrollable) */}
            <MessagesArea messages={messages} userScrolled={userScrolled} setUserScrolled={setUserScrolled} />

            {/* Prompt area (footer) */}
            <div id="beaver-prompt" className="flex-none px-3 pb-3">
                <InputArea inputRef={inputRef}/>
            </div>

        </div>
    );
};

export default Sidebar;