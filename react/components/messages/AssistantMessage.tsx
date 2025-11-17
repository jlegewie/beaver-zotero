import React, { useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { ChatMessage, ErrorMessage } from '../../types/chat/uiTypes';
import MarkdownRenderer from './MarkdownRenderer';
import ContextMenu from '../ui/menu/ContextMenu';
import useSelectionContextMenu from '../../hooks/useSelectionContextMenu';
import { ErrorDisplay, WarningDisplay } from './ErrorWarningDisplay';
import { AssistantMessageTools} from './AssistantMessageTools';
import GeneratingIndicator from '../ui/GeneratingIndicator';
import ThinkingContent from './ThinkingContent';

interface AssistantMessageProps {
    message: ChatMessage;
    isFirstAssistantMessage: boolean;
    previousMessageHasToolCalls: boolean;
    isLastMessage: boolean;
}

const AssistantMessage: React.FC<AssistantMessageProps> = ({
    message,
    isFirstAssistantMessage,
    previousMessageHasToolCalls,
    isLastMessage,
}) => {
    const contentRef = useRef<HTMLDivElement | null>(null);
        
    const { 
        isMenuOpen: isSelectionMenuOpen, 
        menuPosition: selectionMenuPosition,
        closeMenu: closeSelectionMenu,
        handleContextMenu,
        menuItems: selectionMenuItems
    } = useSelectionContextMenu(contentRef);

    return (
        <div
            id={`message-${message.id}`}
            className="px-4 hover-trigger user-select-text"
            ref={contentRef}
            onContextMenu={handleContextMenu}
        >
                {/* Warnings */}
                {message.warnings?.map((warning) => (
                    <WarningDisplay key={message.id} messageId={message.id} warning={warning} />
                ))}

                {/* Reasoning */}
                {message.reasoning_content && (
                    <ThinkingContent
                        messageId={message.id}
                        thinkingContent={message.reasoning_content}
                        isThinking={message.status === 'thinking'}
                        previousMessageHasToolCalls={previousMessageHasToolCalls}
                        messageHasContent={message.content && message.content.trim() !== '' ? true : false}
                    />
                )}
                
                {/* Content */}
                {message.content && message.content.trim() !== '' && (
                    <MarkdownRenderer
                        className="markdown"
                        content={message.content}
                        messageId={message.id}
                    />
                )}

                {/* Toolcalls */}
                {message.tool_calls && message.tool_calls.length > 0 && (
                    <AssistantMessageTools
                        key={`tools-${message.id}`}
                        message={message}
                        isFirstAssistantMessage={isFirstAssistantMessage}
                        previousMessageHasToolCalls={previousMessageHasToolCalls}
                    />
                )}

                {/* Generating button */}
                {message.status === 'in_progress' && message.content === '' && isLastMessage && !message.tool_calls && (
                    <GeneratingIndicator status={message.status} previousMessageHasToolCalls={previousMessageHasToolCalls}/>
                )}

                {/* Error */}
                {message.status === 'error' &&
                    <ErrorDisplay error={message.error || ({ id: uuidv4(), type: message.errorType || 'unknown' } as ErrorMessage)} />
                }

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

export default AssistantMessage;