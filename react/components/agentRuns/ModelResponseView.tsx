import React, { useRef } from 'react';
import { AgentRunStatus, ModelResponse } from '../../agents/types';
import { TextPartView } from './TextPartView';
import { ThinkingPartView } from './ThinkingPartView';
import { ToolCallPartView } from './ToolCallPartView';
import { AnnotationToolCallView } from './AnnotationToolCallView';
import { isAnnotationToolResult } from '../../agents/toolResultTypes';
import ContextMenu from '../ui/menu/ContextMenu';
import useSelectionContextMenu from '../../hooks/useSelectionContextMenu';

interface ModelResponseViewProps {
    /** The model response */
    message: ModelResponse;
    /** Whether the response is streaming */
    isStreaming: boolean;
    /** Whether the previous message has a tool call */
    previousMessageHasToolCall: boolean;
    /** Run ID for element identification */
    runId: string;
    /** Index of this response within the run (for unique DOM IDs) */
    responseIndex: number;
    /** Run status */
    runStatus: AgentRunStatus;
}

/**
 * Renders a single model response with all its parts.
 * Parts are rendered in order: thinking, text, and tool calls.
 */
export const ModelResponseView: React.FC<ModelResponseViewProps> = ({
    message,
    isStreaming,
    previousMessageHasToolCall,
    runId,
    responseIndex,
    runStatus,
}) => {
    const contentRef = useRef<HTMLDivElement | null>(null);
    
    const { 
        isMenuOpen: isSelectionMenuOpen, 
        menuPosition: selectionMenuPosition,
        closeMenu: closeSelectionMenu,
        handleContextMenu,
        menuItems: selectionMenuItems
    } = useSelectionContextMenu(contentRef);

    // Separate parts by type for rendering
    const thinkingParts = message.parts.filter(part => part.part_kind === 'thinking');
    const textParts = message.parts.filter(part => part.part_kind === 'text');
    const toolCallParts = message.parts.filter(part => part.part_kind === 'tool-call');

    // Check if we have any visible content
    const hasContent = thinkingParts.length > 0 || textParts.length > 0 || toolCallParts.length > 0;

    if (!hasContent) {
        return null;
    }

    // Generate a unique ID for this response (used for DOM identification and UI state persistence)
    // Note: This is NOT used for proposed actions - those will use runId directly once migrated
    const responseId = `${runId}-response-${responseIndex}`;

    return (
        <div
            id={`response-${responseId}`}
            className={`hover-trigger user-select-text ${previousMessageHasToolCall ? '-mt-1' : ''}`}
            ref={contentRef}
            onContextMenu={handleContextMenu}
        >
            {/* Thinking parts (collapsible) */}
            {thinkingParts.length > 0 && (
                <ThinkingPartView
                    key={`${responseId}-thinking`}
                    parts={thinkingParts}
                    isThinking={isStreaming && textParts.length === 0 && toolCallParts.length === 0}
                    hasFollowingContent={textParts.length > 0 || toolCallParts.length > 0}
                    thinkingId={`${responseId}-thinking`}
                />
            )}

            {/* Text parts (markdown rendered) */}
            {textParts.map((part, index) => (
                part.part_kind === 'text' && (
                    <TextPartView
                        key={`text-${index}`}
                        part={part}
                        runId={runId}
                    />
                )
            ))}

            {/* Tool call parts */}
            {toolCallParts.length > 0 && (
                <div className="display-flex flex-col py-2 gap-1">
                    {toolCallParts.map((part) => {
                        if (part.part_kind !== 'tool-call') return null;
                        
                        // Use specialized view for annotation tools
                        if (isAnnotationToolResult(part.tool_name)) {
                            return (
                                <AnnotationToolCallView
                                    key={`tool-${part.tool_call_id}`}
                                    part={part}
                                    runId={runId}
                                    runStatus={runStatus}
                                />
                            );
                        }
                        
                        // Default view for other tools
                        return (
                            <ToolCallPartView
                                key={`tool-${part.tool_call_id}`}
                                part={part}
                                runId={runId}
                                runStatus={runStatus}
                            />
                        );
                    })}
                </div>
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

export default ModelResponseView;

