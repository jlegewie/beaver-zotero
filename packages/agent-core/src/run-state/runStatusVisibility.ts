/**
 * When a run has nothing to show for itself yet.
 *
 * The companion to `runStatusCopy`: that module decides what a waiting run says,
 * this one decides whether there is anything to say it about. Shared across
 * clients because it is the rule that keeps a status line honest, and getting it
 * wrong is invisible in a screenshot — a spinner left up beside an answer reads
 * as a hang, and one missing during the wait before the first token reads as a
 * message that was never sent.
 *
 * Presentation-neutral: no markup, styling, or host APIs. Where the indicator is
 * drawn, and what it looks like, stays each client's own.
 */

import {
    isAutoLoadingToolCall,
    isThinkingInProgress,
} from "../agents/messageVisibility";
import type {
    AgentRun,
    ModelResponse,
    RetryPromptPart,
    ToolReturnPart,
} from "../agents/types";
import { getToolCallStatus } from "./atoms";

/**
 * Whether anything the reader can see has arrived in the run's newest message.
 *
 * Only the newest: everything before it is already on screen, and the question
 * this answers is whether the run is currently producing something visible or
 * leaving a gap. Auto-loading tool calls do not count — they are plumbing the
 * backend injected, and a client that hides them would be pointing at a blank
 * space if they suppressed the status line.
 */
function newestResponse(run: AgentRun): ModelResponse | null {
    const lastMessage = run.model_messages[run.model_messages.length - 1];
    if (!lastMessage || lastMessage.kind !== "response") return null;
    return lastMessage as ModelResponse;
}

function hasVisibleContent(run: AgentRun): boolean {
    const lastMessage = newestResponse(run);
    if (!lastMessage) return false;

    return lastMessage.parts.some(
        (part) =>
            (part.part_kind === "text" && part.content.trim() !== "") ||
            (part.part_kind === "thinking" && part.content.trim() !== "") ||
            (part.part_kind === "tool-call" && !isAutoLoadingToolCall(part)),
    );
}

/**
 * Whether a tool call anywhere in the run is still waiting on its result.
 *
 * The whole run rather than its newest message, because a call and its result
 * land in different messages: the parallel calls a model makes in one turn are
 * only finished when the last of them comes back, and the card the reader is
 * watching is wherever that call was made.
 *
 * Auto-loading calls are counted here even though `hasVisibleContent` ignores
 * them, and the asymmetry is deliberate rather than an oversight. The two halves
 * answer different questions: whether there is something on screen, and whether
 * the run is between steps. A client that hides an auto-loading call has neither
 * a card nor this line for as long as one is outstanding — which is the whole
 * of its execution, measured in single-digit milliseconds — while a client that
 * draws one would get this line beside a card already saying the same thing.
 * Excluding them here buys the first client a gap no reader can perceive and
 * costs the second a visibly doubled claim, so it is not worth making until
 * both clients agree on whether such a call is drawn at all.
 */
function hasInProgressToolCall(
    run: AgentRun,
    toolResults: Map<string, ToolReturnPart | RetryPromptPart>,
): boolean {
    for (const message of run.model_messages) {
        if (message.kind !== "response") continue;
        for (const part of message.parts) {
            if (
                part.part_kind === "tool-call" &&
                getToolCallStatus(
                    part.tool_call_id,
                    toolResults,
                    run.status,
                ) === "in_progress"
            ) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Whether a run is working with nothing on screen to show for it.
 *
 * True in two kinds of gap. The first needs no clock: the run has produced
 * nothing visible at all, either because the prompt was only just sent or
 * because a tool result is the newest thing in the run and the model has yet to
 * respond to it. The second is a gap *inside* a response — the reader is looking
 * at a sentence of preamble the model wrote before calling its tools, and the
 * provider has gone quiet while it decides what those tools are. Nothing about
 * the run's contents distinguishes that from a response that simply finished, so
 * the caller has to bring the observation with it in `isStreamQuiet`.
 *
 * A tool call still running is not a gap — its own card says so, and a second
 * spinner beside it would be the pane claiming two things are happening. Neither
 * is a response whose reasoning is still the only thing in it: the shimmering
 * "Thinking" line is already the working indicator, so a quiet stretch there is
 * left to it rather than doubled.
 *
 * `in_progress` and not `isRunActive`: a run holding for a deferred approval is
 * live, but it is waiting on the reader rather than working, and its card is
 * what should be drawing the eye.
 *
 * Which run is worth showing this for is the caller's to decide — in a thread,
 * only the newest.
 */
export function shouldShowRunStatus(
    run: AgentRun,
    toolResults: Map<string, ToolReturnPart | RetryPromptPart>,
    options: {
        /**
         * Whether the stream has been quiet long enough to report — see
         * `streamActivity`. Must be scoped to *this* run by the caller.
         */
        isStreamQuiet?: boolean;
    } = {},
): boolean {
    if (run.status !== "in_progress") return false;
    if (hasInProgressToolCall(run, toolResults)) return false;
    if (!hasVisibleContent(run)) return true;

    if (!options.isStreamQuiet) return false;
    const newest = newestResponse(run);
    return newest !== null && !isThinkingInProgress(newest);
}
