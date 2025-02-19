import React, { useState } from 'react';
import { AttachmentButton } from "./AttachmentButton";
import { Icon, PlusSignIcon } from './icons';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import {
    isStreamingAtom,
    userMessageAtom,
    userAttachmentsAtom,
    ChatMessage,
    messagesAtom,
    createAssistantMessage,
    createUserMessage,
    streamToMessageAtom,
    setMessageStatusAtom
} from '../atoms/messages';
import { chatCompletion } from '../../src/services/chatCompletion';
import { createAttachmentFromZoteroItem } from '../atoms/attachments';


interface UserMessageDisplayProps {
    inputRef: React.RefObject<HTMLInputElement>;
    editing?: boolean;
    message?: ChatMessage;
}

const UserMessageDisplay: React.FC<UserMessageDisplayProps> = ({
    inputRef,
    editing = false,
    message
}) => {
    const [userMessage, setUserMessage] = useAtom(userMessageAtom);
    const [userAttachments, setUserAttachments] = useAtom(userAttachmentsAtom);
    const [isCommandPressed, setIsCommandPressed] = useState(false);
    const [messages, setMessages] = useAtom(messagesAtom);
    const isStreaming = useAtomValue(isStreamingAtom);
    const streamToMessage = useSetAtom(streamToMessageAtom);
    const setMessageStatus = useSetAtom(setMessageStatusAtom);

    const handleSubmit = (e: React.FormEvent<HTMLFormElement> | React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();

        // Add user message to messages atom
        const newMessages = [
            ...messages,
            createUserMessage({
                content: userMessage,
                attachments: userAttachments.filter((attachment) => attachment.valid),
            })
        ];

        // Add assistant message to messages atom
        const assistantMsg = createAssistantMessage();
        setMessages([...newMessages, assistantMsg]);

        // Chat completion
        chatCompletion(
            newMessages as ChatMessage[],
            (chunk: string) => {
                streamToMessage({ id: assistantMsg.id, chunk: chunk });
            },
            () => {
                setMessageStatus({ id: assistantMsg.id, status: 'completed' })
            },
            (error: Error) => {
                console.error(error);
                setMessageStatus({ id: assistantMsg.id, status: 'error' })
                // setMessageError({ id: assistantMsg.id, error: error })
            }
        );

        // Clear input
        setUserMessage('');
        setUserAttachments([]);

        // If command is pressed, handle library search
        if (isCommandPressed) {
            handleLibrarySearch();
        } else {
            console.log('Chat completion:', userMessage);
        }
    };

    const handleLibrarySearch = () => {
        console.log('Chat completion with library search:', userMessage);
    };

    const handleAddAttachments = async () => {
        console.log('Adding context item');
        // Get selected items from Zotero
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        // Add attachments to current user message
        setUserAttachments(await Promise.all(items.map((item) => createAttachmentFromZoteroItem(item))));
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

    const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
        // Check if the click target is a button or within a button
        const isButtonClick = (e.target as Element).closest('button') !== null;
        
        // Only focus if not clicking a button and editing is enabled
        if (!isButtonClick && editing && inputRef.current) {
            inputRef.current.focus();
        }
    };

    return (
        <div className="user-message-display" onClick={handleContainerClick}>
            {/* Context Items */}
            <div className="flex flex-wrap gap-3 mb-2">
                {editing && (
                    <button
                        className="icon-button scale-11"
                        onClick={handleAddAttachments}
                        disabled={!editing}
                    >
                        <Icon icon={PlusSignIcon} />
                    </button>
                )}
                {(message?.attachments || userAttachments).map((attachment, index) => (
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
                        value={message?.content || userMessage}
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
                                disabled={isStreaming}
                            >
                                Library Search ⌘ ⏎
                            </button>
                            <button
                                type={isCommandPressed ? undefined : "button"}
                                className={`beaver-button ${isCommandPressed ? 'faded' : ''}`}
                                onClick={handleSubmit}
                                disabled={isStreaming}
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