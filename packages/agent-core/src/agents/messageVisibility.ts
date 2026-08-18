/**
 * Model requests contain assembled model input, not user-authored transcript
 * text. Render the user's prompt separately and only show responses as-is.
 */

import type { ModelMessage, ModelResponse } from './types';

/** True for messages that may be rendered to the user as-is. */
export function isRenderableMessage(message: ModelMessage): message is ModelResponse {
    return message.kind === 'response';
}
