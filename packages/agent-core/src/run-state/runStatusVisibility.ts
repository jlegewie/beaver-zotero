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

import { isAutoLoadingToolCall } from "../agents/messageVisibility";
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
function hasVisibleContent(run: AgentRun): boolean {
    const lastMessage = run.model_messages[run.model_messages.length - 1];
    if (!lastMessage || lastMessage.kind !== "response") return false;

    return (lastMessage as ModelResponse).parts.some(
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
 * True exactly in the gaps: after the prompt is sent and before the first part
 * arrives, and between a tool result and whatever the model does next. A tool
 * call still running is not a gap — its own card says so, and a second spinner
 * beside it would be the pane claiming two things are happening.
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
): boolean {
    return (
        run.status === "in_progress" &&
        !hasVisibleContent(run) &&
        !hasInProgressToolCall(run, toolResults)
    );
}
