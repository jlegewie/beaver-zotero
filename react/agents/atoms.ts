import { atom } from "jotai";
import { AgentRun, ToolReturnPart } from "./types";

// All completed runs for the thread (loaded from DB or finished streaming)
export const threadRunsAtom = atom<AgentRun[]>([]);

// The currently streaming run (null when not streaming)
export const activeRunAtom = atom<AgentRun | null>(null);

// Combined view for rendering
export const allRunsAtom = atom((get) => {
    const completed = get(threadRunsAtom);
    const active = get(activeRunAtom);
    return active ? [...completed, active] : completed;
});


// Derived atom: quick lookup of tool results by tool_call_id
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

// Helper to get tool call status
export function getToolCallStatus(
    toolCallId: string, 
    resultsMap: Map<string, ToolReturnPart>
): 'in_progress' | 'completed' | 'error' {
    const result = resultsMap.get(toolCallId);
    if (!result) return 'in_progress';

    // Check if result indicates error (depends on your ToolReturnPart structure)
    if (typeof result.content === 'string' && result.content.startsWith('Error:')) {
        return 'error';
    }
    return 'completed';
}
