import type { AgentRun, ToolCallPart } from '@beaver/agent-core/agents/types';
import { isItemCreatingAgentAction, type AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { getRunToolResults } from '@beaver/agent-core/run-state/atoms';

/**
 * Whether the run is only waiting for PDF fetches to finish: every open tool
 * call is a `create_items` whose actions have all settled, and at least one
 * created item still has its fetch pending. Leaving the chat then only stops
 * the response; the fetches finish in Zotero either way.
 *
 * `liveAnswerCallIds` are the calls holding an answer the user gave a card:
 * an approved `create_items` holds one until it returns, which is fine once
 * its actions have settled; an answer to any other call is not.
 */
export function isRunWaitingOnlyOnPdfFetches(
    run: AgentRun,
    actions: AgentAction[],
    liveAnswerCallIds: Iterable<string> = [],
): boolean {
    if (run.status !== 'in_progress') return false;
    const results = getRunToolResults(run);
    const openCalls: ToolCallPart[] = [];
    for (const message of run.model_messages) {
        if (message.kind !== 'response') continue;
        for (const part of message.parts) {
            if (part.part_kind === 'tool-call' && !results.has(part.tool_call_id)) openCalls.push(part);
        }
    }
    if (openCalls.length === 0) return false;
    const openCallIds = new Set(openCalls.map((call) => call.tool_call_id));
    for (const id of liveAnswerCallIds) {
        if (!openCallIds.has(id)) return false;
    }

    let hasPendingFetch = false;
    for (const call of openCalls) {
        if (call.tool_name !== 'create_items') return false;
        const callActions = actions.filter(
            (action) => action.toolcall_id === call.tool_call_id && action.run_id === run.id,
        );
        if (callActions.length === 0 || callActions.some((action) => action.status === 'pending')) return false;
        hasPendingFetch ||= callActions.some((action) => action.status === 'applied'
            && isItemCreatingAgentAction(action)
            && action.result_data?.attachment_status === 'pending');
    }
    return hasPendingFetch;
}
