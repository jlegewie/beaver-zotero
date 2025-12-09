import { atom } from "jotai";
import {
    AgentRun,
    ModelMessage,
    ModelRequest,
    ToolReturnPart,
    ToolCallPart,
    TextPart,
    ThinkingPart,
} from "./types";
import {
    WSPartEvent,
    WSToolReturnEvent,
    WSRunCompleteEvent,
} from "../../src/services/agentService";

// =============================================================================
// Core Atoms
// =============================================================================

/** All completed runs for the thread (loaded from DB or finished streaming) */
export const threadRunsAtom = atom<AgentRun[]>([]);

/** The currently streaming run (null when not streaming) */
export const activeRunAtom = atom<AgentRun | null>(null);

// Note: currentThreadIdAtom is defined in threads.ts and re-exported here for convenience
// This ensures scroll position and other thread-related state stay in sync
export { currentThreadIdAtom } from "../atoms/threads";

// =============================================================================
// Derived Atoms
// =============================================================================

/** Combined view for rendering - use this in components */
export const allRunsAtom = atom((get) => {
    const completed = get(threadRunsAtom);
    const active = get(activeRunAtom);
    return active ? [...completed, active] : completed;
});

/** Is there an active streaming run? */
export const isStreamingAtom = atom((get) => get(activeRunAtom) !== null);

/** Quick lookup of tool results by tool_call_id */
export const toolResultsMapAtom = atom((get) => {
    const runs = get(allRunsAtom);
    const map = new Map<string, ToolReturnPart>();

    for (const run of runs) {
        for (const msg of run.model_messages) {
            if (msg.kind === 'request') {
                for (const part of msg.parts) {
                    if (part.part_kind === 'tool-return') {
                        map.set(part.tool_call_id, part);
                    }
                }
            }
        }
    }

    return map;
});

// =============================================================================
// Helper Functions
// =============================================================================

export type ToolCallStatus = 'in_progress' | 'completed' | 'error';

/** Get the status of a tool call based on its result */
export function getToolCallStatus(
    toolCallId: string,
    resultsMap: Map<string, ToolReturnPart>
): ToolCallStatus {
    const result = resultsMap.get(toolCallId);
    if (!result) return 'in_progress';

    // Check if result indicates error
    if (typeof result.content === 'string' && result.content.toLowerCase().includes('error')) {
        return 'error';
    }
    if (typeof result.content === 'object' && result.content?.error) {
        return 'error';
    }

    return 'completed';
}

/** Extract display label from tool call args (if present) */
export function getToolCallLabel(part: ToolCallPart): string {
    if (typeof part.args === 'object' && part.args?.label) {
        return part.args.label;
    }
    if (typeof part.args === 'object' && part.args?.status) {
        return part.args.status;
    }
    return part.tool_name;
}

// =============================================================================
// Run Update Helpers
// =============================================================================

/**
 * Ensure model_messages array has a ModelResponse at the given index.
 * Creates empty ModelResponse objects for any missing indices.
 */
function ensureModelResponse(messages: ModelMessage[], messageIndex: number, runId: string): ModelMessage[] {
    const result = [...messages];

    // Fill in any missing indices with empty ModelResponse
    while (result.length <= messageIndex) {
        result.push({
            kind: 'response',
            run_id: runId,
            parts: [],
        });
    }

    return result;
}

/**
 * Ensure model_messages array has a ModelRequest at the given index.
 * Creates empty ModelRequest objects for any missing indices.
 */
function ensureModelRequest(messages: ModelMessage[], messageIndex: number, runId: string): ModelMessage[] {
    const result = [...messages];

    // Fill in any missing indices
    while (result.length <= messageIndex) {
        result.push({
            kind: 'request',
            run_id: runId,
            parts: [],
            instructions: '',
        });
    }

    // Ensure the target index is a ModelRequest
    if (result[messageIndex].kind !== 'request') {
        result[messageIndex] = {
            kind: 'request',
            run_id: runId,
            parts: [],
            instructions: '',
        };
    }

    return result;
}

/**
 * Update an AgentRun with a part event.
 * Parts are accumulated content (not deltas), so we replace the part at the given index.
 */
export function updateRunWithPart(run: AgentRun, event: WSPartEvent): AgentRun {
    // Ensure we have a ModelResponse at message_index
    const messages = ensureModelResponse(run.model_messages, event.message_index, event.run_id);

    // Get the message and ensure it's a ModelResponse
    const message = messages[event.message_index];
    if (message.kind !== 'response') {
        // This shouldn't happen for part events, but handle gracefully
        console.warn('Part event received for non-response message');
        return run;
    }

    // Update the part at part_index
    const parts = [...message.parts];
    parts[event.part_index] = event.part as TextPart | ThinkingPart | ToolCallPart;

    // Update the message
    messages[event.message_index] = {
        ...message,
        parts,
    };

    return {
        ...run,
        model_messages: messages,
    };
}

/**
 * Update an AgentRun with a tool return event.
 * Tool returns go into a ModelRequest message.
 */
export function updateRunWithToolReturn(run: AgentRun, event: WSToolReturnEvent): AgentRun {
    // Ensure we have a ModelRequest at message_index
    const messages = ensureModelRequest(run.model_messages, event.message_index, event.run_id);

    // Get the message (should be a ModelRequest now)
    const message = messages[event.message_index] as ModelRequest;

    // Add the tool return part
    // Multiple tool returns can go into the same message (parallel tool calls)
    const parts = [...message.parts, event.part];

    messages[event.message_index] = {
        ...message,
        parts,
    };

    return {
        ...run,
        model_messages: messages,
    };
}

/**
 * Update an AgentRun when the run completes.
 */
export function updateRunComplete(run: AgentRun, event: WSRunCompleteEvent): AgentRun {
    return {
        ...run,
        status: 'completed',
        total_usage: event.usage ?? undefined,
        total_cost: event.cost ?? undefined,
        completed_at: new Date().toISOString(),
    };
}
