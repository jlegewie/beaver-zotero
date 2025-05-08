import React from 'react';
// @ts-ignore no idea why
import { useState, useRef, useMemo } from 'react';
import { ChatMessage } from '../types/chat/uiTypes';
import MarkdownRenderer from './MarkdownRenderer';
import { RepeatIcon, ShareIcon, ArrowDownIcon, ArrowUpIcon, ArrowRightIcon } from './icons';
import { sourceCitationsAtom } from '../atoms/threads';
import { useAtomValue, useSetAtom } from 'jotai';
import ContextMenu from './ContextMenu';
import useSelectionContextMenu from '../hooks/useSelectionContextMenu';
import { copyToClipboard } from '../utils/clipboard';
import IconButton from './IconButton';
import MenuButton from './MenuButton';
import { regenerateFromMessageAtom } from '../atoms/generateMessages';
import Button from './button';
import CitedSourcesList from './CitedSourcesList';
import { SourceCitation } from '../types/sources';
import { renderToMarkdown, renderToHTML } from '../utils/citationRenderers';
import CopyButton from './CopyButton';
import { ErrorDisplay, WarningDisplay } from './ErrorWarningDisplay';

interface AssistantMessageContentProps {
    message: ChatMessage;
    isLastMessage: boolean;
}

const AssistantMessageContent: React.FC<AssistantMessageContentProps> = ({
    message,
    isLastMessage
}) => {
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

    const handleRepeat = async () => {
        await regenerateFromMessage(message.id);
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

    // Extract citation IDs from message content to get the source citations
    const citedSources: SourceCitation[] = useMemo(() => {
        if (!(message.status == 'completed' || message.status == 'canceled') || !message.content) {
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

    // If the message is a placeholder, show the warnings and error only
    if (message.isPlaceholder) {
        return (
            <div>
                {message.warnings?.map((warning) => (
                    <WarningDisplay key={message.id} messageId={message.id} warning={warning} isPlaceholder={true}/>
                ))}
                {message.status === 'error' &&
                    <ErrorDisplay errorType={message.errorType || 'unknown'} />
                }
            </div>
        );
    }

    return (
        <div id={`message-${message.id}`} className={`px-4 ${isLastMessage ? 'pb-3' : ''} hover-trigger`}>
            {message.warnings?.map((warning) => (
                <WarningDisplay key={message.id} messageId={message.id} warning={warning} />
            ))}
            <div 
                className="user-select-text"
                ref={contentRef}
                onContextMenu={handleContextMenu}
            >
                <MarkdownRenderer className="markdown" content={message.content} />
                {message.status === 'error' &&
                    <ErrorDisplay errorType={message.errorType || 'unknown'} />
                }
            </div>

            {/* Copy, repeat, and share buttons - visible on hover */}
            <div
                className={`
                    display-flex flex-row items-center pt-2 mr-4 ml-1
                    ${isLastMessage || sourcesVisible ? '' : 'hover-fade'}
                    ${message.status === 'in_progress' ? 'hidden' : ''}
                `}
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
                <div className="display-flex gap-4">
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

export default AssistantMessageContent;