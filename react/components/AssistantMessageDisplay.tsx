import React from 'react';
// @ts-ignore no idea why
import { useState } from 'react';
import { ChatMessage } from '../types/messages';
import MarkdownRenderer from './MarkdownRenderer';
import { CopyIcon, Icon, RepeatIcon, TickIcon, Spinner, ShareIcon } from './icons';
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
                console.error("ERROR");
                setMessageStatus({ id: assistantMsgId, status: 'error' })
                // setMessageError({ id: assistantMsg.id, error: error })
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

    return (
        <div className="hover-trigger">
            <div className="px-2 user-select-text">
                <MarkdownRenderer className="markdown" content={message.content} />
                {message.status === 'in_progress' && message.content == '' && 
                    <Spinner />
                }
            </div>

            {/* Copy, repeat, and share buttons - visible on hover */}
            <div
                // className={`flex flex-row items-center mr-4 ${isLastMessage ? '' : 'hover-fade'} ${isStreaming ? 'hidden' : ''}`}
                className={`flex flex-row items-center pt-1 mr-4 ${isLastMessage ? '' : 'hover-fade'} ${isStreaming && isLastMessage ? 'hidden' : ''}`}
            >
                <div className="flex-1" />
                <div className="flex gap-5">
                    {isLastMessage &&
                        <button
                            className="icon-button scale-13"
                            // onClick={handleShare}
                        >
                            <Icon icon={ShareIcon} />
                        </button>
                    }
                    <button
                        className="icon-button scale-13"
                        onClick={handleRepeat}
                    >
                        <Icon icon={RepeatIcon} />
                    </button>
                    <button
                        className="icon-button scale-13"
                        onClick={handleCopy}
                    >
                        <Icon icon={justCopied ? TickIcon : CopyIcon} />
                    </button>
                </div>
            </div>
        </div>
    );
};

export default AssistantMessageDisplay;