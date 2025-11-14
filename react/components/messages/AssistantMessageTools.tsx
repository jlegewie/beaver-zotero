import React, { useState } from 'react';
import { ChatMessage } from '../../types/chat/uiTypes';
import { ToolCall } from '../../types/chat/apiTypes';
import MarkdownRenderer from './MarkdownRenderer';
import {
    Spinner,
    AlertIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    SearchIcon,
    ViewIcon,
    Icon
} from '../icons/icons';
import Button from '../ui/Button';
import ZoteroItemsList from '../ui/ZoteroItemsList';
import { isAnnotationTool } from '../../types/chat/proposedActions';
import AnnotationToolCallDisplay from './AnnotationToolCallDisplay';
import { useLoadingDots } from '../../hooks/useLoadingDots';

interface AssistantMessageToolsProps {
    message: ChatMessage;
    isFirstAssistantMessage: boolean;
    previousMessageHasToolCalls: boolean;
}

interface ToolCallDisplayProps {
    messageId: string;
    toolCall: ToolCall;
}

/**
 * Helper function to extract attachment_id from tool call arguments
 * @param toolCall - The tool call to extract attachment_id from
 * @returns The attachment_id if found, null otherwise
 */
function getAttachmentIdFromToolCall(toolCall: ToolCall): string | null {
    try {
        if (!toolCall.function?.arguments) return null;
        const args = typeof toolCall.function.arguments === 'string'
            ? JSON.parse(toolCall.function.arguments)
            : toolCall.function.arguments;
        return args.attachment_id || null;
    } catch (error) {
        console.warn('Failed to parse tool call arguments:', error);
        return null;
    }
}

/**
 * Groups tool calls for display
 * - Non-annotation tools: individual groups (lists of 1)
 * - Annotation tools: grouped by attachment_id
 * @param toolCalls - Array of tool calls to group
 * @returns Array of tool call groups
 */
function groupToolCalls(toolCalls: ToolCall[]): ToolCall[][] {
    const groups: ToolCall[][] = [];
    const annotationGroups = new Map<string, ToolCall[]>();

    for (const toolCall of toolCalls) {
        if (isAnnotationTool(toolCall.function?.name)) {
            const attachmentId = getAttachmentIdFromToolCall(toolCall);
            if (attachmentId) {
                // Group by attachment_id
                if (!annotationGroups.has(attachmentId)) {
                    annotationGroups.set(attachmentId, []);
                }
                annotationGroups.get(attachmentId)!.push(toolCall);
            } else {
                // No attachment_id found, keep as individual group
                groups.push([toolCall]);
            }
        } else {
            // Non-annotation tools are kept as individual groups
            groups.push([toolCall]);
        }
    }

    // Add all annotation groups to the main groups array
    for (const group of annotationGroups.values()) {
        groups.push(group);
    }

    return groups;
}

export const ToolCallDisplay: React.FC<ToolCallDisplayProps> = ({ messageId: _messageId, toolCall }) => {
    const [resultsVisible, setResultsVisible] = useState(false);
    const [isButtonHovered, setIsButtonHovered] = useState(false);
    const loadingDots = useLoadingDots(toolCall.status === 'in_progress');

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
            if(toolCall.function.name === 'read_attachments') return ViewIcon;
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
        <div id={`tool-${toolCall.id}`} className={`${resultsVisible ? 'border-popup' : 'border-transparent'} rounded-md flex flex-col min-w-0 py-1`}>
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
                style={{ padding: '2px 6px', maxHeight: 'none'}}
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
        if (message.content == '' && previousMessageHasToolCalls) return '-mt-2';
        if (message.content == '' && isFirstAssistantMessage) return '-mt-1';
        return 'mt-1';
    }

    // Group tool calls by attachment_id for annotation tools, keep others individual
    const toolCallGroups = groupToolCalls(message.tool_calls);

    return (
        <div
            id={`tools-${message.id}`}
            className={
                `display-flex flex-col py-1 gap-3
                ${getTopMargin()}`
            }
        >
            {toolCallGroups.map((group, groupIndex) => {
                // TODO: Split by proposed actions and searchtoolcall
                // For groups with single tool call
                if (group.length === 1) {
                    const toolCall = group[0];
                    // Annotation tool calls are handled by AnnotationToolCallDisplay
                    if (isAnnotationTool(toolCall.function?.name)) {
                        console.log('Annotation tool call', toolCall);
                        return <AnnotationToolCallDisplay key={toolCall.id} messageId={message.id} toolCalls={[toolCall]} />;
                    }
                    // Search tool calls are handled by ToolCallDisplay
                    return <ToolCallDisplay key={toolCall.id} messageId={message.id} toolCall={toolCall} />;
                }
                
                // For groups with multiple tool calls (annotation tools grouped by attachment_id)
                // All should be annotation tools at this point, so use AnnotationToolCallDisplay for each
                return (
                    <div key={`group-${groupIndex}`} className="display-flex flex-col gap-2">
                        <AnnotationToolCallDisplay key={group[0].id} messageId={message.id} toolCalls={group} />
                    </div>
                );
            })}
        </div>
    );
};

export default AssistantMessageTools;
