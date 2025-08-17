import React, { useState, useRef } from 'react';
import { ChatMessage } from '../../types/chat/uiTypes';
import { RepeatIcon, ShareIcon, ArrowDownIcon, ArrowRightIcon } from '../icons/icons';
import { useAtomValue, useSetAtom } from 'jotai';
import { copyToClipboard } from '../../utils/clipboard';
import IconButton from '../ui/IconButton';
import MenuButton from '../ui/MenuButton';
import { regenerateFromMessageAtom } from '../../atoms/generateMessages';
import Button from '../ui/Button';
import CitedSourcesList from '../sources/CitedSourcesList';
import { renderToMarkdown, renderToHTML } from '../../utils/citationRenderers';
import CopyButton from '../ui/buttons/CopyButton';
import { attachmentCitationsAtom, citationMetadataAtom } from '../../atoms/citations';
import { AttachmentCitation } from '../../types/attachments/uiTypes';
import { selectItem } from '../../../src/utils/selectItem';

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
    const citations = useAtomValue(attachmentCitationsAtom);
    const citationMetadata = useAtomValue(citationMetadataAtom);

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
        },
        {
            label: 'Copy Request ID',
            onClick: () => copyRequestId()
        }
    ];

    if (Zotero.Beaver.data.env === "development") {
        shareMenuItems.push({
            label: 'Copy Citation Metadata',
            onClick: () => copyCitationMetadata()
        });
    }

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

    const saveAsNote = async (citation?: AttachmentCitation) => {
        const formattedContent = renderToHTML(message.content);
        const newNote = new Zotero.Item('note');
        newNote.setNote(formattedContent);
        if (citation && citation.parentKey) {
            newNote.parentKey = citation.parentKey;
        }
        await newNote.saveTx();
        selectItem(newNote);
    }

    const copyRequestId = async () => {
        await copyToClipboard(message.id);
    }

    const copyCitationMetadata = async () => {
        await copyToClipboard(JSON.stringify(citationMetadata, null, 2));
    }

    return (
        <>
            <div
                className={`
                    display-flex flex-row items-center pt-2 mr-4
                    ${isLastMessage || sourcesVisible ? '' : 'hover-fade'}
                    ${message.status === 'in_progress' || message.status === 'thinking' || (message.tool_calls && message.tool_calls.length > 0 && message.tool_calls.map(call => call.status).includes('in_progress'))
                        ? 'hidden'
                        : ''
                    }
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