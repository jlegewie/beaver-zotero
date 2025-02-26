import React from 'react';
// @ts-ignore no idea why
import { useState, useRef, useEffect } from 'react';
import { ChatMessage } from '../types/messages';
import MarkdownRenderer from './MarkdownRenderer';
import { CopyIcon, Icon, RepeatIcon, TickIcon, Spinner, ShareIcon, AlertIcon } from './icons';
import { isStreamingAtom, rollbackChatToMessageIdAtom } from '../atoms/messages';
import { useAtomValue, useSetAtom } from 'jotai';
import ContextMenu from './ContextMenu';
import { chatCompletion } from '../../src/services/chatCompletion';
import {
    streamToMessageAtom,
    setMessageStatusAtom
} from '../atoms/messages';
import useSelectionContextMenu from '../hooks/useSelectionContextMenu';
import { copyToClipboard } from '../utils/clipboard';
import IconButton from './IconButton';
import MenuButton from './MenuButton';

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
    const contentRef = useRef<HTMLDivElement | null>(null);
    
    // Manage copy feedback state manually
    const [justCopied, setJustCopied] = useState(false);
    
    const { 
        isMenuOpen: isSelectionMenuOpen, 
        menuPosition: selectionMenuPosition,
        closeMenu: closeSelectionMenu,
        handleContextMenu,
        menuItems: selectionMenuItems
    } = useSelectionContextMenu(contentRef);
    
    // Share menu state and items
    const [isShareMenuOpen, setIsShareMenuOpen] = useState<boolean>(false);
    const [menuPosition, setMenuPosition] = useState<{ x: number, y: number }>({ x: 0, y: 0 });
    const shareButtonRef = useRef<HTMLButtonElement | null>(null);
    
    const shareMenuItems = [
        {
            label: 'Copy',
            onClick: () => handleCopy()
        },
        {
            label: 'Save as Note',
            onClick: () => console.log('Save as Note clicked')
        }
    ];

    const handleShareClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        
        // Get button position
        if (shareButtonRef.current) {
            const rect = shareButtonRef.current.getBoundingClientRect();
            setMenuPosition({ 
                x: rect.left,
                y: rect.bottom + 5
            });
            setIsShareMenuOpen(true);
        }
    };

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

    const handleCopy = async () => {
        await copyToClipboard(message.content, {
            onSuccess: () => {
                setJustCopied(true);
                setTimeout(() => setJustCopied(false), 400);
            }
        });
    };

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
            <div 
                className="px-2 user-select-text" 
                ref={contentRef}
                onContextMenu={handleContextMenu}
            >
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
                        <MenuButton
                            icon={ShareIcon}
                            menuItems={shareMenuItems}
                            className="scale-12"
                            ariaLabel="Share"
                            positionAdjustment={{ x: 0, y: 0 }}
                        />
                    }
                    <IconButton
                        icon={RepeatIcon}
                        onClick={handleRepeat}
                        className="scale-12"
                        ariaLabel="Regenerate response"
                    />
                    {message.status !== 'error' &&
                        <IconButton
                            icon={justCopied ? TickIcon : CopyIcon}
                            onClick={handleCopy}
                            className="scale-12"
                            ariaLabel="Copy to clipboard"
                        />
                    }
                </div>
            </div>

            {/* Text selection context menu */}
            <ContextMenu
                menuItems={selectionMenuItems}
                isOpen={isSelectionMenuOpen}
                onClose={closeSelectionMenu}
                position={selectionMenuPosition}
                useFixedPosition={true}
            />
        </div>
    );
};

export default AssistantMessageDisplay;