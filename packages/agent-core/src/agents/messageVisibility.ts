/**
 * What of a run's model messages reaches the reader.
 *
 * Model requests contain assembled model input, not user-authored transcript
 * text. Render the user's prompt separately and only show responses as-is.
 */

import type { ModelMessage, ModelResponse, ToolCallPart } from './types';

/** True for messages that may be rendered to the user as-is. */
export function isRenderableMessage(message: ModelMessage): message is ModelResponse {
    return message.kind === 'response';
}

/**
 * Backend-injected plumbing (load_capacity / read-tool auto_load injection).
 * Only `auto_load_*` IDs are suppressed — `tool_kind` is also set on normal
 * agent-initiated search/capability calls and must not drive visibility here.
 */
export function isAutoLoadingToolCall(part: ToolCallPart): boolean {
    return part.tool_call_id.startsWith('auto_load_');
}

/**
 * Whether a streaming response's thinking section is what is currently working.
 *
 * True while reasoning is the only thing the response has produced: the client
 * draws that as a shimmering "Thinking" line, which is itself a working
 * indicator. Both the renderer and `shouldShowRunStatus` ask this, so a gap gets
 * one affordance rather than two claiming the same thing.
 *
 * Any text part ends it, empty or not, because that is the point the renderer
 * has something else to put on screen. A `return_suggestions` call does not: it
 * is follow-up prompts rendered below the answer, not a step being taken.
 */
export function isThinkingInProgress(message: ModelResponse): boolean {
    let hasThinking = false;
    for (const part of message.parts) {
        if (part.part_kind === 'text') return false;
        if (part.part_kind === 'tool-call' && part.tool_name !== 'return_suggestions') return false;
        if (part.part_kind === 'thinking' && part.content.trim() !== '') hasThinking = true;
    }
    return hasThinking;
}

/**
 * Whether a response message draws anything at all.
 *
 * It draws when it has a thinking, text or tool-call part — except a
 * `return_suggestions` call, which renders as follow-up prompts under the run
 * rather than inside the message. A response holding nothing but auto-loading
 * calls draws nothing either, unless it also has text.
 */
export function hasDrawnContent(message: ModelResponse): boolean {
    const hasText = message.parts.some((part) => part.part_kind === 'text');
    const hasThinking = message.parts.some((part) => part.part_kind === 'thinking');
    const toolCalls = message.parts.filter(
        (part): part is ToolCallPart =>
            part.part_kind === 'tool-call' && part.tool_name !== 'return_suggestions',
    );
    if (!hasText && !hasThinking && toolCalls.length === 0) return false;
    const isAutoLoadingResponse =
        toolCalls.length > 0 && !hasText && toolCalls.every(isAutoLoadingToolCall);
    return !isAutoLoadingResponse;
}
