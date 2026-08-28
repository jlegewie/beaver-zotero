import React, { forwardRef, useMemo, useState, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { AgentRun, ToolCallPart } from '@beaver/agent-core/agents/types';
import { shouldShowRunStatus } from '@beaver/agent-core/run-state/runStatusVisibility';
import { shouldOfferResume, wasRunContinued } from '@beaver/agent-core/run-state/runResumeHelpers';
import { UserRequestView } from './UserRequestView';
import { ModelMessagesView } from './ModelMessagesView';
import { AgentRunFooter } from './AgentRunFooter';
import { SuggestionsView } from './SuggestionsView';
import { RunErrorDisplay } from './RunErrorDisplay';
import { RunWarningDisplay } from './RunWarningDisplay';
import { RunResumeDisplay } from './RunResumeDisplay';
import { RunInterruptedDisplay } from './RunInterruptedDisplay';
import { threadWarningsAtom } from '../../atoms/warnings';
import { resumeChainAtom, runToolResultsAtom, resumedRunIdsAtom } from '@beaver/agent-core/run-state/atoms';
import { streamQuietAtom } from '@beaver/agent-core/run-state/streamActivity';
import { autoReplacementPendingRunIdsAtom, streamingDoneRunIdsAtom } from '../../atoms/agentRunAtoms';
import { getHost } from '@beaver/agent-ui/host';
import BatchRunReceipt, { hasBatchReceipt } from '@beaver/agent-ui/chat/BatchRunReceipt';

interface AgentRunViewProps {
    run: AgentRun;
    isLastRun: boolean;
}

/**
 * Container component for a single agent run.
 * Renders the user's request, model messages, status indicator, and usage footer.
 */
export const AgentRunView = React.memo(forwardRef<HTMLDivElement, AgentRunViewProps>(function AgentRunView({ run, isLastRun }, ref) {
    const isStreaming = run.status === 'in_progress';
    const hasError = run.status === 'error';
    const allWarnings = useAtomValue(threadWarningsAtom);
    const runWarnings = allWarnings.filter((w) => w.run_id === run.id && w.type !== 'credit_info');
    const resumedRunIds = useAtomValue(resumedRunIdsAtom);
    // Scoped to this run rather than the thread: a thread-wide subscription
    // re-renders every run on every frame of a later run's response.
    const resultsMap = useAtomValue(useMemo(() => runToolResultsAtom(run.id), [run.id]));
    // A response continued after an interruption spans several runs but reads
    // as one message, so what the whole answer ended up doing belongs under its
    // last run — beside the footer, which already speaks for the chain. An
    // ordinary run is a chain of one, so nothing changes for it.
    const chainAtomValue = useAtomValue(useMemo(() => resumeChainAtom(run.id), [run.id]));
    // Empty only if this run has left the thread while its card is still
    // mounted. The chain is always at least the run itself.
    const chainRuns = useMemo(
        () => (chainAtomValue.length > 0 ? chainAtomValue : [run]),
        [chainAtomValue, run],
    );
    const streamingDoneRunIds = useAtomValue(streamingDoneRunIdsAtom);
    const isPostProcessing = streamingDoneRunIds.has(run.id);
    // Safe to subscribe from every run in the thread: this atom changes when a
    // wait starts and when it ends, not once per streamed token.
    const streamQuiet = useAtomValue(streamQuietAtom);

    // A run a later run continued: its error card or resume offer and its
    // footer give way to the continuation's, and it shows the subtle resume
    // line instead. Covers a failed run and an interrupted one alike.
    const wasResumed = wasRunContinued(run, resumedRunIds);

    // A run the client is already replacing on its own. Its error card is
    // suppressed until the replacement lands.
    const autoReplacementPending = useAtomValue(autoReplacementPendingRunIdsAtom).has(run.id);

    // A run that was cut off (Beaver closed, connection dropped, server
    // restarted) rather than finished or stopped by the user gets an offer to
    // continue it.
    const offerResume = shouldOfferResume(run, { isLastRun, resumedRunIds });

    // Don't show user message for resume runs (empty content)
    const showUserMessage = !run.user_prompt.is_resume || run.user_prompt.content.length > 0;
    
    // The provider can go quiet mid-response — after the sentence of preamble it
    // writes before calling its tools, while it works out what those calls are —
    // and until it speaks again there is nothing in the run to render. The wait
    // has to be observed rather than derived, so it arrives from the stream
    // tracker; `isPostProcessing` excludes the tail after the model is done,
    // which the footer already speaks for.
    const isStreamQuiet =
        streamQuiet?.runId === run.id && !isPostProcessing;

    // Only the newest run: further up the thread a run that is still working is
    // one the conversation has moved past, and its gap is not what the reader is
    // waiting on.
    const runHasNothingToShow = useMemo(
        () => shouldShowRunStatus(run, resultsMap, { isStreamQuiet }),
        [run, resultsMap, isStreamQuiet],
    );
    const showStatusIndicator = isLastRun && runHasNothingToShow;

    // Where the visible wait started, so the indicator can count it up. Null
    // while the run has produced nothing yet: there is no event to count from,
    // and the indicator falls back to its own mount.
    const waitingSince = isStreamQuiet ? streamQuiet.quietSince : null;

    // Show agent run footer
    const showAgentRunFooter =
        run.status === 'completed' ||
        run.status === 'canceled' ||
        isPostProcessing ||
        (wasResumed &&  run.model_messages.length > 0 && run.model_messages[run.model_messages.length - 1].parts.some(part => part.part_kind === 'text' && part.content.trim() !== '')) ||
        (run.status === 'error' && !isLastRun);

    // Extract suggestion parts from the last model message (only shown for last run)
    const suggestionParts = useMemo(() => {
        if (!isLastRun) return [];
        const parts: ToolCallPart[] = [];
        for (const message of run.model_messages) {
            if (message.kind === 'response') {
                for (const part of message.parts) {
                    if (part.part_kind === 'tool-call' && part.tool_name === 'return_suggestions') {
                        parts.push(part);
                    }
                }
            }
        }
        return parts;
    }, [run.model_messages, isLastRun]);

    const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
    const handleDismissSuggestions = useCallback(() => setSuggestionsDismissed(true), []);

    // Terminal statuses: the run is done. `awaiting_deferred` is still live (see isRunActive).
    const isTerminal = run.status === 'completed' || run.status === 'error' || run.status === 'canceled';

    const showRunOutcomes = isTerminal && !wasResumed;
    const showBatchReceipt = showRunOutcomes && hasBatchReceipt(chainRuns);

    // Allow editing when run is in a terminal state (not actively streaming or awaiting approval)
    const canEdit = !isStreaming && isTerminal;

    return (
        <div id={`run-${run.id}`} className="display-flex flex-col gap-4" ref={ref}>
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
                waitingSince={waitingSince}
            />

            {/* Error display (includes retry/resume buttons) - hide if run was resumed */}
            {hasError && run.error && !wasResumed && !autoReplacementPending && (
                <RunErrorDisplay runId={run.id} error={run.error} isLastRun={isLastRun} />
            )}

            {/* Offer to continue a run that was cut off mid-response */}
            {offerResume && (
                <RunInterruptedDisplay runId={run.id} reasonCode={run.error?.reason_code} />
            )}

            {/* Footer with sources and action buttons (only for completed runs, or error runs that were resumed) */}
            {(showAgentRunFooter && !wasResumed) && (
                <AgentRunFooter run={run} />
            )}


            {/* What this answer's batch jobs ended up doing. Above the changes
                card, so the two read as outcome then detail: how each batch came
                out, then the individual changes it made. */}
            {showBatchReceipt && <BatchRunReceipt runs={chainRuns} />}

            {/* Agent actions (e.g., create item from citations) — client-specific
                UI injected by the host; absent for clients without it. Actions
                are recorded per run, so a continued answer lists each run's. */}
            {showRunOutcomes && chainRuns.map((chainRun) => (
                <React.Fragment key={chainRun.id}>
                    {getHost().components?.pendingActionsReview({ run: chainRun }) ?? null}
                </React.Fragment>
            ))}

            {/* Suggestions (only for the last run, rendered below footer) */}
            {suggestionParts.length > 0 && !suggestionsDismissed && (
                <div className="px-4">
                    {suggestionParts.map((part) => (
                        <SuggestionsView
                            key={`suggestions-${part.tool_call_id}`}
                            part={part}
                            onDismiss={handleDismissSuggestions}
                        />
                    ))}
                </div>
            )}

            {/* Resuming failed request display */}
            {wasResumed && <RunResumeDisplay runId={run.id} />}

        </div>
    );
}));

AgentRunView.displayName = 'AgentRunView';

export default AgentRunView;
