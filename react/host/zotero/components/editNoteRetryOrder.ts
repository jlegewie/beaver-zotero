import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { hasFailedUndo } from './agentActionViewHelpers';

/**
 * Split failed note edits by retry operation. Undos run newest-to-oldest to
 * preserve dependencies between sequential edits to the same note; applies
 * retain their original order.
 */
export function getEditNoteRetryOrder(errorActions: AgentAction[]): {
    undoActions: AgentAction[];
    applyActions: AgentAction[];
} {
    const undoActions = errorActions.filter((action) => hasFailedUndo([action])).reverse();
    const applyActions = errorActions.filter((action) => !hasFailedUndo([action]));
    return { undoActions, applyActions };
}
