import React from 'react';
import { useAtomValue } from 'jotai';
import { AgentRun, ModelResponse } from '../../agents/types';
import { UserRequestView } from './UserRequestView';
import { ModelMessagesView } from './ModelMessagesView';
import { AgentRunFooter } from './AgentRunFooter';
import { AgentActionsDisplay } from './AgentActionsDisplay';
import { RunErrorDisplay } from './RunErrorDisplay';
import { RunWarningDisplay } from './RunWarningDisplay';
import { threadWarningsAtom } from '../../atoms/warnings';

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
    const allWarnings = useAtomValue(threadWarningsAtom);
    const runWarnings = allWarnings.filter((w) => w.run_id === run.id);
    
    // Only show spinner when streaming AND no visible content yet (not for errors)
    const showStatusIndicator = isLastRun && isStreaming && !hasVisibleContent(run);

    return (
        <div id={`run-${run.id}`} className="display-flex flex-col gap-4">
            {/* User's message */}
            <UserRequestView userPrompt={run.user_prompt} runId={run.id} />

            {/* Warning display (dismissable, non-persistent) */}
            {runWarnings.length > 0 && (
                <div className="px-4 display-flex flex-col gap-2">
                    {runWarnings.map((warning) => (
                        <RunWarningDisplay key={warning.id} warning={warning} />
                    ))}
                </div>
            )}

            {/* Model responses and status indicator */}
            <ModelMessagesView
                messages={run.model_messages}
                runId={run.id}
                isStreaming={isStreaming}
                showStatusIndicator={showStatusIndicator}
                status={run.status}
            />

            {/* Error display (includes retry button) */}
            {hasError && run.error && (
                <div className="px-4">
                    <RunErrorDisplay runId={run.id} error={run.error} />
                </div>
            )}

            {/* Footer with sources and action buttons (only for completed runs) */}
            {run.status === 'completed' || run.status === 'canceled' && (
                <div className="px-4">
                    <AgentRunFooter run={run} />
                </div>
            )}

            {/* Agent actions (e.g., create item from citations) */}
            {run.status === 'completed' && (
                <div className="px-4">
                    <AgentActionsDisplay run={run} />
                </div>
            )}

        </div>
    );
};

export default AgentRunView;

