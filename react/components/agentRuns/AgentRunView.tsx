import React, { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { AgentRun, ModelResponse } from '../../agents/types';
import { UserRequestView } from './UserRequestView';
import { ModelMessagesView } from './ModelMessagesView';
import { AgentRunFooter } from './AgentRunFooter';
import { AgentActionsReview } from './AgentActionsReview';
import { RunErrorDisplay } from './RunErrorDisplay';
import { RunWarningDisplay } from './RunWarningDisplay';
import { RunResumeDisplay } from './RunResumeDisplay';
import { threadWarningsAtom } from '../../atoms/warnings';
import { getToolCallStatus, toolResultsMapAtom, resumedRunIdsAtom } from '../../agents/atoms';

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
    const resumedRunIds = useAtomValue(resumedRunIdsAtom);
    const resultsMap = useAtomValue(toolResultsMapAtom);
    
    // Check if any tool calls are currently in progress
    const hasInprogressToolcalls = useMemo(() => {
        for (const message of run.model_messages) {
            if (message.kind === 'response') {
                for (const part of message.parts) {
                    if (part.part_kind === 'tool-call') {
                        if (getToolCallStatus(part.tool_call_id, resultsMap) === 'in_progress') {
                            return true;
                        }
                    }
                }
            }
        }
        return false;
    }, [run.model_messages, resultsMap]);

    // Check if this error run was resumed (to hide error display)
    const wasResumed = hasError && resumedRunIds.has(run.id);

    // Don't show user message for resume runs (empty content)
    const showUserMessage = !run.user_prompt.is_resume || run.user_prompt.content.length > 0;
    
    // Only show spinner when streaming AND no visible content yet AND no tool calls in progress
    const showStatusIndicator = isLastRun && isStreaming && !hasVisibleContent(run) && !hasInprogressToolcalls;

    // Show agent run footer
    const showAgentRunFooter = 
        run.status === 'completed' ||
        run.status === 'canceled' ||
        (wasResumed &&  run.model_messages.length > 0 && run.model_messages[run.model_messages.length - 1].parts.some(part => part.part_kind === 'text' && part.content.trim() !== '')) ||
        (run.status === 'error' && !isLastRun);

    // Allow editing when run is in a terminal state (not actively streaming or awaiting approval)
    const canEdit = !isStreaming && (run.status === 'completed' || run.status === 'error' || run.status === 'canceled');

    return (
        <div id={`run-${run.id}`} className="display-flex flex-col gap-4">
            {/* User's message */}
            {showUserMessage && <UserRequestView userPrompt={run.user_prompt} runId={run.id} canEdit={canEdit} />}

            {/* Warning display (dismissable, non-persistent) */}
            {runWarnings.length > 0 && (
                <div className="px-5 display-flex flex-col gap-2">
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

            {/* Error display (includes retry/resume buttons) - hide if run was resumed */}
            {hasError && run.error && !wasResumed && (
                <RunErrorDisplay runId={run.id} error={run.error} isLastRun={isLastRun} />
            )}

            {/* Footer with sources and action buttons (only for completed runs, or error runs that were resumed) */}
            {(showAgentRunFooter && !wasResumed) && (
                <AgentRunFooter run={run} />
            )}

            {/* Agent actions (e.g., create item from citations) */}
            {run.status === 'completed' && <AgentActionsReview run={run} />}

            {/* Resuming failed request display */}
            {wasResumed && <RunResumeDisplay runId={run.id} />}

        </div>
    );
};

export default AgentRunView;

