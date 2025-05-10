import React, { useState, useEffect } from 'react';
import { ChatMessage } from '../types/chat/uiTypes';
import { ToolCall } from '../types/chat/apiTypes';
import MarkdownRenderer from './MarkdownRenderer';
import { Spinner, AlertIcon, ArrowDownIcon, ArrowRightIcon, CSSItemTypeIcon, SearchIcon, Icon } from './icons';
import Button from './button';
import { getDisplayNameFromItem } from '../utils/sourceUtils';

interface AssistantMessageToolsProps {
    message: ChatMessage;
}

interface ToolCallDisplayProps {
    toolCall: ToolCall;
}

const ToolCallDisplay: React.FC<ToolCallDisplayProps> = ({ toolCall }) => {
    const [resultsVisible, setResultsVisible] = useState(false);
    const [loadingDots, setLoadingDots] = useState(1);
    const [resolvedItems, setResolvedItems] = useState<Zotero.Item[]>([]);
    const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);

    console.log('toolCall display', toolCall);

    useEffect(() => {
        let interval: NodeJS.Timeout | undefined;
        if (toolCall.status === 'in_progress') {
            setLoadingDots(1); 
            interval = setInterval(() => {
                setLoadingDots((dots) => (dots < 3 ? dots + 1 : 1));
            }, 250);
        } else {
            setLoadingDots(1); 
        }
        return () => {
            if (interval) clearInterval(interval);
        };
    }, [toolCall.status]);

    useEffect(() => {
        const fetchItems = async () => {
            if (resultsVisible && toolCall.response?.attachments && toolCall.response.attachments.length > 0) {
                const items: Zotero.Item[] = [];
                for (const attachment of toolCall.response.attachments) {
                    try {
                        const item = await Zotero.Items.getByLibraryAndKeyAsync(
                            attachment.library_id,
                            attachment.zotero_key
                        );
                        if (item) {
                            items.push(item.parentItem || item); 
                        }
                    } catch (e) {
                        console.error("Error fetching Zotero item:", e);
                    }
                }
                setResolvedItems(items);
            } else {
                setResolvedItems([]);
            }
        };

        fetchItems();
    }, [resultsVisible, toolCall.response?.attachments]);

    const numResults = toolCall.response?.attachments?.length ?? 0;

    const toggleResults = () => {
        if (toolCall.status === 'completed' && numResults > 0) {
            setResultsVisible(!resultsVisible);
        }
    };

    const handleItemClick = (item: Zotero.Item) => {
        // @ts-ignore selectItem exists
        Zotero.getActiveZoteroPane().itemsView.selectItem(item.id);
    };

    const getIcon = () => {
        if (toolCall.status === 'in_progress') return Spinner;
        if (toolCall.status === 'error') return AlertIcon;
        if (toolCall.status === 'completed') {
            if (numResults === 0 && !toolCall.response?.content) return AlertIcon; // Show alert if truly no output
            if (numResults > 0) return resultsVisible ? ArrowDownIcon : ArrowRightIcon;
        }
        return undefined; // Default no icon if just content
    };

    const getButtonText = () => {
        const label = toolCall.label || "Calling function";
        if (toolCall.status === 'error') {
            return `${label}: Error`;
        }
        if (toolCall.status === 'in_progress') {
            return `${label}${''.padEnd(loadingDots, '.')}`;
        }
        if (toolCall.status === 'completed') {
            if (numResults === 0 && !toolCall.response?.content) return `${label}: No results`;
            if (numResults > 0) return `${label} (${numResults} ${numResults === 1 ? 'item' : 'items'})`;
            return label; // For completed tools that only have response.content
        }
        return label;
    };
    
    const hasAttachmentsToShow = numResults > 0;
    const canToggleResults = toolCall.status === 'completed' && hasAttachmentsToShow;
    const isButtonDisabled = toolCall.status === 'in_progress' || toolCall.status === 'error' || (toolCall.status === 'completed' && !hasAttachmentsToShow && !toolCall.response?.content);

    return (
        <div className="mb-2 last:mb-0">
            {(toolCall.label || toolCall.status !== 'completed' || hasAttachmentsToShow) && (
                 <Button
                    variant="ghost"
                    onClick={toggleResults}
                    className={`text-base scale-105 ${isButtonDisabled && !canToggleResults ? 'disabled-but-styled' : ''} ${!hasAttachmentsToShow && toolCall.status === 'completed' && toolCall.response?.content ? 'justify-start' : ''}`}
                    iconClassName="scale-12"
                    icon={getIcon()}
                    disabled={isButtonDisabled && !canToggleResults}
                >
                    <span style={{ marginLeft: getIcon() ? '-2px' : '0px' }}>
                        {getButtonText()}
                    </span>
                </Button>
            )}

            {toolCall.response?.content && (
                <MarkdownRenderer className="markdown px-4 py-1 text-sm" content={toolCall.response.content} />
            )}
            {toolCall.status === 'error' && toolCall.response?.error && !toolCall.response?.content && (
                <div className="px-4 py-1 text-sm text-red-600">
                     <MarkdownRenderer className="markdown" content={toolCall.response.error} />
                </div>
            )}

            {resultsVisible && hasAttachmentsToShow && (
                <div className="px-4 py-1">
                    {resolvedItems.map((item: Zotero.Item) => {
                        const itemId = `${item.libraryID}-${item.key}`;
                        const isHovered = hoveredItemId === itemId;

                        return (
                            <div
                                key={itemId}
                                className={`display-flex flex-row gap-1 items-start min-w-0 p-1 last:border-0 rounded-md cursor-pointer transition-colors duration-150 ${isHovered ? 'bg-quinary' : ''}`}
                                onClick={() => handleItemClick(item)}
                                onMouseEnter={() => setHoveredItemId(itemId)}
                                onMouseLeave={() => setHoveredItemId(null)}
                                title="Click to reveal in Zotero"
                            >
                                <span className="scale-70" style={{ marginTop: '-2px' }}>
                                    <CSSItemTypeIcon itemType={item.getItemTypeIconName()} />
                                </span>
                                <div className="display-flex flex-col gap-1 min-w-0 font-color-secondary">
                                    <span className="truncate text-sm font-color-secondary">
                                        {getDisplayNameFromItem(item)}
                                    </span>
                                    <span className="truncate text-sm font-color-tertiary min-w-0">
                                        {item.getDisplayTitle()}
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

const AssistantMessageTools: React.FC<AssistantMessageToolsProps> = ({
    message
}) => {
    if (!message.tool_calls || message.tool_calls.length === 0) {
        return null;
    }

    return (
        <div id={`tools-for-message-${message.id}`} className="py-1 px-4">
            {message.tool_calls.map((toolCall) => (
                <ToolCallDisplay key={toolCall.id} toolCall={toolCall} />
            ))}
        </div>
    );
};

export default AssistantMessageTools; 