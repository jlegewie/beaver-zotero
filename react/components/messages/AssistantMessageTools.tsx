import React, { useState, useEffect } from 'react';
import { ChatMessage } from '../../types/chat/uiTypes';
import { ToolCall } from '../../types/chat/apiTypes';
import MarkdownRenderer from './MarkdownRenderer';
import { Spinner, AlertIcon, ArrowDownIcon, ArrowRightIcon, SearchIcon, ViewIcon, Icon } from '../icons/icons';
import Button from '../ui/Button';
import ZoteroItemsList from '../ui/ZoteroItemsList';
import { MessageErrorWarningDisplay } from './ErrorWarningDisplay';

interface AssistantMessageToolsProps {
    message: ChatMessage;
    isFirstAssistantMessage: boolean;
    previousMessageHasToolCalls: boolean;
}

interface ToolCallDisplayProps {
    toolCall: ToolCall;
}

export const ToolCallDisplay: React.FC<ToolCallDisplayProps> = ({ toolCall }) => {
    const [resultsVisible, setResultsVisible] = useState(false);
    const [loadingDots, setLoadingDots] = useState(1);
    const [isButtonHovered, setIsButtonHovered] = useState(false);

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

    const numResults = toolCall.response?.attachments?.length ?? 0;

    const toggleResults = () => {
        if (toolCall.status === 'completed' && numResults > 0) {
            setResultsVisible(!resultsVisible);
        }
    };

    const getIcon = () => {
        if (toolCall.status === 'in_progress') return Spinner;
        if (toolCall.status === 'error') return AlertIcon;
        if (toolCall.status === 'completed') {
            if (resultsVisible) return ArrowDownIcon;
            if (isButtonHovered && numResults > 0) return ArrowRightIcon;
            if(toolCall.function.name === 'related_items_search') return SearchIcon;
            if(toolCall.function.name === 'tag_search') return SearchIcon;
            if(toolCall.function.name === 'search_references_by_topic') return SearchIcon;
            if(toolCall.function.name === 'get_fulltext_content') return numResults ? ViewIcon : AlertIcon;
            if(toolCall.function.name === 'search_metadata') return SearchIcon;
            if(toolCall.function.name === 'search_references_by_metadata') return SearchIcon;
            if(toolCall.function.name === 'view_page_images') return ViewIcon;
            return SearchIcon;
        }
        return SearchIcon;
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
        <div id={`tool-${toolCall.id}`} className={`${resultsVisible ? 'border-popup' : 'border-transparent'} rounded-md flex flex-col min-w-0`}>
            <Button
                variant="ghost-secondary"
                onClick={toggleResults}
                onMouseEnter={() => setIsButtonHovered(true)}
                onMouseLeave={() => setIsButtonHovered(false)}
                className={`
                    text-base scale-105 w-full min-w-0 align-start text-left
                    ${isButtonDisabled && !canToggleResults ? 'disabled-but-styled' : ''}
                    ${!hasAttachmentsToShow && toolCall.status === 'completed' && toolCall.response?.content ? 'justify-start' : ''}
                    ${toolCall.status === 'completed' && toolCall.response?.attachments && toolCall.response.attachments.length > 0 ? 'justify-start' : ''}
                `}
                style={{ padding: '4px 6px', maxHeight: 'none'}}
                disabled={isButtonDisabled && !canToggleResults}
            >
                <div className="display-flex flex-row px-3 gap-2">
                    <div className={`flex-1 display-flex mt-020 ${resultsVisible ? 'font-color-primary' : ''}`}>
                        <Icon icon={getIcon()} />
                    </div>
                    
                    <div className={`display-flex ${resultsVisible ? 'font-color-primary' : ''}`}>
                        {getButtonText()}
                    </div>
                    
                </div>
            </Button>

            {toolCall.status === 'error' && toolCall.response?.error && !toolCall.response?.content && (
                <div className="px-4 py-1 text-sm text-red-600">
                     <MarkdownRenderer className="markdown" content={toolCall.response.error} />
                </div>
            )}

            {resultsVisible && hasAttachmentsToShow && toolCall.response && toolCall.response.attachments && (
                <div className={`py-1 ${resultsVisible ? 'border-top-quinary' : ''} mt-15`}>
                    <ZoteroItemsList messageAttachments={toolCall.response.attachments} />
                </div>
            )}
        </div>
    );
};

export const AssistantMessageTools: React.FC<AssistantMessageToolsProps> = ({
    message,
    isFirstAssistantMessage,
    previousMessageHasToolCalls,
}) => {
    if (!message.tool_calls || message.tool_calls.length === 0) {
        return null;
    }

    const getTopMargin = function() {
        if (message.content == '' && previousMessageHasToolCalls) return '-mt-3';
        if (message.content == '' && isFirstAssistantMessage) return '-mt-1';
        return 'mt-1';
    }

    return (
        <div
            id={`tools-${message.id}`}
            className={
                `display-flex flex-col py-1 gap-3
                ${getTopMargin()}`
            }
        >
            {message.tool_calls.map((toolCall) => (
                <ToolCallDisplay key={toolCall.id} toolCall={toolCall} />
            ))}
        </div>
    );
};

export default AssistantMessageTools;