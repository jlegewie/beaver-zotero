import React from 'react';
// @ts-ignore no idea why
import { useState, useEffect } from 'react';
import { ChatMessage } from '../types/chat/ui';
import MarkdownRenderer from './MarkdownRenderer';
import { Spinner, AlertIcon, ArrowDownIcon, ArrowRightIcon, CSSItemTypeIcon, LibraryIcon } from './icons';
import Button from './button';
import { getDisplayNameFromItem } from '../utils/sourceUtils';

interface ToolMessageDisplayProps {
    message: ChatMessage;
}

const ToolMessageDisplay: React.FC<ToolMessageDisplayProps> = ({
    message
}) => {
    const [resultsVisible, setResultsVisible] = useState(false);
    const [loadingDots, setLoadingDots] = useState(1);
    const [resolvedItems, setResolvedItems] = useState<Zotero.Item[]>([]);
    const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);

    // Add interval for animating the dots when status is in_progress
    useEffect(() => {
        let interval: NodeJS.Timeout;
        
        if (message.status === 'in_progress') {
            interval = setInterval(() => {
                setLoadingDots((dots: number) => dots < 3 ? dots + 1 : 1);
            }, 250);
        }
        
        return () => {
            if (interval) clearInterval(interval);
        };
    }, [message.status]);

    // Fetch Zotero items when results are visible
    useEffect(() => {
        const fetchItems = async () => {
            if (resultsVisible && message.tool_calls?.[0]?.response?.attachments) {
                const items = [];
                for (const attachment of message.tool_calls[0].response.attachments) {
                    const item = await Zotero.Items.getByLibraryAndKeyAsync(
                        attachment.library_id, 
                        attachment.zotero_key
                    );
                    if (item) items.push(item.parentItem || item);
                }
                setResolvedItems(items);
            }
        };
        
        fetchItems();
    }, [resultsVisible, message.tool_calls]);

    const toggleResults = () => {
        setResultsVisible(!resultsVisible);
    }
    
    const handleItemClick = (item: Zotero.Item) => {
        // @ts-ignore selectItem exists
        Zotero.getActiveZoteroPane().itemsView.selectItem(item.id);
    };

    const numResults = message.tool_calls?.[0]?.response?.attachments?.length ?? 0;

    const getIcon = () => {
        if (message.status === 'in_progress') {
            return Spinner;
        } else if (message.status === 'error') {
            return AlertIcon;
        } else if (message.status === 'completed' && numResults === 0) {
            return AlertIcon;
        } else if (message.status === 'completed' && numResults > 0) {
            return resultsVisible ? ArrowDownIcon : ArrowRightIcon;
        }
    }

    const getButtonText = () => {
        if (message.status === 'error') {
            return 'Library search error';
        } else if (message.status === 'in_progress') {
            return `Searching library${''.padEnd(loadingDots, '.')}`;
        } else if (message.status === 'completed' && numResults === 0) {
            return 'Library search: no results';
        } else if (message.status === 'completed' && numResults > 0) {
            return `Library search (${numResults} ${numResults === 1 ? 'item' : 'items'})`;
        }
    }

    return (
        <div className="py-1">
            {message.content && <MarkdownRenderer className="markdown" content={message.content} />}
            <Button
                variant="ghost"
                onClick={toggleResults}
                className={`text-base scale-105 ${message.status === 'in_progress' || message.status === 'error' || message.status === 'completed' && numResults === 0 ? 'disabled-but-styled' : ''}`}
                iconClassName="scale-12"
                icon={getIcon()}
                disabled={
                    message.status === 'in_progress' ||
                    message.status === 'error' ||
                    message.status === 'completed' && numResults === 0
                }
            >
                <span style={{ marginLeft: '-2px' }}>
                    {getButtonText()}
                </span>
            </Button>
            {resultsVisible && (
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

export default ToolMessageDisplay;