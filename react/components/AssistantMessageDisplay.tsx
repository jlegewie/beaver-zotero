import React from 'react';
// @ts-ignore no idea why
import { useState, useRef, useMemo } from 'react';
import { ChatMessage } from '../types/messages';
import MarkdownRenderer from './MarkdownRenderer';
import { Icon, RepeatIcon, Spinner, ShareIcon, AlertIcon, ArrowDownIcon, ArrowUpIcon, ArrowRightIcon } from './icons';
import { isStreamingAtom, sourceCitationsAtom } from '../atoms/threads';
import { useAtomValue, useSetAtom } from 'jotai';
import ContextMenu from './ContextMenu';
import useSelectionContextMenu from '../hooks/useSelectionContextMenu';
import { copyToClipboard } from '../utils/clipboard';
import IconButton from './IconButton';
import MenuButton from './MenuButton';
import { regenerateFromMessageAtom } from '../atoms/generateMessages';
import Button from './button';
import CitedSourcesList from './CitedSourcesList';
import { InputSource, SourceCitation } from '../types/sources';
import { renderToMarkdown, renderToHTML } from '../utils/citationRenderers';
import CopyButton from './CopyButton';

interface AssistantMessageDisplayProps {
    message: ChatMessage;
    isLastMessage: boolean;
    toolCallInProgress: boolean;
}

const AssistantMessageDisplay: React.FC<AssistantMessageDisplayProps> = ({
    message,
    isLastMessage,
    toolCallInProgress
}) => {
    const isStreaming = useAtomValue(isStreamingAtom);
    const regenerateFromMessage = useSetAtom(regenerateFromMessageAtom);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const sourceCitations = useAtomValue(sourceCitationsAtom);
    
    // New state for source visibility
    const [sourcesVisible, setSourcesVisible] = useState<boolean>(false);
    
    const { 
        isMenuOpen: isSelectionMenuOpen, 
        menuPosition: selectionMenuPosition,
        closeMenu: closeSelectionMenu,
        handleContextMenu,
        menuItems: selectionMenuItems
    } = useSelectionContextMenu(contentRef);
        
    const shareMenuItems = [
        {
            label: 'Copy',
            onClick: () => handleCopy()
        },
        {
            label: 'Save as Note',
            onClick: () => saveAsNote()
        }
    ];

    // Toggle sources visibility
    const toggleSources = () => {
        setSourcesVisible((prev: boolean) => !prev);
    };

    const handleRepeat = () => {
        regenerateFromMessage(message.id);
    }

    const handleCopy = async () => {
        const formattedContent = renderToMarkdown(message.content);
        await copyToClipboard(formattedContent);
    };

    const saveAsNote = async (source?: SourceCitation) => {
        const formattedContent = renderToHTML(message.content);
        const newNote = new Zotero.Item('note');
        newNote.setNote(formattedContent);
        if (source && source.parentKey) {
            newNote.parentKey = source.parentKey;
        }
        await newNote.saveTx();
        // @ts-ignore selectItem exists
        Zotero.getActiveZoteroPane().itemsView.selectItem(newNote.id);
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

    // Extract citation IDs from message content to get the source citations
    const citedSources: SourceCitation[] = useMemo(() => {
        if (message.status !== 'completed' || !message.content) {
            return [];
        }

        // Extract all citation IDs from the message content
        const citationIdSet = new Set<string>();
        const citationRegex = /<citation\s+(?:[^>]*?)id="([^"]+)"(?:[^>]*?)\s*(?:\/>|><\/citation>)/g;
        
        let match;
        while ((match = citationRegex.exec(message.content)) !== null) {
            if (match[1]) {
                citationIdSet.add(match[1]);
            }
        }

        // Filter sourceCitations to only include those with IDs in citationIdSet
        const citations = Object.entries(sourceCitations)
            .filter(([key, _]) => citationIdSet.has(key))
            .map(([_, citation]) => citation);

        return citations;
    }, [message.status, message.content, sourceCitations]);

    return (
        <div className={`hover-trigger ${isLastMessage ? 'pb-3' : ''}`}>
            {message.status === 'in_progress' && message.content == '' && !toolCallInProgress &&
                <div className="py-1">
                    <Button
                        variant="ghost"
                        className="text-base scale-105 disabled-but-styled"
                        iconClassName="scale-12"
                        icon={Spinner}
                        disabled={true}
                    >
                        <span style={{ marginLeft: '-2px' }}>
                            Generating...
                        </span>
                    </Button>
                </div>
            }
            <div 
                className="user-select-text"
                ref={contentRef}
                onContextMenu={handleContextMenu}
            >
                <MarkdownRenderer className="markdown" content={message.content} />
                {message.status === 'error' &&
                    <div className="font-color-red py-3 flex flex-row gap-2">
                        <Icon icon={AlertIcon} className="mt-1"/>
                        <span>{getErrorMessage()}</span>
                    </div>
                }
            </div>

            {/* Copy, repeat, and share buttons - visible on hover */}
            <div
                className={`
                    flex flex-row items-center pt-2 mr-4 ml-1
                    ${isLastMessage || sourcesVisible ? '' : 'hover-fade'}
                    ${isStreaming && isLastMessage ? 'hidden' : ''}`}
            >
                <div className="flex-1">
                    {citedSources.length > 0 && (
                        <Button
                            variant="ghost"
                            onClick={toggleSources}
                            // rightIcon={sourcesVisible ? ArrowUpIcon : ArrowDownIcon}
                            icon={sourcesVisible ? ArrowDownIcon : ArrowRightIcon}
                            iconClassName="mr-0 scale-12"
                            // className="text-sm"
                        >
                            <span style={{ marginLeft: '-3px' }}>
                                {citedSources.length} Source{citedSources.length === 1 ? '' : 's'}
                                {/* Sources ({citedSources.length}) */}
                            </span>
                        </Button>
                    )}
                </div>
                <div className="flex gap-4">
                    {message.status !== 'error' &&
                        <MenuButton
                            icon={ShareIcon}
                            menuItems={shareMenuItems}
                            className="scale-12"
                            ariaLabel="Share"
                            variant="ghost"
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
                        <CopyButton
                            content={message.content}
                            formatContent={renderToMarkdown}
                            className="scale-12"
                        />
                    }
                </div>
            </div>

            {/* Sources section */}
            {sourcesVisible && citedSources.length > 0 && (
                <CitedSourcesList sources={citedSources} saveAsNote={saveAsNote} />
            )}

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