import React from 'react';
import { AgentRun, ModelResponse } from '../../agents/types';
import { UserRequestView } from './UserRequestView';
import { ModelMessagesView } from './ModelMessagesView';
import { AgentRunFooter } from './AgentRunFooter';
import { RunStatusIndicator } from './RunStatusIndicator';

interface AgentRunViewProps {
    run: AgentRun;
    isLastRun: boolean;
}

/** Check if there's any visible content in the run's model messages */
const hasVisibleContent = (run: AgentRun): boolean => {
    if (run.model_messages.length === 0) return false;
    
    // Check the last message for visible content
    const lastMessage = run.model_messages[run.model_messages.length - 1];
    if (lastMessage.kind !== 'response') return false;
    
    const response = lastMessage as ModelResponse;
    return response.parts.some(part => 
        (part.part_kind === 'text' && part.content.trim() !== '') ||
        (part.part_kind === 'thinking' && part.content.trim() !== '') ||
        part.part_kind === 'tool-call'
    );
};

/**
 * Container component for a single agent run.
 * Renders the user's request, model messages, status indicator, and usage footer.
 */
export const AgentRunView: React.FC<AgentRunViewProps> = ({ run, isLastRun }) => {
    const isStreaming = run.status === 'in_progress';
    const hasError = run.status === 'error';
    
    // Only show spinner when streaming AND no visible content yet
    const showStatusIndicator = isLastRun && (
        hasError || (isStreaming && !hasVisibleContent(run))
    );

    return (
        <div id={`run-${run.id}`} className="display-flex flex-col gap-4">
            {/* User's message */}
            <UserRequestView userPrompt={run.user_prompt} runId={run.id} />

            {/* Model responses */}
            {run.model_messages.length > 0 && (
                <ModelMessagesView
                    messages={run.model_messages}
                    runId={run.id}
                    isStreaming={isStreaming}
                />
            )}

            {/* Status indicator - only shown when no visible content yet or on error */}
            {showStatusIndicator && (
                <RunStatusIndicator status={run.status} />
            )}

            {/* Footer with sources and action buttons */}
            {run.status === 'completed' && run.model_messages.length > 0 && (
                <div className="px-4">
                    <AgentRunFooter run={run} />
                </div>
            )}

        </div>
    );
};

export default AgentRunView;

