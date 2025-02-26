import React from 'react';
// @ts-ignore no idea why
import { useState, useRef, useEffect } from 'react';
import { ChatMessage } from '../types/messages';
import MarkdownRenderer from './MarkdownRenderer';
import { CopyIcon, Icon, RepeatIcon, TickIcon, Spinner, ShareIcon, AlertIcon } from './icons';
import { isStreamingAtom, rollbackChatToMessageIdAtom } from '../atoms/messages';
import { useAtomValue, useSetAtom } from 'jotai';
import ContextMenu, { MenuItem, MenuPosition } from './ContextMenu';
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
    // Share menu
    const [isShareMenuOpen, setIsShareMenuOpen] = useState<boolean>(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const shareButtonRef = useRef<HTMLButtonElement | null>(null);
    
    // Text selection right-click menu
    const [isSelectionMenuOpen, setIsSelectionMenuOpen] = useState<boolean>(false);
    const [selectionMenuPosition, setSelectionMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const contentRef = useRef<HTMLDivElement | null>(null);

    const shareMenuItems: MenuItem[] = [
        {
            label: 'Copy',
            onClick: () => console.log('Copy clicked'),
            // icon: (
            //     <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            //         <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            //         <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            //     </svg>
            // )
        },
        {
            label: 'Add Note from Conversation',
            onClick: () => console.log('Add Note from Conversation clicked'),
        }
    ];

    // Selection menu items - just copy for now
    const selectionMenuItems: MenuItem[] = [
        {
            label: 'Copy',
            onClick: () => {
                const selectedText = Zotero.getMainWindow().getSelection()?.toString() || '';
                if (selectedText) {
                    navigator.clipboard.writeText(selectedText);
                }
            }
        }
    ];

    const handleContextMenu = (e: React.MouseEvent) => {
        // Check if there's selected text
        const selection = Zotero.getMainWindow().getSelection();
        const selectedText = selection?.toString() || '';
        
        // Only show menu if text is selected
        if (selectedText.trim().length > 0) {
            e.preventDefault();
            setSelectionMenuPosition({ x: e.clientX, y: e.clientY });
            setIsSelectionMenuOpen(true);
        }
    };

    // Close the selection menu when the selection changes or is removed
    useEffect(() => {
        const handleSelectionChange = () => {
            const selection = Zotero.getMainWindow().getSelection();
            const selectedText = selection?.toString() || '';
            
            if (selectedText.trim().length === 0 && isSelectionMenuOpen) {
                setIsSelectionMenuOpen(false);
            }
        };
        
        Zotero.getMainWindow().document.addEventListener('selectionchange', handleSelectionChange);
        return () => {
            Zotero.getMainWindow().document.removeEventListener('selectionchange', handleSelectionChange);
        };
    }, [isSelectionMenuOpen]);

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
                        <>
                            <button
                                className="icon-button scale-12"
                                ref={shareButtonRef}
                                onClick={handleShareClick}
                            >
                                <Icon icon={ShareIcon} />
                            </button>
                            <ContextMenu
                                menuItems={shareMenuItems}
                                isOpen={isShareMenuOpen}
                                onClose={() => setIsShareMenuOpen(false)}
                                position={menuPosition}
                                // usePortal={true}
                                useFixedPosition={true}
                            />
                        </>
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

            {/* Text selection context menu */}
            <ContextMenu
                menuItems={selectionMenuItems}
                isOpen={isSelectionMenuOpen}
                onClose={() => setIsSelectionMenuOpen(false)}
                position={selectionMenuPosition}
                useFixedPosition={true}
            />
        </div>
    );
};

export default AssistantMessageDisplay;