import React from 'react';
import { AgentRun } from '../../agents/types';
import { UserRequestView } from './UserRequestView';
import { ModelMessagesView } from './ModelMessagesView';
import { AgentRunFooter } from './AgentRunFooter';
import { RunStatusIndicator } from './RunStatusIndicator';
import { TokenUsageDisplay } from './TokenUsageDisplay';

interface AgentRunViewProps {
    run: AgentRun;
    isLastRun: boolean;
}

/**
 * Container component for a single agent run.
 * Renders the user's request, model messages, status indicator, and usage footer.
 */
export const AgentRunView: React.FC<AgentRunViewProps> = ({ run, isLastRun }) => {
    const isStreaming = run.status === 'in_progress';
    const hasError = run.status === 'error';

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

            {/* Status indicator for streaming or error states */}
            {(isStreaming || hasError) && isLastRun && (
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

