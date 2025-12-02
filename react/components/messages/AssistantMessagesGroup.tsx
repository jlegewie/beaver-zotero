import React from 'react';
import { useAtomValue } from 'jotai';
import { ChatMessage } from '../../types/chat/uiTypes';
import AssistantMessage from './AssistantMessage';
import AssistantMessageFooter from './AssistantMessageFooter';
import { isChatRequestPendingAtom } from '../../atoms/threads';

interface AssistantMessagesGroupProps {
    messages: ChatMessage[];
    isLastGroup: boolean;
    isFirstAssistantGroup: boolean;
}

const AssistantMessagesGroup: React.FC<AssistantMessagesGroupProps> = ({
    messages,
    isLastGroup,
    isFirstAssistantGroup,
}) => {

    return (
        <div className="assistant-messages-group display-flex flex-col gap-3 px-4">
            {messages.map((message, index) => {
                const isFirstMessageInGroup = index === 0;
                const isLastMessageInGroup = index === messages.length - 1;
                const isLastMessageOverall = isLastGroup && isLastMessageInGroup;
                
                // Get previous message tool calls for context
                const prevMessage = index > 0 ? messages[index - 1] : null;
                const previousHasToolCalls = prevMessage ? (prevMessage.tool_calls || []).length > 0 : false;

                return (
                    <AssistantMessage
                        key={message.id}
                        message={message}
                        isFirstAssistantMessage={isFirstAssistantGroup && isFirstMessageInGroup}
                        previousMessageHasToolCalls={previousHasToolCalls}
                        isLastMessage={isLastMessageOverall}
                    />
                );
            })}
            
            {/* Footer with sources and buttons */}
            <div className="message-footer">
                <AssistantMessageFooter
                    messages={messages}
                />
            </div>
        </div>
    );
};

export default AssistantMessagesGroup;