import React from 'react';
import { ContextItem } from "./contextItem";
import { Icon, PlusSignIcon } from './icons';
import type { OpenAI } from 'openai'
import { useAtom } from 'jotai';
import { userMessageAtom, userAttachmentsAtom } from '../atoms/messages';

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
    const [userAttachments, setUserAttachments] = useAtom(userAttachmentsAtom);

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
        // Get selected items from Zotero
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        // Add attachments to current user message
        setUserAttachments(items.map((item) => ({
            type: 'zotero_item',
            item: item
        })));
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
                {userAttachments.map((attachment, index) => (
                    <ContextItem
                        key={index}
                        attachment={attachment}
                        onRemove={() => alert('removing context item')}
                    />
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