import React from 'react';
import { ModelMessage, AgentRunStatus } from '../../agents/types';
import { ModelResponseView } from './ModelResponseView';
import { RunStatusIndicator } from './RunStatusIndicator';

interface ModelMessagesViewProps {
    messages: ModelMessage[];
    runId: string;
    isStreaming: boolean;
    /** Whether to show the status indicator inside this container */
    showStatusIndicator?: boolean;
    /** The run status (required when showStatusIndicator is true) */
    status?: AgentRunStatus;
}

/**
 * Renders the model messages in an agent run.
 * Only renders ModelResponse messages (kind='response').
 * ModelRequest messages (user prompts or tool returns) are handled via toolResultsMapAtom.
 */
export const ModelMessagesView: React.FC<ModelMessagesViewProps> = ({
    messages,
    runId,
    isStreaming,
    showStatusIndicator,
    status,
}) => {
    // Don't render anything if there's no content to show
    if (messages.length === 0 && !showStatusIndicator) {
        return null;
    }

    return (
        <div className="display-flex flex-col px-4">
            {messages.map((message, index) => {
                // Only render response messages - request messages are either displayed
                // separately (user prompts) or inline with their corresponding
                // tool calls (tool returns)
                if (message.kind === 'response') {
                    const isLastMessage = index === messages.length - 1;
                    return (
                        <ModelResponseView
                            key={`${runId}-response-${index}`}
                            message={message}
                            isStreaming={isStreaming && isLastMessage}
                            runId={runId}
                            responseIndex={index}
                        />
                    );
                }
                return null;
            })}
            {/* Status indicator rendered inside the same container for smooth transitions */}
            {showStatusIndicator && status && (
                <RunStatusIndicator status={status} runId={runId} />
            )}
        </div>
    );
};

export default ModelMessagesView;

