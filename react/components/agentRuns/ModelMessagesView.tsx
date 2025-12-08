import React from 'react';
import { ModelMessage } from '../../agents/types';
import { ModelResponseView } from './ModelResponseView';

interface ModelMessagesViewProps {
    messages: ModelMessage[];
    runId: string;
    isStreaming: boolean;
}

/**
 * Renders the model messages in an agent run.
 * Only renders ModelResponse messages (kind='response').
 * ModelRequest messages (tool returns) are handled via toolResultsMapAtom.
 */
export const ModelMessagesView: React.FC<ModelMessagesViewProps> = ({
    messages,
    runId,
    isStreaming,
}) => {
    return (
        <div className="model-messages-view display-flex flex-col gap-3 px-4">
            {messages.map((message, index) => {
                // Only render response messages - request messages (tool returns)
                // are displayed inline with their corresponding tool calls
                if (message.kind === 'response') {
                    const isLastMessage = index === messages.length - 1;
                    return (
                        <ModelResponseView
                            key={`${runId}-response-${index}`}
                            message={message}
                            isStreaming={isStreaming && isLastMessage}
                        />
                    );
                }
                return null;
            })}
        </div>
    );
};

export default ModelMessagesView;

