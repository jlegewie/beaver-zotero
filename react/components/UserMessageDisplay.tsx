import React, { useState } from 'react';
import { AttachmentButton } from "./AttachmentButton";
import { Icon, PlusSignIcon } from './icons';
import { useAtom } from 'jotai';
import { userMessageAtom, userAttachmentsAtom, ChatMessage } from '../atoms/messages';

interface UserMessageDisplayProps {
    inputRef: React.RefObject<HTMLInputElement>;
    editing?: boolean;
}

const UserMessageDisplay: React.FC<UserMessageDisplayProps> = ({
    inputRef,
    editing = false,
}) => {
    const [userMessage, setUserMessage] = useAtom(userMessageAtom);
    const [userAttachments, setUserAttachments] = useAtom(userAttachmentsAtom);
    const [isCommandPressed, setIsCommandPressed] = useState(false);

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

    const handleAddAttachments = () => {
        console.log('Adding context item');
        // Get selected items from Zotero
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        // Add attachments to current user message
        setUserAttachments(items.map((item) => ({
            type: 'zotero_item',
            item: item
        })));
    };

    const handleRemoveAttachment = (index: number) => {
        setUserAttachments(userAttachments.filter((_, i) => i !== index));
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Meta') {
            setIsCommandPressed(true);
        }
    };

    const handleKeyUp = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Meta') {
            setIsCommandPressed(false);
        }
    };

    return (
        <div className="chat-box">
            {/* Context Items */}
            <div className="flex flex-wrap gap-3 mb-2">
                {editing && 
                    <button
                        className="icon-button scale-11"
                        onClick={handleAddAttachments}
                        disabled={!editing}
                    >
                        <Icon icon={PlusSignIcon} />
                    </button>
                }
                {userAttachments.map((attachment, index) => (
                    <AttachmentButton
                        key={index}
                        attachment={attachment}
                        onRemove={() => handleRemoveAttachment(index)}
                        disabled={!editing}
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
                        disabled={!editing}
                    />
                </div>

                {/* Button Row */}
                {editing && (
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
                )}
            </form>
        </div>
    );
};

export default UserMessageDisplay;