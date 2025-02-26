import React from 'react';
// @ts-ignore no idea why
import { useState } from 'react';
import { ChatMessage } from '../types/messages';
import MarkdownRenderer from './MarkdownRenderer';
import { CopyIcon, Icon, RepeatIcon, TickIcon, Spinner, ShareIcon, AlertIcon } from './icons';
import { isStreamingAtom, rollbackChatToMessageIdAtom } from '../atoms/messages';
import { useAtomValue, useSetAtom } from 'jotai';
import { chatCompletion } from '../../src/services/chatCompletion';
import {
    streamToMessageAtom,
    setMessageStatusAtom
} from '../atoms/messages';

interface AssistantMessageDisplayProps {
    message: ChatMessage;
    isLastMessage: boolean;
}

const AssistantMessageDisplay: React.FC<AssistantMessageDisplayProps> = ({
    message,
    isLastMessage
}) => {
    const rollbackChatToMessageId = useSetAtom(rollbackChatToMessageIdAtom);
    const streamToMessage = useSetAtom(streamToMessageAtom);
    const setMessageStatus = useSetAtom(setMessageStatusAtom);
    const isStreaming = useAtomValue(isStreamingAtom);
    const [justCopied, setJustCopied] = useState(false);

    const handleRepeat = () => {
        const newMessages = rollbackChatToMessageId(message.id);
        if (!newMessages) return;
        const assistantMsgId = newMessages[newMessages.length - 1].id;

        chatCompletion(
            newMessages as ChatMessage[],
            (chunk: string) => {
                streamToMessage({ id: assistantMsgId, chunk: chunk });
            },
            () => {
                setMessageStatus({ id: assistantMsgId, status: 'completed' })
            },
            (error: Error) => {
                // @ts-ignore - Custom error properties
                const errorType = error.errorType || 'unknown';
                setMessageStatus({ 
                    id: assistantMsgId, 
                    status: 'error',
                    errorType: errorType
                });
            }
        );
    }

    const handleCopy = () => {
        navigator.clipboard.writeText(message.content);
        setJustCopied(true);
        setTimeout(() => {
            setJustCopied(false);
        }, 400);
    }

    // Get appropriate error message based on the error type
    const getErrorMessage = () => {
        const errorType = message.errorType || 'unknown';
        
        switch (errorType) {
            case 'service_unavailable':
                return "The AI service is currently unavailable. Please try again later.";
            case 'rate_limit':
                return "Rate limit exceeded. Please try again later.";
            case 'auth':
                return "Authentication error. Please check your API key.";
            case 'invalid_request':
                return "Invalid API request. The API key may be incorrect.";
            case 'network':
                return "Network connection error. Please check your internet connection.";
            case 'bad_request':
                return "The request to the AI service was invalid.";
            case 'server_error':
                return "The AI service encountered an error. Please try again later.";
            default:
                return "Error completing the response. Please try again.";
        }
    };

    return (
        <div className={`hover-trigger ${isLastMessage ? 'pb-3' : ''}`}>
            <div className="px-2 user-select-text">
                <MarkdownRenderer className="markdown" content={message.content} />
                {message.status === 'in_progress' && message.content == '' && 
                    <Spinner />
                }
                {message.status === 'error' &&
                    <div className="font-color-red py-3 flex flex-row gap-2">
                        <Icon icon={AlertIcon} className="mt-1"/>
                        <span>{getErrorMessage()}</span>
                    </div>
                }
            </div>

            {/* Copy, repeat, and share buttons - visible on hover */}
            <div
                className={`flex flex-row items-center pt-2 mr-4 ${isLastMessage ? '' : 'hover-fade'} ${isStreaming && isLastMessage ? 'hidden' : ''}`}
            >
                <div className="flex-1" />
                <div className="flex gap-5">
                    {isLastMessage && message.status !== 'error' &&
                        <button
                            className="icon-button scale-12"
                            // onClick={handleShare}
                        >
                            <Icon icon={ShareIcon} />
                        </button>
                    }
                    <button
                        className="icon-button scale-12"
                        onClick={handleRepeat}
                    >
                        <Icon icon={RepeatIcon} />
                    </button>
                    {message.status !== 'error' &&
                        <button
                            className="icon-button scale-12"
                            onClick={handleCopy}
                        >
                            <Icon icon={justCopied ? TickIcon : CopyIcon} />
                        </button>
                    }
                </div>
            </div>
        </div>
    );
};

export default AssistantMessageDisplay;