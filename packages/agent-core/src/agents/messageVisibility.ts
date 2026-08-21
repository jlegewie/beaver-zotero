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
