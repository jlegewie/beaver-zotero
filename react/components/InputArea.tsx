// @ts-ignore no idea
import React, { useState } from 'react';
import { AttachmentButton } from "./AttachmentButton";
import { Icon, PlusSignIcon } from './icons';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import {
    isStreamingAtom,
    userMessageAtom,
    messagesAtom,
    streamToMessageAtom,
    setMessageStatusAtom
} from '../atoms/messages';
import { resourcesAtom, resetResourcesAtom } from '../atoms/resources';
import { isResourceValid } from '../utils/resourceUtils';

import { chatCompletion } from '../../src/services/chatCompletion';
import { ChatMessage, createAssistantMessage, createUserMessage } from '../types/messages';
import { Resource } from '../types/resources';
import { threadResourceCountAtom } from '../atoms/messages';
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';

interface InputAreaProps {
    inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

const InputArea: React.FC<InputAreaProps> = ({
    inputRef
}) => {
    const [userMessage, setUserMessage] = useAtom(userMessageAtom);
    const resources = useAtomValue(resourcesAtom);
    const [isCommandPressed, setIsCommandPressed] = useState(false);
    const [messages, setMessages] = useAtom(messagesAtom);
    const isStreaming = useAtomValue(isStreamingAtom);
    const streamToMessage = useSetAtom(streamToMessageAtom);
    const threadResourceCount = useAtomValue(threadResourceCountAtom);
    const setMessageStatus = useSetAtom(setMessageStatusAtom);
    const resetResources = useSetAtom(resetResourcesAtom);

    const handleSubmit = async (
        e: React.FormEvent<HTMLFormElement> | React.MouseEvent<HTMLButtonElement>
    ) => {
        e.preventDefault();
        
        if (isStreaming) {
            return;
        }

        // Validate resources
        const validResources = [];
        for (const resource of resources) {
            if (await isResourceValid(resource, true)) {
                validResources.push(resource);
            }
        }
        console.log('validResources', validResources);

        // Add user message to messages atom
        const newMessages = [
            ...messages,
            createUserMessage({
                content: userMessage,
                resources: validResources,
            })
        ];

        // Add assistant message to messages atom
        const assistantMsg = createAssistantMessage();
        setMessages([...newMessages, assistantMsg]);
        resetResources();


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

    const handleAddResources = async () => {
        console.log('Adding context item');
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Meta') {
            setIsCommandPressed(true);
        }
    };

    const handleKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Meta') {
            setIsCommandPressed(false);
        }
    };

    const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
        // Check if the click target is a button or within a button
        const isButtonClick = (e.target as Element).closest('button') !== null;
        
        // Only focus if not clicking a button and editing is enabled
        if (!isButtonClick && inputRef.current) {
            inputRef.current.focus();
        }
    };

    return (
        <div
            className="user-message-display"
            onClick={handleContainerClick}
            style={{ minHeight: 'fit-content' }}
        >

            {/* Message resources */}
            <div className="flex flex-wrap gap-3 mb-2">
                <button
                    className="icon-button scale-11"
                    onClick={handleAddResources}
                >
                        <Icon icon={PlusSignIcon} />
                </button>
                {threadResourceCount > 0 && (
                    <button
                        className="resources-info"
                        disabled={true}
                        title={`This thread has ${threadResourceCount} resources.`}
                    >
                        <ZoteroIcon 
                            icon={ZOTERO_ICONS.ATTACHMENTS} 
                            size={14} 
                            color="--accent-green"
                            className="mr-1"
                        />
                        {threadResourceCount}
                    </button>
                )}
                {resources.map((resource, index) => (
                    <AttachmentButton
                        key={index}
                        resource={resource}
                    />
                ))}
            </div>

            {/* Input Form */}
            <form onSubmit={handleSubmit} className="flex flex-col">
                {/* Message Input  */}
                <div className="mb-2 -ml-1">
                    <textarea
                        ref={inputRef}
                        value={userMessage}
                        onChange={(e) => setUserMessage(e.target.value)}
                        onInput={(e) => {
                            e.currentTarget.style.height = 'auto';
                            e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
                        }}
                        placeholder="How can I help you today?"
                        className="chat-input"
                        onKeyDown={(e) => {
                            handleKeyDown(e);
                            // Submit on Enter (without Shift)
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                handleSubmit(e as any);
                            }
                        }}
                        onKeyUp={handleKeyUp}
                        rows={1}
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
            </form>
        </div>
    );
};

export default InputArea;