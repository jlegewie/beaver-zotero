import React, { useRef, useMemo, useEffect, useState } from 'react';
import { ChatMessage } from '../../types/chat/uiTypes';
import { RepeatIcon, ShareIcon, ArrowDownIcon, ArrowRightIcon } from '../icons/icons';
import { useAtomValue, useSetAtom } from 'jotai';
import { copyToClipboard } from '../../utils/clipboard';
import IconButton from '../ui/IconButton';
import MenuButton from '../ui/MenuButton';
import { regenerateFromMessageAtom } from '../../atoms/generateMessages';
import Button from '../ui/Button';
import CitedSourcesList from '../sources/CitedSourcesList';
import { renderToMarkdown, renderToHTML, preprocessNoteContent } from '../../utils/citationRenderers';
import CopyButton from '../ui/buttons/CopyButton';
import { citationDataListAtom, citationDataMapAtom } from '../../atoms/citations';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '../../atoms/externalReferences';
import { selectItem } from '../../../src/utils/selectItem';
import { CitationData, getUniqueKey } from '../../types/citations';
import { store } from '../../store';
import { messageSourcesVisibilityAtom, toggleMessageSourcesVisibilityAtom, setMessageSourcesVisibilityAtom } from '../../atoms/messageUIState';
import { getZoteroTargetContextSync } from '../../../src/utils/zoteroUtils';

interface AssistantMessageFooterProps {
    messages: ChatMessage[];
}

const AssistantMessageFooter: React.FC<AssistantMessageFooterProps> = ({
    messages
}) => {
    const regenerateFromMessage = useSetAtom(regenerateFromMessageAtom);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const citations = useAtomValue(citationDataListAtom);
    const citationDataMap = useAtomValue(citationDataMapAtom);
    const externalReferenceMapping = useAtomValue(externalReferenceItemMappingAtom);
    const externalReferencesMap = useAtomValue(externalReferenceMappingAtom);
    const lastMessage = messages[messages.length - 1];

    // Find all messages in the current assistant turn
    const assistantTurnMessages = useMemo(() => {
        let lastUserIndex = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
                lastUserIndex = i;
                break;
            }
        }
        return messages.slice(lastUserIndex + 1).filter(m => m.role === 'assistant');
    }, [messages]);

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
            const key = getUniqueKey(citation);
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

    const sourcesVisibilityMap = useAtomValue(messageSourcesVisibilityAtom);
    const sourcesVisible = sourcesVisibilityMap[lastMessage.id] ?? false;
    const toggleSourcesVisibility = useSetAtom(toggleMessageSourcesVisibilityAtom);
    const setSourcesVisibility = useSetAtom(setMessageSourcesVisibilityAtom);
    
    // Force re-render when menu opens to get fresh context for disabled state
    const [, forceUpdate] = useState({});
        
    // Build menu items - computed fresh each render to determine disabled state
    const getShareMenuItems = () => {
        const context = getZoteroTargetContextSync();
        const hasParent = context.parentReference !== null;

        const items = [
            {
                label: 'Copy',
                onClick: () => handleCopy()
            },
            {
                label: 'Save as Note',
                onClick: () => saveToLibrary()
            },
            {
                label: 'Save as Child Note',
                onClick: () => saveToItem(),
                disabled: !hasParent
            },
            {
                label: 'Copy Request ID',
                onClick: () => copyRequestId()
            }
        ];

        if (Zotero.Beaver.data.env === "development") {
            items.push({
                label: 'Copy Citation Metadata',
                onClick: () => copyCitationMetadata()
            });
        }

        return items;
    };

    // Toggle sources visibility
    const toggleSources = () => {
        toggleSourcesVisibility(lastMessage.id);
    };

    useEffect(() => {
        if (uniqueCitations.length === 0 && sourcesVisible) {
            setSourcesVisibility({ messageId: lastMessage.id, visible: false });
        }
    }, [lastMessage.id, setSourcesVisibility, sourcesVisible, uniqueCitations.length]);

    const handleRepeat = async () => {
        await regenerateFromMessage(lastMessage.id);
    }

    const getToolDetails = (toolCall: any) => { // Using any for toolCall to avoid complex type issues, or import ToolCall
        const label = toolCall.label || toolCall.function.name;
        let query = "";
        try {
            const args = typeof toolCall.function.arguments === 'string' && toolCall.function.arguments.startsWith('{')
                ? JSON.parse(toolCall.function.arguments) 
                : toolCall.function.arguments;
            query = args.search_label || args.query || args.q || args.keywords || args.topic || args.search_term || "";
        } catch (e) {
            console.error('Error parsing tool call arguments:', e);
        }
        
        const count = toolCall.response?.attachments?.length || toolCall.result?.references?.length || 0;
        
        let details = `[${label}`;
        if (query) details += `: "${query}"`;
        if (toolCall.status === 'completed') details += ` (${count} results)`;
        details += `]`;
        return details;
    };

    const combinedContent = useMemo(() => {
        return assistantTurnMessages.map(msg => {
            let part = msg.content || '';
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                const toolDescriptions = msg.tool_calls.map(getToolDetails).join('\n\n');
                if (part) part += '\n\n';
                part += toolDescriptions;
            }
            return part;
        }).filter(Boolean).join('\n\n');
    }, [assistantTurnMessages]);

    const handleCopy = async () => {
        const formattedContent = renderToMarkdown(combinedContent);
        await copyToClipboard(formattedContent);
    };

    /** Save as standalone note to current library/collection */
    const saveToLibrary = async () => {
        const formattedContent = renderToHTML(preprocessNoteContent(combinedContent), "markdown", { 
            citationDataMap, 
            externalMapping: externalReferenceMapping,
            externalReferencesMap 
        });
        const context = getZoteroTargetContextSync();
        
        const newNote = new Zotero.Item('note');
        if (context.targetLibraryId !== undefined) {
            newNote.libraryID = context.targetLibraryId;
        }
        newNote.setNote(formattedContent);
        await newNote.saveTx();
        
        // Add to collection if one is selected
        if (context.collectionToAddTo) {
            await context.collectionToAddTo.addItem(newNote.id);
        }
        
        selectItem(newNote);
    };

    /** Save as child note attached to selected/current item */
    const saveToItem = async () => {
        const formattedContent = renderToHTML(preprocessNoteContent(combinedContent), "markdown", { 
            citationDataMap, 
            externalMapping: externalReferenceMapping,
            externalReferencesMap 
        });
        const context = getZoteroTargetContextSync();
        
        if (!context.parentReference) return;
        
        const newNote = new Zotero.Item('note');
        newNote.libraryID = context.parentReference.library_id;
        newNote.parentKey = context.parentReference.zotero_key;
        newNote.setNote(formattedContent);
        await newNote.saveTx();
        selectItem(newNote);
    };

    /** Save as child note for a specific citation (used by CitedSourcesList) */
    const saveAsNote = async (citation?: CitationData) => {
        const formattedContent = renderToHTML(preprocessNoteContent(combinedContent), "markdown", { 
            citationDataMap, 
            externalMapping: externalReferenceMapping,
            externalReferencesMap 
        });
        const newNote = new Zotero.Item('note');
        newNote.setNote(formattedContent);
        if (citation && citation.parentKey) {
            newNote.parentKey = citation.parentKey;
        }
        await newNote.saveTx();
        selectItem(newNote);
    };

    const copyRequestId = async () => {
        await copyToClipboard(lastMessage.id);
    }

    const copyCitationMetadata = async () => {
        await copyToClipboard(JSON.stringify(store.get(citationDataListAtom), null, 2));
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
                            menuItems={getShareMenuItems()}
                            className="scale-11"
                            ariaLabel="Share"
                            variant="ghost"
                            positionAdjustment={{ x: 0, y: 0 }}
                            toggleCallback={(isOpen) => { if (isOpen) forceUpdate({}); }}
                        />
                    }
                    <IconButton
                        icon={RepeatIcon}
                        onClick={handleRepeat}
                        className="scale-11"
                        ariaLabel="Regenerate response"
                    />
                    {lastMessage.status !== 'error' &&
                        <CopyButton
                            content={combinedContent}
                            formatContent={renderToMarkdown}
                            className="scale-11"
                        />
                    }
                </div>
            </div>

            {/* Sources section */}
            {sourcesVisible && (
                <CitedSourcesList citations={uniqueCitations} />
            )}
        </>
    );
};

export default AssistantMessageFooter;