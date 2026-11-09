import React, { forwardRef, useMemo, useState, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { AgentRun, ToolCallPart, isContinuationPrompt, isRunActive, isRunFinished } from '@beaver/agent-core/agents/types';
import { openParkedRunAtom } from '@beaver/agent-core/run-state/parkedRun';
import { hasInProgressToolCall, isRunWithNothingToShow, shouldShowRunStatus } from '@beaver/agent-core/run-state/runStatusVisibility';
import { wasRunContinued } from '@beaver/agent-core/run-state/runResumeHelpers';
import { PARTIAL_RESPONSE_NOTE } from '@beaver/agent-core/transport/connectionFailure';
import { UserRequestView } from './UserRequestView';
import { ModelMessagesView } from './ModelMessagesView';
import { AgentRunFooter } from './AgentRunFooter';
import { SuggestionsView } from './SuggestionsView';
import { RunErrorDisplay } from './RunErrorDisplay';
import { RunWarningDisplay } from './RunWarningDisplay';
import { RunResumeDisplay } from './RunResumeDisplay';
import { ReattachResolutionNotice, RunNotice, useReattachResolutionView } from './RunResolutionNotices';
import { isCutOffMidText, runReplacementNotesAtom } from '@beaver/agent-core/run-state/runResolution';
import { threadWarningsAtom } from '../../atoms/warnings';
import { resumeChainAtom, runToolResultsAtom, resumedRunIdsAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { streamQuietAtom } from '@beaver/agent-core/run-state/streamActivity';
import { autoReplacementPendingRunIdsAtom, streamingDoneRunIdsAtom } from '../../atoms/agentRunAtoms';
import { useVisibleReconnect } from '../../hooks/useVisibleReconnect';
import { getHost } from '@beaver/agent-ui/host';
import BatchRunReceipt, { hasBatchReceipt } from '@beaver/agent-ui/chat/BatchRunReceipt';
import { FindQueryProvider } from '@beaver/agent-ui/chat/findContext';

/**
 * The receipt with the thread behind it. Its own component so the thread
 * subscription is paid only by the few runs that draw a receipt: the records
 * a receipt names items from are written where each batch started, which can
 * be an earlier answer than the one the batch ended under, but reading the
 * thread from every run card would re-render all of them per streamed frame.
 */
const BatchReceiptForChain: React.FC<{ runs: readonly AgentRun[] }> = ({ runs }) => {
    const threadRuns = useAtomValue(threadRunsAtom);
    return <BatchRunReceipt runs={runs} historyRuns={threadRuns} />;
};

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
    // suppressed until the replacement lands — the failure is about to be
    // undone, and flashing it up would report a problem the reader never had.
    const autoReplacementPending = useAtomValue(autoReplacementPendingRunIdsAtom).has(run.id);

    // A run whose reattach failed shows a neutral state instead of its error
    // card while the server reports how it ended.
    const resolutionView = useReattachResolutionView(run.id, hasError && isLastRun);
    // The server's copy replaced this run's with a different outcome.
    const replacementNote = useAtomValue(runReplacementNotesAtom).get(run.id) ?? null;
    // A response cut off while writing: its last text may stop mid-thought.
    // Not one cut off at a tool call, whose text above was complete.
    const isPartialResponse = useMemo(
        () => isCutOffMidText(run),
        [run],
    );

    // Don't show the user message of a run that continues another (a resume,
    // or the answer to a parked card): its content is empty.
    const showUserMessage = !isContinuationPrompt(run.user_prompt) || run.user_prompt.content.length > 0;
    // A run still waiting on the user's answer to one of its cards.
    const isOpenParked = useAtomValue(openParkedRunAtom)?.runId === run.id;
    
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
    // The replacement is not instant: an auto-retry commits the failed run's
    // removal on the backend first, and that round trip would otherwise leave
    // the card with a suppressed error, no spinner, and nothing to say the
    // client is working. The run's own status is terminal, so this is the one
    // wait `shouldShowRunStatus` cannot see.
    // A run whose connection is being recovered says so wherever it is,
    // mid-answer or waiting on a card, since nothing else on screen moves —
    // once it has lasted longer than a blip.
    const isReconnecting = useVisibleReconnect() !== null && isRunActive(run);
    const showStatusIndicator = isLastRun && (runHasNothingToShow || autoReplacementPending || isReconnecting);
    // A tool call still waiting on its result already spins for the same
    // wait; the reconnect line under it drops its own spinner and only says
    // why.
    const reconnectUnderToolCall = useMemo(
        () => isReconnecting && hasInProgressToolCall(run, resultsMap),
        [isReconnecting, run, resultsMap],
    );

    // Where the visible wait started, so the indicator can count it up. Null
    // while the run has produced nothing yet: there is no event to count from,
    // and the indicator falls back to its own mount.
    const waitingSince = isStreamQuiet ? streamQuiet.quietSince : null;

    // Show agent run footer
    const showAgentRunFooter =
        isRunFinished(run) ||
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
    const isTerminal = isRunFinished(run) || run.status === 'error' || run.status === 'canceled';

    // Held while a failed reattach is resolved: the server may still be
    // waiting on a pending change, and may replace the run. Held too while
    // the run waits on its cards: their changes are decided there, and
    // applying one here would bypass the run that is waiting for it.
    const showRunOutcomes = isTerminal && !wasResumed && !resolutionView && !isOpenParked;
    const showBatchReceipt = showRunOutcomes && hasBatchReceipt(chainRuns);

    // Allow editing when run is in a terminal state (not actively streaming or awaiting approval)
    const canEdit = !isStreaming && isTerminal;

    // What the card draws besides the user message and model messages. Each
    // flag gates its own section below and also decides whether the run is
    // drawn at all, so the two cannot disagree.
    const showWarnings = runWarnings.length > 0;
    const showPartialNotice = isPartialResponse && !wasResumed;
    const showErrorArea = hasError && !!run.error && !wasResumed && !autoReplacementPending;
    const showFooter = showAgentRunFooter && !wasResumed;
    const showSuggestions = suggestionParts.length > 0 && !suggestionsDismissed;
    // Gives way to the run that continued this one, like its error card.
    const showReplacementNote = !!replacementNote && !wasResumed;
    // Not for a run that finished: a completed run can now be continued too —
    // it had work left, not an interruption — and a parked run is continued
    // by the answers to its cards; this line would call either an
    // interrupted one.
    const showResumeLine = wasResumed && !isRunFinished(run);

    // A continuation that left nothing to read. Skipped entirely rather than
    // drawn empty: the thread spaces its runs with a flex gap, so even an empty
    // card adds a blank strip.
    const hasNothingToShow = isRunWithNothingToShow(run, {
        isLastRun,
        showsRunSections:
            showStatusIndicator ||
            showWarnings ||
            showPartialNotice ||
            showErrorArea ||
            showReplacementNote ||
            showFooter ||
            showRunOutcomes ||
            showSuggestions ||
            showResumeLine,
    });
    if (hasNothingToShow) return null;

    const runCard = (
        <div id={`run-${run.id}`} className="display-flex flex-col gap-4" ref={ref}>
            {/* User's message */}
            {showUserMessage && <UserRequestView userPrompt={run.user_prompt} runId={run.id} canEdit={canEdit} />}

            {/* Warning display (dismissable, non-persistent) */}
            {showWarnings && (
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
                // The pending signal covers an auto-resume too, but only the
                // auto-retry has a wait to label: a resume installs its
                // replacement in the same synchronous batch, so the failed run
                // has stopped being the last one before anything renders.
                statusIdleLabel={autoReplacementPending ? 'Retrying' : undefined}
                statusHideIcon={reconnectUnderToolCall}
            />

            {showPartialNotice && <RunNotice text={PARTIAL_RESPONSE_NOTE} />}

            {/* Error display (includes retry/resume buttons) - hide if run was resumed */}
            {showErrorArea && run.error && (
                resolutionView
                    ? <ReattachResolutionNotice view={resolutionView} />
                    : <RunErrorDisplay runId={run.id} error={run.error} isLastRun={isLastRun} />
            )}

            {showReplacementNote && <RunNotice text={replacementNote} />}

            {/* Footer with sources and action buttons (only for completed runs, or error runs that were resumed) */}
            {showFooter && (
                <AgentRunFooter run={run} />
            )}


            {/* What this answer's batch jobs ended up doing. Above the changes
                card, so the two read as outcome then detail: how each batch came
                out, then the individual changes it made. */}
            {showBatchReceipt && <BatchReceiptForChain runs={chainRuns} />}

            {/* Agent actions (e.g., create item from citations) — client-specific
                UI injected by the host; absent for clients without it. The whole
                chain is one answer, so its per-run action records are reviewed in
                one block. */}
            {showRunOutcomes && (
                getHost().components?.pendingActionsReview({ runs: chainRuns }) ?? null
            )}

            {/* Suggestions (only for the last run, rendered below footer) */}
            {showSuggestions && (
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
            {showResumeLine && <RunResumeDisplay runId={run.id} />}

        </div>
    );

    // A streaming run is excluded from find highlighting: its text re-renders on
    // every token, so highlighting it would re-run the markdown pipeline per
    // token and make the find bar's match count jump around while the user
    // reads. Only while it streams — a run waiting on the reader (a deferred
    // approval) is not generating anything, and its answer is on screen to be
    // searched like any other. The empty provider shadows the thread-level query
    // for this run's whole subtree — no prop drilling, and it renders no element
    // of its own, so the markup is unchanged either way.
    return isStreaming ? <FindQueryProvider query="">{runCard}</FindQueryProvider> : runCard;
}));

AgentRunView.displayName = 'AgentRunView';

export default AgentRunView;
