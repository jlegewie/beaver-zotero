import React, { useState, useRef } from 'react';
import { ChatMessage } from '../types/chat/uiTypes';
import { RepeatIcon, ShareIcon, ArrowDownIcon, ArrowRightIcon } from './icons';
import { useAtomValue, useSetAtom } from 'jotai';
import { copyToClipboard } from '../utils/clipboard';
import IconButton from './IconButton';
import MenuButton from './MenuButton';
import { regenerateFromMessageAtom } from '../atoms/generateMessages';
import Button from './button';
import CitedSourcesList from './CitedSourcesList';
import { SourceCitation } from '../types/sources';
import { renderToMarkdown, renderToHTML } from '../utils/citationRenderers';
import CopyButton from './CopyButton';
import { sourceCitationsAtom } from '../atoms/citations';

interface AssistantMessageFooterProps {
    message: ChatMessage;
    isLastMessage: boolean;
}

const AssistantMessageFooter: React.FC<AssistantMessageFooterProps> = ({
    message,
    isLastMessage,
}) => {
    const regenerateFromMessage = useSetAtom(regenerateFromMessageAtom);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const citations = useAtomValue(sourceCitationsAtom);

    // New state for source visibility
    const [sourcesVisible, setSourcesVisible] = useState<boolean>(false);
        
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

    return (
        <>
            <div
                className={`
                    display-flex flex-row items-center pt-2 mr-4
                    ${isLastMessage || sourcesVisible ? '' : 'hover-fade'}
                    ${message.status === 'in_progress' ? 'hidden' : ''}
                `}
            >
                {/* Sources button */}
                <div className="flex-1">
                    {citations.length > 0 && (
                        <Button
                            variant="ghost"
                            onClick={toggleSources}
                            // rightIcon={sourcesVisible ? ArrowUpIcon : ArrowDownIcon}
                            icon={sourcesVisible ? ArrowDownIcon : ArrowRightIcon}
                            iconClassName="mr-0 scale-12 -ml-1"
                            // className="text-sm"
                        >
                            <span>
                                {citations.length} Source{citations.length === 1 ? '' : 's'}
                                {/* Sources ({citations.length}) */}
                            </span>
                        </Button>
                    )}
                </div>
                {/* Copy, repeat, and share buttons - visible on hover */}
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
            {sourcesVisible && citations.length > 0 && (
                <CitedSourcesList saveAsNote={saveAsNote} />
            )}
        </>
    );
};

export default AssistantMessageFooter;