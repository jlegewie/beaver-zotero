import React, { useState } from 'react';
import { ContextItem } from "./contextItem";
import { getInTextCitations, getBibliographies } from "../../src/utils/citations";
import { Icon, PlusSignIcon } from './icons';
import type { OpenAI } from 'openai'
import { useAtom } from 'jotai';
import { userMessageAtom, userContentPartsAtom } from '../atoms/messages';

const messages: OpenAI.ChatCompletionMessageParam[] = [];

interface ChatInputProps {
    inputRef: React.RefObject<HTMLInputElement>;
    isCommandPressed: boolean;
    handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    handleKeyUp: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

const ChatInput: React.FC<ChatInputProps> = ({
    inputRef,
    isCommandPressed,
    handleKeyDown,
    handleKeyUp,
}) => {
    const [userMessage, setUserMessage] = useAtom(userMessageAtom);
    const [contextItems, setContextItems] = useState<Zotero.Item[]>([]);
    const [userContentParts, setUserContentParts] = useAtom(userContentPartsAtom);

    const handleSubmit = (e: React.FormEvent<HTMLFormElement> | React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        if (isCommandPressed) {
            handleLibrarySearch();
        } else {
            console.log('Message sent:', userMessage);
            setUserMessage('');
        }
    };

    const handleLibrarySearch = () => {
        console.log('Message sent with library search:', userMessage);
        setUserMessage('');
    };

    const handleAddContextItem = () => {
        console.log('Adding context item');
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        setContextItems(items);
    };

    return (
        <div className="chat-box">
            {/* Context Items */}
            <div className="flex flex-wrap gap-3 mb-2">
                <button
                    className="icon-button"
                    onClick={handleAddContextItem}
                >
                    <Icon icon={PlusSignIcon} />
                </button>
                {contextItems.map((item, index) => (
                    <ContextItem
                        key={index}
                        icon={item.getItemTypeIconName()}
                        tooltip={getBibliographies([item])[0]}
                        onRemove={() => alert('removing context item')}
                    >
                        {getInTextCitations([item])[0]}
                    </ContextItem>
                ))}
            </div>
            <form onSubmit={handleSubmit} className="flex flex-col">
                {/* Chat Input */}
                <div className="mb-2 -ml-1">
                    <input
                        ref={inputRef}
                        type="text"
                        value={userMessage}
                        onChange={(e) => setUserMessage(e.target.value)}
                        placeholder="How can I help you today?"
                        className="chat-input"
                        onKeyDown={handleKeyDown}
                        onKeyUp={handleKeyUp}
                    />
                </div>

                {/* Button Row */}
                <div className="flex flex-row items-center pt-2">
                    <div className="flex-1" />
                    <div className="flex gap-2">
                        <button
                            type={isCommandPressed ? "button" : undefined}
                            className={`beaver-button ${isCommandPressed ? '' : 'faded'} mr-1`}
                            onClick={handleLibrarySearch}
                        >
                            Library Search ⌘ ⏎
                        </button>
                        <button
                            type={isCommandPressed ? undefined : "button"}
                            className={`beaver-button ${isCommandPressed ? 'faded' : ''}`}
                            onClick={handleSubmit}
                        >
                            Send ⏎
                        </button>
                    </div>
                </div>
            </form>
        </div>
    );
};

export default ChatInput;