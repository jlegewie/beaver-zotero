import React, { useRef } from 'react';
import { ChatMessage } from '../../types/chat/uiTypes';
import MarkdownRenderer from './MarkdownRenderer';
import ContextMenu from '../ui/menu/ContextMenu';
import useSelectionContextMenu from '../../hooks/useSelectionContextMenu';
import { ErrorDisplay, WarningDisplay } from './ErrorWarningDisplay';
import { AssistantMessageTools} from './AssistantMessageTools';
import AssistantMessageFooter from './AssistantMessageFooter';
import GeneratingIndicator from '../ui/GeneratingIndicator';
import ThinkingContent from './ThinkingContent';

interface AssistantMessageProps {
    message: ChatMessage;
    isFirstAssistantMessage: boolean;
    previousMessageHasToolCalls: boolean;
    isLastMessage: boolean;
    showActionButtons: boolean;
}

const AssistantMessage: React.FC<AssistantMessageProps> = ({
    message,
    isFirstAssistantMessage,
    previousMessageHasToolCalls,
    isLastMessage,
    showActionButtons
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
        <div id={`message-${message.id}`} className={`px-4 ${isLastMessage ? 'pb-3' : ''} hover-trigger`}>
            <div 
                className="user-select-text"
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
                        thinkingContent={message.reasoning_content}
                        isThinking={message.status === 'thinking'}
                        previousMessageHasToolCalls={previousMessageHasToolCalls}
                    />
                )}
                
                {/* Content */}
                {message.content && (
                    <MarkdownRenderer className="markdown" content={message.content} />
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
                    <ErrorDisplay errorType={message.errorType || 'unknown'} />
                }
            </div>

            {/* Footer with buttons and sources */}
            {showActionButtons && (
                <AssistantMessageFooter
                    message={message}
                    isLastMessage={isLastMessage}
                />
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

export default AssistantMessage;