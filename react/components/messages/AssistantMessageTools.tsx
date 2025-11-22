import React from 'react';
import { ChatMessage } from '../../types/chat/uiTypes';
import { SearchExternalReferencesResult, ToolCall } from '../../types/chat/apiTypes';
import { isAnnotationTool } from '../../types/proposedActions/base';
import { isCreateZoteroItemTool, isSearchExternalReferencesTool } from '../../types/proposedActions/items';
import AnnotationToolDisplay from './AnnotationToolDisplay';
import AddItemToolDisplay from './AddItemToolDisplay';
import { SearchToolDisplay } from './SearchToolDisplay';
import SearchExternalReferencesToolDisplay from './SearchExternalReferencesToolDisplay';

interface AssistantMessageToolsProps {
    message: ChatMessage;
    isFirstAssistantMessage: boolean;
    previousMessageHasToolCalls: boolean;
}

/**
 * Helper function to extract attachment_id from tool call arguments
 * @param toolCall - The tool call to extract attachment_id from
 * @returns The attachment_id if found, null otherwise
 */
export function getAttachmentIdFromToolCall(toolCall: ToolCall): string | null {
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
 * - Add item tools: grouped together
 * @param toolCalls - Array of tool calls to group
 * @returns Array of tool call groups
 */
type ToolCallGroup = {
    id: string;
    toolCalls: ToolCall[];
};

function buildGroupId(messageId: string, toolCalls: ToolCall[]): string {
    const ids = toolCalls.map((tc) => tc.id).sort().join('|');
    return `${messageId}:${ids}`;
}

function groupToolCalls(toolCalls: ToolCall[], messageId: string): ToolCallGroup[] {
    const groups: ToolCallGroup[] = [];
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
                groups.push({ id: buildGroupId(messageId, [toolCall]), toolCalls: [toolCall] });
            }
        } else {
            // Non-annotation tools are kept as individual groups
            groups.push({ id: buildGroupId(messageId, [toolCall]), toolCalls: [toolCall] });
        }
    }

    // Add all annotation groups to the main groups array
    for (const [attachmentId, group] of annotationGroups.entries()) {
        groups.push({ id: `${messageId}:${attachmentId}`, toolCalls: group });
    }

    return groups;
}

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
    const toolCallGroups = groupToolCalls(message.tool_calls, message.id);

    return (
        <div
            id={`tools-${message.id}`}
            className={
                `display-flex flex-col py-1 gap-3
                ${getTopMargin()}`
            }
        >
            {toolCallGroups.map((group, groupIndex) => {
                const firstTool = group.toolCalls[0];

                // Annotation tool calls
                if (isAnnotationTool(firstTool.function?.name)) {
                     return (
                        <div key={`group-${groupIndex}`} className="display-flex flex-col gap-2">
                            <AnnotationToolDisplay key={group.id} messageId={message.id} groupId={group.id} toolCalls={group.toolCalls} />
                        </div>
                    );

                // Create Zotero item tool calls are handled by AddItemToolDisplay
                } else if (isCreateZoteroItemTool(firstTool.function?.name)) {
                    return (
                        <div key={`group-${groupIndex}`} className="display-flex flex-col gap-2">
                            <AddItemToolDisplay key={group.id} messageId={message.id} groupId={group.id} toolCalls={group.toolCalls} />
                        </div>
                    );
                }

                // External references tool calls
                if (isSearchExternalReferencesTool(firstTool.function?.name)) {
                    return (
                        <div key={`group-${groupIndex}`} className="display-flex flex-col gap-2">
                            <SearchExternalReferencesToolDisplay
                                key={group.id}
                                toolCall={firstTool}
                                isHovered={false}
                            />
                        </div>
                    );
                }

                // Search external references tool calls
                return <SearchToolDisplay key={firstTool.id} messageId={message.id} toolCall={firstTool} />;
            })}
        </div>
    );
};

export default AssistantMessageTools;
