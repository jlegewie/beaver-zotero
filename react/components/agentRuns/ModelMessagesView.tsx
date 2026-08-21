import React from 'react';
import { ModelMessage, AgentRunStatus } from '@beaver/agent-core/agents/types';
import { isRenderableMessage } from '@beaver/agent-core/agents/messageVisibility';
import { ModelResponseView } from './ModelResponseView';
import { RunStatusIndicator } from './RunStatusIndicator';
import { ContextCompressionIndicator } from './ContextCompressionIndicator';

interface ModelMessagesViewProps {
    messages: ModelMessage[];
    runId: string;
    isStreaming: boolean;
    /** Whether to show the status indicator inside this container */
    showStatusIndicator?: boolean;
    /** The run status (required when showStatusIndicator is true) */
    status: AgentRunStatus;
    /**
     * When the wait the indicator is reporting began, in epoch ms, or null when
     * the run has produced nothing to date it from.
     */
    waitingSince?: number | null;
}

/**
 * Renders the model messages in an agent run.
 *
 * Only ModelResponse messages are rendered — see `isRenderableMessage` for why
 * a ModelRequest never is. Their tool-return parts surface elsewhere, inline
 * with the matching tool call via `toolResultsMapAtom`; their user-prompt parts
 * have no consumer by design.
 */
export const ModelMessagesView: React.FC<ModelMessagesViewProps> = React.memo(function ModelMessagesView({
    messages,
    runId,
    isStreaming,
    showStatusIndicator,
    status,
    waitingSince,
}) {
    // Don't render anything if there's no content to show
    if (messages.length === 0 && !showStatusIndicator) {
        return null;
    }

    const lastMessageHasToolCall = messages[messages.length - 1]?.parts.some(
        part =>
            part.part_kind === 'tool-call' ||
                part.part_kind === 'tool-return' ||
                part.part_kind === 'retry-prompt'
        );

    return (
        <div className="display-flex flex-col px-4">
            {messages.map((message, index) => {
                // Render context compression indicator for request messages with compressed context
                // if (message.kind === 'request' && message.metadata?.context_compression?.compressed_count > 0) {
                //     return <ContextCompressionIndicator key={`${runId}-context-compression-${index}`} message={message} />;
                // }

                // Narrows to ModelResponse. The check stays inside the loop so
                // `index` keeps pointing into the full message array, which
                // `previousMessageHasToolCall` and `responseIndex` rely on.
                if (isRenderableMessage(message)) {
                    const isLastMessage = index === messages.length - 1;
                    const previousMessageHasToolCall =
                        index > 0 &&
                        messages[index - 1].parts.some(
                            part =>
                                part.part_kind === 'tool-call' ||
                                part.part_kind === 'tool-return' ||
                                part.part_kind === 'retry-prompt'
                        );
                    return (
                        <ModelResponseView
                            key={`${runId}-response-${index}`}
                            message={message}
                            isStreaming={isStreaming && isLastMessage}
                            previousMessageHasToolCall={previousMessageHasToolCall}
                            runId={runId}
                            responseIndex={index}
                            runStatus={status}
                        />
                    );
                }
                return null;
            })}
            {/* Status indicator rendered inside the same container for smooth transitions */}
            {showStatusIndicator && status && (
                <RunStatusIndicator
                    status={status}
                    runId={runId}
                    lastMessageHasToolCall={lastMessageHasToolCall}
                    waitingSince={waitingSince}
                />
            )}
        </div>
    );
});

export default ModelMessagesView;

