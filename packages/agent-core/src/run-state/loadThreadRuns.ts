import { agentRunService } from '../transport/agentService';
import type { AgentAction } from '../agents/agentActionTypes';
import type { AgentRun, ToolCallPart, ToolReturnPart } from '../agents/types';
import type { Citation } from '../types/citations';
import { logger } from '../platform/logger';

/**
 * Called once per `tool-return` part of the loaded thread, in run → message →
 * part order, each call awaited before the next part is visited.
 *
 * `toolCallArgs` are the args of the `tool-call` part that produced the return,
 * or `undefined` when no matching call is in the thread's messages. A client's
 * compat layer needs them: some legacy results can only be upgraded to a
 * renderable shape from the originating call's arguments.
 */
export type ToolReturnHandler = (
    part: ToolReturnPart,
    toolCallArgs: ToolCallPart['args'] | undefined
) => void | Promise<void>;

/** The client-neutral result of loading a thread's run history. */
export interface LoadedThreadRuns {
    /** The thread's runs, with stale `in_progress` runs marked `canceled`. */
    runs: AgentRun[];
    /** Every run's citations, each stamped with its `run_id`. */
    citations: Citation[];
    /**
     * The agent actions the REST call returned, untouched — clients that
     * reconcile, validate or render them do that themselves.
     */
    agentActions: AgentAction[] | null;
}

/**
 * Fetch a thread's history and turn it into render state every client needs:
 * the runs, their citations, and the returned agent actions.
 *
 * Client-specific hydration is the caller's job. It happens in two places: the
 * caller writes the returned data to its own store in whatever order it needs,
 * and `onToolReturn` lets it hydrate each tool return as the runs are walked.
 */
export async function loadThreadRuns(
    threadId: string,
    options?: { onToolReturn?: ToolReturnHandler }
): Promise<LoadedThreadRuns> {
    const { runs, agent_actions } = await agentRunService.getThreadRuns(threadId, true);

    // Mark any in_progress runs as canceled since they're no longer active
    const processedRuns = runs.map(run => {
        if (run.status === 'in_progress') {
            logger(`loadThreadRuns: Marking in_progress run ${run.id} as canceled`, 1);
            return {
                ...run,
                status: 'canceled' as const,
                completed_at: run.completed_at || new Date().toISOString(),
            };
        }
        return run;
    });

    // Extract citations from runs
    const citations = processedRuns.flatMap(run =>
        (run.metadata?.citations || []).map(citation => ({
            ...citation,
            run_id: run.id
        }))
    );

    const onToolReturn = options?.onToolReturn;
    if (onToolReturn) {
        // Build a tool_call_id → args map so the caller can derive variants that
        // are only recoverable from the originating call args (the annotation
        // list, for one).
        const toolCallArgsById = new Map<string, ToolCallPart['args']>();
        for (const run of processedRuns) {
            for (const message of run.model_messages) {
                if (message.kind === 'response') {
                    for (const part of message.parts) {
                        if (part.part_kind === 'tool-call' && part.tool_call_id) {
                            toolCallArgsById.set(part.tool_call_id, part.args);
                        }
                    }
                }
            }
        }

        // Sequential by design: a handler may load host data the next part's
        // handler reuses, so the parts are visited one at a time.
        for (const run of processedRuns) {
            for (const message of run.model_messages) {
                if (message.kind === 'request') {
                    for (const part of message.parts) {
                        if (part.part_kind === 'tool-return') {
                            await onToolReturn(part, toolCallArgsById.get(part.tool_call_id));
                        }
                    }
                }
            }
        }
    }

    return { runs: processedRuns, citations, agentActions: agent_actions };
}
