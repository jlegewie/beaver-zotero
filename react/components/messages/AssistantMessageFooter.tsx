import React, { useState, useRef, useMemo } from 'react';
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
import { citationDataAtom } from '../../atoms/citations';
import { selectItem } from '../../../src/utils/selectItem';
import { CitationData } from '../../types/citations';
import { store } from '../../index';

interface AssistantMessageFooterProps {
    messages: ChatMessage[];
}

const AssistantMessageFooter: React.FC<AssistantMessageFooterProps> = ({
    messages
}) => {
    const regenerateFromMessage = useSetAtom(regenerateFromMessageAtom);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const citations = useAtomValue(citationDataAtom);
    const lastMessage = messages[messages.length - 1];

    // Message IDs for the message group
    const messageIds = useMemo(() => {
        return messages.map(message => message.id);
    }, [messages]);

    // Uniqiue citations for messages in message group
    const uniqueCitations = useMemo(() => {
        const seen = new Set<string>();
        const unique: CitationData[] = [];
        const messageCitations = citations.filter(citation => messageIds.includes(citation.message_id));
        
        for (const citation of messageCitations) {
            const key = `${citation.library_id}-${citation.zotero_key}`;
            if (!seen.has(key)) {
                seen.add(key);
                unique.push({
                    ...citation,
                    numericCitation: (unique.length + 1).toString()
                });
            }
        }
        
        return unique;
    }, [citations, messageIds]);

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
        await regenerateFromMessage(lastMessage.id);
    }

    const handleCopy = async () => {
        const formattedContent = renderToMarkdown(lastMessage.content);
        await copyToClipboard(formattedContent);
    };

    const saveAsNote = async (citation?: CitationData) => {
        const formattedContent = renderToHTML(lastMessage.content);
        const newNote = new Zotero.Item('note');
        newNote.setNote(formattedContent);
        if (citation && citation.parentKey) {
            newNote.parentKey = citation.parentKey;
        }
        await newNote.saveTx();
        selectItem(newNote);
    }

    const copyRequestId = async () => {
        await copyToClipboard(lastMessage.id);
    }

    const copyCitationMetadata = async () => {
        await copyToClipboard(JSON.stringify(store.get(citationDataAtom), null, 2));
    }

    return (
        <>
            <div
                className={`
                    display-flex flex-row items-center pt-2 mr-4
                    ${lastMessage.status === 'in_progress' || lastMessage.status === 'thinking' || (lastMessage.tool_calls && lastMessage.tool_calls.length > 0 && lastMessage.tool_calls.map(call => call.status).includes('in_progress'))
                        ? 'hidden'
                        : ''
                    }
                `}
            >
                {/* Sources button */}
                <div className="flex-1">
                    {uniqueCitations.length > 0 && (
                        <Button
                            variant="ghost"
                            onClick={toggleSources}
                            // rightIcon={sourcesVisible ? ArrowUpIcon : ArrowDownIcon}
                            icon={sourcesVisible ? ArrowDownIcon : ArrowRightIcon}
                            iconClassName="mr-0 scale-12 -ml-1"
                            // className="text-sm"
                        >
                            <span>
                                {uniqueCitations.length} Source{uniqueCitations.length === 1 ? '' : 's'}
                                {/* Sources ({citations.length}) */}
                            </span>
                        </Button>
                    )}
                </div>
                {/* Copy, repeat, and share buttons - visible on hover */}
                <div className="display-flex gap-4">
                    {lastMessage.status !== 'error' &&
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
                    {lastMessage.status !== 'error' &&
                        <CopyButton
                            content={lastMessage.content}
                            formatContent={renderToMarkdown}
                            className="scale-12"
                        />
                    }
                </div>
            </div>

            {/* Sources section */}
            {sourcesVisible && (
                <CitedSourcesList
                    saveAsNote={saveAsNote}
                    citations={uniqueCitations}
                />
            )}
        </>
    );
};

export default AssistantMessageFooter;