import React, { useRef } from 'react';
import { ModelResponse } from '../../agents/types';
import { TextPartView } from './TextPartView';
import { ThinkingPartView } from './ThinkingPartView';
import { ToolCallPartView } from './ToolCallPartView';
import ContextMenu from '../ui/menu/ContextMenu';
import useSelectionContextMenu from '../../hooks/useSelectionContextMenu';

interface ModelResponseViewProps {
    message: ModelResponse;
    isStreaming: boolean;
}

/**
 * Renders a single model response with all its parts.
 * Parts are rendered in order: thinking, text, and tool calls.
 */
export const ModelResponseView: React.FC<ModelResponseViewProps> = ({
    message,
    isStreaming,
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

    return (
        <div
            className="model-response-view hover-trigger user-select-text"
            ref={contentRef}
            onContextMenu={handleContextMenu}
        >
            {/* Thinking parts (collapsible) */}
            {thinkingParts.map((part, index) => (
                part.part_kind === 'thinking' && (
                    <ThinkingPartView
                        key={`thinking-${index}`}
                        part={part}
                        isThinking={isStreaming && index === thinkingParts.length - 1}
                        hasFollowingContent={textParts.length > 0 || toolCallParts.length > 0}
                    />
                )
            ))}

            {/* Text parts (markdown rendered) */}
            {textParts.map((part, index) => (
                part.part_kind === 'text' && (
                    <TextPartView
                        key={`text-${index}`}
                        part={part}
                    />
                )
            ))}

            {/* Tool call parts */}
            {toolCallParts.length > 0 && (
                <div className="display-flex flex-col py-1 gap-3 mt-1">
                    {toolCallParts.map((part, index) => (
                        part.part_kind === 'tool-call' && (
                            <ToolCallPartView
                                key={`tool-${part.tool_call_id}`}
                                part={part}
                            />
                        )
                    ))}
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

