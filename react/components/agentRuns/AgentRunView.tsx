import React from 'react';
import { AgentRun } from '../../agents/types';
import { UserRequestView } from './UserRequestView';
import { ModelMessagesView } from './ModelMessagesView';
import { RunStatusIndicator } from './RunStatusIndicator';
import { UsageFooter } from './UsageFooter';

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
            <UserRequestView message={run.message} />

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

            {/* Usage footer for completed runs */}
            {run.status === 'completed' && run.total_usage && (
                <UsageFooter usage={run.total_usage} cost={run.total_cost} />
            )}
        </div>
    );
};

export default AgentRunView;

